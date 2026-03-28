const router = require('express').Router();
const db = require('../../../config/db');
const { auth } = require('../middleware/auth');
const { getSetting } = require('./quota');

function formatPemKey(key, type) {
  const clean = key.replace(/-----.*?-----/g, '').replace(/\s/g, '');
  const header = type === 'private' ? '-----BEGIN PRIVATE KEY-----' : '-----BEGIN PUBLIC KEY-----';
  const footer = type === 'private' ? '-----END PRIVATE KEY-----' : '-----END PUBLIC KEY-----';
  const body = clean.match(/.{1,64}/g).join('\n');
  return `${header}\n${body}\n${footer}`;
}

function makeTradeNo(userId) {
  return `${Date.now()}${userId}${Math.floor(Math.random() * 10000)}`;
}

function isMobile(req) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  return /mobile|android|iphone|ipad|ipod|windows phone/i.test(ua);
}

async function getAlipaySdk() {
  const appId = await getSetting('alipay_app_id');
  const privateKey = await getSetting('alipay_private_key');
  const alipayPublicKey = await getSetting('alipay_public_key');
  if (!appId || !privateKey || !alipayPublicKey) return null;
  const { AlipaySdk } = require('alipay-sdk');
  return new AlipaySdk({
    appId,
    privateKey: formatPemKey(privateKey, 'private'),
    alipayPublicKey: formatPemKey(alipayPublicKey, 'public'),
    keyType: 'PKCS8',
    gateway: 'https://openapi.alipay.com/gateway.do',
  });
}

// GET /api/pay/options — VIP套餐列表
router.get('/options', async (req, res) => {
  const vipOptionsStr = await getSetting('vip_recharge_options');
  const vipCostPerDay = await getSetting('vip_cost_per_day');
  res.json({
    vip_options: JSON.parse(vipOptionsStr || '[]'),
    vip_cost_per_day: parseInt(vipCostPerDay) || 1,
  });
});

// POST /api/pay/create-vip — 支付宝购买VIP
router.post('/create-vip', auth, async (req, res) => {
  const { days } = req.body;
  if (!days || days < 1) return res.status(400).json({ message: '请选择VIP天数' });

  const vipOptionsStr = await getSetting('vip_recharge_options');
  const vipOptions = JSON.parse(vipOptionsStr || '[]');
  const opt = vipOptions.find(o => String(o.days) === String(days));
  if (!opt || !opt.alipay_price) return res.status(400).json({ message: '该套餐不支持支付宝购买' });

  const alipaySdk = await getAlipaySdk();
  if (!alipaySdk) return res.status(500).json({ message: '支付宝配置未完成，请联系管理员' });

  const outTradeNo = makeTradeNo(req.user.id);
  await db.query(
    'INSERT INTO recharge_orders (out_trade_no, user_id, amount, quota, order_type, vip_days) VALUES (?, ?, ?, ?, "vip", ?)',
    [outTradeNo, req.user.id, opt.alipay_price, opt.bonus_quota || 0, days]
  );

  const notifyUrl = await getSetting('alipay_notify_url') || '';
  const returnUrl = 'https://planet.opensora2.cn/vip';
  const mobile = isMobile(req);
  const bizParams = {
    method: 'GET',
    bizContent: {
      outTradeNo,
      productCode: mobile ? 'QUICK_WAP_WAY' : 'FAST_INSTANT_TRADE_PAY',
      totalAmount: String(opt.alipay_price),
      subject: `AI星球VIP ${days}天`,
    },
  };
  if (notifyUrl) bizParams.notifyUrl = notifyUrl;
  bizParams.returnUrl = returnUrl;

  const apiMethod = mobile ? 'alipay.trade.wap.pay' : 'alipay.trade.page.pay';
  const rawResult = await alipaySdk.pageExecute(apiMethod, bizParams);

  if (mobile) {
    return res.json({ mobile: true, tradeNo: outTradeNo });
  }

  let payUrl = rawResult;
  if (typeof rawResult === 'string' && rawResult.includes('<form')) {
    const match = rawResult.match(/action="([^"]+)"/);
    if (match) payUrl = match[1].replace(/&amp;/g, '&');
  }
  res.json({ payUrl, mobile: false });
});

// GET /api/pay/h5/:tradeNo — 手机端跳转支付宝
router.get('/h5/:tradeNo', async (req, res) => {
  const { tradeNo } = req.params;
  const [[order]] = await db.query('SELECT * FROM recharge_orders WHERE out_trade_no = ?', [tradeNo]);
  if (!order) return res.status(404).send('订单不存在');

  const alipaySdk = await getAlipaySdk();
  if (!alipaySdk) return res.status(500).send('支付宝配置未完成');

  const notifyUrl = await getSetting('alipay_notify_url') || '';
  const returnUrl = 'https://planet.opensora2.cn/vip';
  const bizParams = {
    method: 'GET',
    bizContent: {
      outTradeNo: order.out_trade_no,
      productCode: 'QUICK_WAP_WAY',
      totalAmount: String(order.amount),
      subject: `AI星球VIP ${order.vip_days}天`,
    },
  };
  if (notifyUrl) bizParams.notifyUrl = notifyUrl;
  bizParams.returnUrl = returnUrl;

  const rawResult = await alipaySdk.pageExecute('alipay.trade.wap.pay', bizParams);
  let html = rawResult;
  if (typeof rawResult === 'string' && !rawResult.includes('<form')) {
    html = `<!DOCTYPE html><html><body><script>location.href="${rawResult}"<\/script></body></html>`;
  } else {
    html = `<!DOCTYPE html><html><body>${rawResult}<script>document.forms[0].submit()<\/script></body></html>`;
  }
  res.send(html);
});

// GET /api/pay/orders — 当前用户VIP订单记录
router.get('/orders', auth, async (req, res) => {
  const [rows] = await db.query(
    'SELECT out_trade_no, amount, quota, order_type, vip_days, status, created_at, paid_at FROM recharge_orders WHERE user_id = ? AND order_type IN ("vip","vip_quota","vip_balance") ORDER BY created_at DESC LIMIT 20',
    [req.user.id]
  );
  res.json(rows);
});

// POST /api/pay/verify — 手动查询支付宝订单状态并激活VIP
router.post('/verify', auth, async (req, res) => {
  const { tradeNo } = req.body;
  if (!tradeNo) return res.status(400).json({ message: '缺少订单号' });

  const [[order]] = await db.query('SELECT * FROM recharge_orders WHERE out_trade_no = ? AND user_id = ?', [tradeNo, req.user.id]);
  if (!order) return res.status(404).json({ message: '订单不存在' });
  if (order.status === 'paid') return res.json({ success: true, message: 'VIP已激活', already: true });

  const alipaySdk = await getAlipaySdk();
  if (!alipaySdk) return res.status(500).json({ message: '支付宝配置未完成' });

  try {
    const result = await alipaySdk.exec('alipay.trade.query', {
      bizContent: { outTradeNo: tradeNo },
    });
    const tradeStatus = result.tradeStatus || result.trade_status;
    if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
      await db.query('UPDATE recharge_orders SET status = "paid", paid_at = NOW() WHERE out_trade_no = ?', [tradeNo]);
      if (order.order_type === 'vip' && order.vip_days > 0) {
        const now = new Date();
        const [[q]] = await db.query('SELECT vip_expires_at FROM user_quota WHERE user_id = ?', [order.user_id]);
        const base = q?.vip_expires_at && new Date(q.vip_expires_at) > now ? new Date(q.vip_expires_at) : now;
        const newExpiry = new Date(base.getTime() + order.vip_days * 86400000);
        await db.query('INSERT INTO user_quota (user_id, vip_expires_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE vip_expires_at = ?', [order.user_id, newExpiry, newExpiry]);
      }
      if (order.quota > 0) {
        await db.query(
          'INSERT INTO user_quota (user_id, extra_quota) VALUES (?, ?) ON DUPLICATE KEY UPDATE extra_quota = extra_quota + ?',
          [order.user_id, order.quota, order.quota]
        );
      }
      return res.json({ success: true, message: 'VIP已激活' + (order.quota > 0 ? `，已赠送 ${order.quota} 积分` : '') });
    }
    return res.json({ success: false, message: `支付状态：${tradeStatus || '未知'}，请确认支付宝付款成功` });
  } catch (e) {
    return res.status(500).json({ message: '查询失败：' + e.message });
  }
});

module.exports = router;
