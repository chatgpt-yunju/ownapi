const router = require('express').Router();
const db = require('../config/db');
const { auth, requireAdmin } = require('../middleware/auth');
const { ensureQuota, addQuotaLog, getSetting, getSettingCached } = require('./quota');
const { sendPaymentBackup } = require('../scheduler');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const arkRateLimiter = require('../utils/arkRateLimiter');
const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY;
const DOUBAO_TEXT_MODEL = 'deepseek-v3-2-251201';
const DOUBAO_IMAGE_MODEL = 'doubao-seedream-5-0-260128';
const UPLOAD_DIR = path.join(__dirname, '../../uploads');

// 迁移：添加 image_path 字段
db.query('ALTER TABLE shop_items ADD COLUMN image_path VARCHAR(500) DEFAULT NULL').catch(() => {});

// 建表/迁移
db.query(`CREATE TABLE IF NOT EXISTS shop_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  description VARCHAR(256),
  category ENUM('physical','virtual') NOT NULL DEFAULT 'virtual',
  type ENUM('quota','vip_days','lock_times','goods') NOT NULL DEFAULT 'goods',
  value INT NOT NULL DEFAULT 1,
  quota_price INT DEFAULT NULL,
  alipay_price DECIMAL(10,2) DEFAULT NULL,
  is_active TINYINT(1) DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS shop_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  out_trade_no VARCHAR(64) UNIQUE,
  item_id INT NOT NULL,
  user_id INT DEFAULT NULL,
  pay_type ENUM('quota','alipay') NOT NULL,
  amount DECIMAL(10,2) DEFAULT NULL,
  quota_paid INT DEFAULT NULL,
  email VARCHAR(200) DEFAULT NULL,
  shipping_name VARCHAR(100) DEFAULT NULL,
  shipping_phone VARCHAR(20) DEFAULT NULL,
  shipping_address TEXT DEFAULT NULL,
  status ENUM('pending','paid','shipped','done') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

async function getTransporter() {
  const host = await getSetting('smtp_host') || 'smtp.qq.com';
  const port = parseInt(await getSetting('smtp_port')) || 465;
  const user = await getSetting('smtp_user');
  const pass = await getSetting('smtp_pass');
  if (!user || !pass) return null;
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
}

async function sendVirtualGoodsMail(email, item) {
  try {
    const transporter = await getTransporter();
    if (!transporter) return;
    const from = await getSetting('smtp_user');
    const html = `
      <h2>🎉 购买成功！</h2>
      <p>您购买的商品：<strong>${item.name}</strong></p>
      <p>${item.description || ''}</p>
      <p style="color:#999;font-size:12px;margin-top:16px">如有问题请联系客服</p>
    `;
    await transporter.sendMail({ from, to: email, subject: `购买成功：${item.name}`, html });
  } catch (e) {
    console.error('[商城] 发送邮件失败:', e.message);
  }
}

function formatPemKey(key, type) {
  const clean = key.replace(/-----.*?-----/g, '').replace(/\s/g, '');
  const header = type === 'private' ? '-----BEGIN PRIVATE KEY-----' : '-----BEGIN PUBLIC KEY-----';
  const footer = type === 'private' ? '-----END PRIVATE KEY-----' : '-----END PUBLIC KEY-----';
  const body = clean.match(/.{1,64}/g).join('\n');
  return `${header}\n${body}\n${footer}`;
}

function makeTradeNo(suffix) {
  return `SHOP${Date.now()}${suffix}${Math.floor(Math.random() * 10000)}`;
}

// GET /api/shop/items — 公开
router.get('/items', async (req, res) => {
  const showAll = req.query.all === '1';
  const [rows] = await db.query(
    showAll ? 'SELECT * FROM shop_items ORDER BY category, alipay_price ASC' : 'SELECT * FROM shop_items WHERE is_active = 1 ORDER BY category, alipay_price ASC'
  );
  res.json(rows);
});

// POST /api/shop/buy-quota — 积分购买虚拟商品（需登录）
router.post('/buy-quota', auth, async (req, res) => {
  const { itemId, email } = req.body;
  if (!email?.trim()) return res.status(400).json({ message: '请填写接收邮箱' });

  const [[item]] = await db.query('SELECT * FROM shop_items WHERE id = ? AND is_active = 1 AND category = "virtual"', [itemId]);
  if (!item) return res.status(404).json({ message: '商品不存在或���支持积分购买' });
  if (!item.quota_price) return res.status(400).json({ message: '该商品不支持积分购买' });

  const quota = await ensureQuota(req.user.id);
  if (quota.extra_quota < item.quota_price) {
    return res.status(400).json({ message: `积分不足，需要 ${item.quota_price} 积分，当前 ${quota.extra_quota} 积分` });
  }

  await db.query('UPDATE user_quota SET extra_quota = extra_quota - ? WHERE user_id = ?', [item.quota_price, req.user.id]);
  await addQuotaLog(req.user.id, -item.quota_price, `商城购买：${item.name}`);

  // 发放虚拟商品效果（仅自动发货）
  if (item.delivery_type !== 'manual') {
    if (item.type === 'vip_days') {
      const now = new Date();
      const [[q]] = await db.query('SELECT vip_expires_at FROM user_quota WHERE user_id = ?', [req.user.id]);
      const base = q?.vip_expires_at && new Date(q.vip_expires_at) > now ? new Date(q.vip_expires_at) : now;
      const newExpiry = new Date(base.getTime() + item.value * 86400000);
      await db.query('UPDATE user_quota SET vip_expires_at = ? WHERE user_id = ?', [newExpiry, req.user.id]);
    } else if (item.type === 'quota') {
      await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [item.value, req.user.id]);
      await addQuotaLog(req.user.id, item.value, `商城兑换积分：${item.name}`);
    }
  }

  await db.query(
    'INSERT INTO shop_orders (item_id, user_id, pay_type, quota_paid, email, status) VALUES (?, ?, "quota", ?, ?, ?)',
    [item.id, req.user.id, item.quota_price, email.trim(), item.delivery_type === 'manual' ? 'paid' : 'paid']
  );

  if (item.delivery_type !== 'manual') {
    await sendVirtualGoodsMail(email.trim(), item);
    res.json({ message: `购买成功！商品信息已发送至 ${email.trim()}` });
  } else {
    res.json({ message: '购买成功！管理员将在24小时内手动发货，请留意邮件通知' });
  }
});

// POST /api/shop/buy-alipay — 支付宝购买（游客可用）
router.post('/buy-alipay', async (req, res) => {
  const { itemId, email, shippingName, shippingPhone, shippingAddress } = req.body;

  const [[item]] = await db.query('SELECT * FROM shop_items WHERE id = ? AND is_active = 1', [itemId]);
  if (!item) return res.status(404).json({ message: '商品不存在' });
  if (!item.alipay_price) return res.status(400).json({ message: '该商品不支持支付宝购买' });

  if (item.category === 'virtual' && !email?.trim()) return res.status(400).json({ message: '请填写接收邮箱' });
  if (item.category === 'physical' && (!shippingName?.trim() || !shippingPhone?.trim() || !shippingAddress?.trim())) {
    return res.status(400).json({ message: '请填写完整收货信息' });
  }

  const appId = await getSetting('alipay_app_id');
  const privateKey = await getSetting('alipay_private_key');
  const alipayPublicKey = await getSetting('alipay_public_key');
  if (!appId || !privateKey || !alipayPublicKey) {
    return res.status(500).json({ message: '支付宝配置未完成，请联系管理员' });
  }

  const { AlipaySdk, AlipayFormData } = require('alipay-sdk');
  const alipaySdk = new AlipaySdk({
    appId,
    privateKey: formatPemKey(privateKey, 'private'),
    alipayPublicKey: formatPemKey(alipayPublicKey, 'public'),
    keyType: 'PKCS8',
    gateway: 'https://openapi.alipay.com/gateway.do',
  });

  // 获取登录用户ID（可选）
  let userId = null;
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userId = decoded.id;
    }
  } catch {}

  const outTradeNo = makeTradeNo(userId || 'guest');
  await db.query(
    'INSERT INTO shop_orders (out_trade_no, item_id, user_id, pay_type, amount, email, shipping_name, shipping_phone, shipping_address, status) VALUES (?, ?, ?, "alipay", ?, ?, ?, ?, ?, "pending")',
    [outTradeNo, item.id, userId, item.alipay_price, email?.trim() || null, shippingName?.trim() || null, shippingPhone?.trim() || null, shippingAddress?.trim() || null]
  );

  const notifyUrl = await getSetting('shop_notify_url') || await getSetting('alipay_notify_url') || '';
  const returnUrl = await getSetting('shop_return_url') || await getSetting('alipay_return_url') || '';

  const bizParams = {
    method: 'GET',
    bizContent: {
      outTradeNo,
      productCode: 'FAST_INSTANT_TRADE_PAY',
      totalAmount: String(item.alipay_price),
      subject: item.name,
    },
  };
  if (notifyUrl) bizParams.notifyUrl = notifyUrl;
  if (returnUrl) bizParams.returnUrl = returnUrl;

  const rawResult = await alipaySdk.pageExecute('alipay.trade.page.pay', bizParams);
  res.json({ payUrl: rawResult });
});

// POST /api/shop/notify — 支付宝异步回调
router.post('/notify', async (req, res) => {
  try {
    const appId = await getSetting('alipay_app_id');
    const privateKey = await getSetting('alipay_private_key');
    const alipayPublicKey = await getSetting('alipay_public_key');
    const { AlipaySdk } = require('alipay-sdk');
    const alipaySdk = new AlipaySdk({
      appId,
      privateKey: formatPemKey(privateKey, 'private'),
      alipayPublicKey: formatPemKey(alipayPublicKey, 'public'),
      keyType: 'PKCS8',
    });

    const ok = alipaySdk.checkNotifySign(req.body);
    if (!ok) return res.send('fail');

    const { out_trade_no, trade_status } = req.body;
    if (trade_status === 'TRADE_SUCCESS' || trade_status === 'TRADE_FINISHED') {
      const [[order]] = await db.query('SELECT * FROM shop_orders WHERE out_trade_no = ?', [out_trade_no]);
      if (order && order.status === 'pending') {
        await db.query('UPDATE shop_orders SET status = "paid" WHERE out_trade_no = ?', [out_trade_no]);

        const [[item]] = await db.query('SELECT * FROM shop_items WHERE id = ?', [order.item_id]);
        if (!item) return res.send('success');

        sendPaymentBackup({ source: 'shop', tradeNo: out_trade_no, amount: order.amount, userId: order.user_id }).catch(e => console.error('[PayBackup] 触发失败:', e.message));

        if (item.category === 'virtual' && item.delivery_type !== 'manual') {
          // 自动发放虚拟商品效果
          if (order.user_id) {
            if (item.type === 'vip_days') {
              const now = new Date();
              const [[q]] = await db.query('SELECT vip_expires_at FROM user_quota WHERE user_id = ?', [order.user_id]);
              const base = q?.vip_expires_at && new Date(q.vip_expires_at) > now ? new Date(q.vip_expires_at) : now;
              const newExpiry = new Date(base.getTime() + item.value * 86400000);
              await db.query('INSERT INTO user_quota (user_id, vip_expires_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE vip_expires_at = ?', [order.user_id, newExpiry, newExpiry]);
            } else if (item.type === 'quota') {
              await db.query('INSERT INTO user_quota (user_id, extra_quota) VALUES (?, ?) ON DUPLICATE KEY UPDATE extra_quota = extra_quota + ?', [order.user_id, item.value, item.value]);
              await addQuotaLog(order.user_id, item.value, `商城支付宝购买：${item.name}`);
            }
          }
          if (order.email) await sendVirtualGoodsMail(order.email, item);
        }
        // 手动发货或实物商品：等管理员处理
      }
    }
    res.send('success');
  } catch (e) {
    console.error('Shop notify error:', e);
    res.send('fail');
  }
});

// GET /api/shop/orders — 用户自己的订单
router.get('/orders', auth, async (req, res) => {
  const [rows] = await db.query(
    `SELECT o.*, i.name item_name, i.category item_category FROM shop_orders o
     LEFT JOIN shop_items i ON i.id = o.item_id
     WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json(rows);
});

// GET /api/shop/orders/all — 管理员查看所有订单
router.get('/orders/all', auth, requireAdmin, async (req, res) => {
  const status = req.query.status;
  const [rows] = await db.query(
    `SELECT o.*, i.name item_name, i.category item_category, i.delivery_type item_delivery_type FROM shop_orders o
     LEFT JOIN shop_items i ON i.id = o.item_id
     ${status ? 'WHERE o.status = ?' : ''}
     ORDER BY o.created_at DESC LIMIT 200`,
    status ? [status] : []
  );
  res.json(rows);
});

// PATCH /api/shop/orders/:id/ship — 管理员标记发货
router.patch('/orders/:id/ship', auth, requireAdmin, async (req, res) => {
  await db.query('UPDATE shop_orders SET status = "shipped" WHERE id = ?', [req.params.id]);
  res.json({ message: '已标记发货' });
});

// POST /api/shop/items — 管理员新增商品
router.post('/items', auth, requireAdmin, async (req, res) => {
  const { name, description, category, type, value, quota_price, alipay_price, delivery_type } = req.body;
  if (!name || !category) return res.status(400).json({ message: '参数不完整' });
  const [result] = await db.query(
    'INSERT INTO shop_items (name, description, category, type, value, quota_price, alipay_price, delivery_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [name, description || null, category, type || 'goods', value || 1, quota_price || null, alipay_price || null, delivery_type || 'auto']
  );
  res.status(201).json({ id: result.insertId, message: '创建成功' });
});

// PUT /api/shop/items/:id — 管理员编辑商品
router.put('/items/:id', auth, requireAdmin, async (req, res) => {
  const { name, description, category, type, value, quota_price, alipay_price, is_active, image_path, delivery_type } = req.body;
  await db.query(
    'UPDATE shop_items SET name=?, description=?, category=?, type=?, value=?, quota_price=?, alipay_price=?, is_active=?, image_path=?, delivery_type=? WHERE id=?',
    [name, description || null, category, type || 'goods', value || 1, quota_price || null, alipay_price || null, is_active ? 1 : 0, image_path || null, delivery_type || 'auto', req.params.id]
  );
  res.json({ message: '更新成功' });
});

// POST /api/shop/items — 管理员新增商品（更新以支持 image_path）
// (already defined above, patched via PUT)

// POST /api/shop/ai-desc — AI生成商品介绍（管理员）
router.post('/ai-desc', auth, requireAdmin, async (req, res) => {
  const { name, category } = req.body;
  if (!name) return res.status(400).json({ message: '请提供商品名称' });
  try {
    const catLabel = category === 'physical' ? '实物商品' : '虚拟商品';
    const prompt = `你是一名电商文案专家。请为以下商品写一段简洁吸引人的商品介绍（50字以内，突出卖点，适合积分商城展示）：\n商品名称：${name}\n商品类型：${catLabel}\n只输出介绍文字，不要加任何前缀或解释。`;
    const { callAI: shopCallAI } = require('../utils/aiGateway');
    const desc = await shopCallAI(prompt, { tier: 'simple' });
    res.json({ description: desc.trim() });
  } catch (e) {
    res.status(500).json({ message: e.message || 'AI生成失败' });
  }
});

// POST /api/shop/ai-image — AI生成商品封面图（管理员，保存到uploads）
router.post('/ai-image', auth, requireAdmin, async (req, res) => {
  const { name, description, category } = req.body;
  if (!name) return res.status(400).json({ message: '请提供商品名称' });
  try {
    const catLabel = category === 'physical' ? '实物商品' : '虚拟数字商品';
    const prompt = `电商商品封面图，商品名称：${name}，${description || catLabel}，简洁大气，白色背景，产品主图风格，高清`;
    const { callImage: shopCallImage } = require('yunjunet-common/backend-core/ai/doubao');
    const imageUrl = await shopCallImage(prompt, 0, req.user.id, 'AI商品封面');
    if (!imageUrl) throw new Error('未获取到图片');

    // 下载图片并保存到 uploads/shop/
    const shopDir = path.join(UPLOAD_DIR, 'shop');
    if (!fs.existsSync(shopDir)) fs.mkdirSync(shopDir, { recursive: true });
    const imgRes = await fetch(imageUrl);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const filename = `shop_${Date.now()}.jpg`;
    fs.writeFileSync(path.join(shopDir, filename), buffer);
    res.json({ image_path: `shop/${filename}` });
  } catch (e) {
    res.status(500).json({ message: e.message || 'AI图片生成失败' });
  }
});

module.exports = router;
