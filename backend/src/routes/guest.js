const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const db = require('../config/db');
const { getSettingCached } = require('./quota');
const { isAllowedEmailDomain, maskEmail } = require('./emailCode');
const { generateApiKey, hashApiKey, maskApiKey } = require('../plugins/ai-gateway/utils/crypto');
const { getRechargePricing } = require('../plugins/ai-gateway/utils/rechargePricing');
const { makeTradeNo } = require('../plugins/ai-gateway/utils/alipay');

// 公共页需要的订单/发货字段，运行时补齐即可
(async () => {
  const alters = [
    'ALTER TABLE recharge_orders ADD COLUMN guest_email VARCHAR(200) DEFAULT NULL',
    'ALTER TABLE recharge_orders ADD COLUMN guest_user_id INT DEFAULT NULL',
    'ALTER TABLE recharge_orders ADD COLUMN guest_key_id INT DEFAULT NULL',
    'ALTER TABLE recharge_orders ADD COLUMN delivery_status ENUM("pending","shipped","failed") DEFAULT "pending"',
    'ALTER TABLE recharge_orders ADD COLUMN delivery_message TEXT DEFAULT NULL',
    'ALTER TABLE recharge_orders ADD COLUMN delivery_sent_at TIMESTAMP NULL DEFAULT NULL',
    'ALTER TABLE recharge_orders ADD COLUMN paid_at TIMESTAMP NULL DEFAULT NULL',
    'ALTER TABLE recharge_orders ADD COLUMN bonus_quota DECIMAL(12,4) DEFAULT 0',
    'ALTER TABLE recharge_orders ADD COLUMN actual_paid DECIMAL(12,2) DEFAULT 0',
  ];
  for (const sql of alters) {
    try { await db.query(sql); } catch {}
  }
})();

let smtpTransporter = null;
async function getMailer() {
  if (smtpTransporter) return smtpTransporter;
  const host = await getSettingCached('smtp_host', '');
  const port = parseInt(await getSettingCached('smtp_port', '465'), 10);
  const user = await getSettingCached('smtp_user', '');
  const pass = await getSettingCached('smtp_pass', '');
  if (!host || !user || !pass) return null;
  smtpTransporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  return smtpTransporter;
}

function escapeHtml(input = '') {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripUntrustedSenderMetadata(input = '') {
  const value = String(input || '');
  return value
    .replace(/\n?Sender \(untrusted metadata\):\s*\n```json[\s\S]*?\n```\s*/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function genRandomPassword() {
  return `${crypto.randomBytes(10).toString('hex')}Aa1!`;
}

function genGuestUsername(email = '') {
  const local = String(email).split('@')[0].replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'guest';
  return `${local || 'guest'}_${crypto.randomBytes(3).toString('hex')}`;
}

function normalizeApiKey(input = '') {
  return String(input)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .replace(/^Bearer\s+/i, '');
}

function isValidApiKeyFormat(key = '') {
  return /^sk-[a-f0-9]{48}$/i.test(key);
}

function isMobileRequest(req) {
  const ua = String(req.headers['user-agent'] || '');
  return /mobile|android|iphone|ipad|ipod|windows phone/i.test(ua);
}

async function ensureGuestAccount(email) {
  const [[existing]] = await db.query('SELECT id, username, email FROM users WHERE email = ? LIMIT 1', [email]);
  if (existing) return existing;

  const usernameBase = genGuestUsername(email);
  const password = await bcrypt.hash(genRandomPassword(), 10);
  const [result] = await db.query(
    'INSERT INTO users (username, password, role, email, nickname) VALUES (?, ?, "user", ?, ?)',
    [usernameBase, password, email, `${usernameBase}`]
  );
  return { id: result.insertId, username: usernameBase, email };
}

async function sendGuestDeliveryMail({ email, orderNo, quotaAmount, bonusAmount, apiKey, apiKeyDisplay }) {
  const mailer = await getMailer();
  if (!mailer) return false;
  const smtpUser = await getSettingCached('smtp_user', '');
  const docsUrl = `${process.env.PUBLIC_SITE_URL || 'https://api.yunjunet.cn'}/docs.html`;
  const guestUrl = `${process.env.PUBLIC_SITE_URL || 'https://api.yunjunet.cn'}/guest.html`;
  await mailer.sendMail({
    from: `"云聚平台" <${smtpUser}>`,
    to: email,
    subject: '【云聚】API Key 已发货',
    html: `
      <div style="max-width:560px;margin:0 auto;padding:24px;font-family:Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2937">
        <h2 style="margin:0 0 12px;color:#111827">您的 API Key 已自动发货</h2>
        <p style="margin:0 0 8px;">订单号：<strong>${escapeHtml(orderNo)}</strong></p>
        <p style="margin:0 0 8px;">到账额度：<strong>$${Number(quotaAmount || 0).toFixed(2)}</strong>（加赠 $${Number(bonusAmount || 0).toFixed(2)}）</p>
        <p style="margin:0 0 8px;">API Key：<code style="padding:2px 6px;background:#f3f4f6;border-radius:6px;">${escapeHtml(apiKey || '')}</code></p>
        <p style="margin:0 0 16px;">脱敏展示：<code>${escapeHtml(apiKeyDisplay || '')}</code></p>
        <p style="margin:0 0 16px;">复制后即可直接使用，使用文档：<a href="${docsUrl}">${escapeHtml(docsUrl)}</a></p>
        <p style="margin:0 0 16px;">游客查询页：<a href="${guestUrl}">${escapeHtml(guestUrl)}</a></p>
        <p style="margin:0;color:#6b7280;font-size:12px;">如未收到邮件，请检查垃圾箱或返回页面查询订单状态。</p>
      </div>`,
  });
  return true;
}

async function createGuestKeyOrder({ email, payAmount }) {
  if (!email) throw new Error('请填写邮箱');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('邮箱格式不正确');
  if (!isAllowedEmailDomain(email)) throw new Error('仅支持国内主流邮箱（QQ、163、126、新浪、搜狐等）');

  const payValue = Number(payAmount);
  if (!Number.isFinite(payValue) || payValue < 1) throw new Error('请输入有效的购买金额');

  const { creditAmount, bonusAmount, tier } = getRechargePricing(payValue);
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const user = await ensureGuestAccount(email);
    const outTradeNo = makeTradeNo(user.id);
    await conn.query(
      `INSERT INTO recharge_orders
        (out_trade_no, user_id, amount, quota, bonus_quota, actual_paid, order_type, status, guest_email, guest_user_id, delivery_status)
       VALUES (?, ?, ?, 0, ?, ?, 'guest_key', 'pending', ?, ?, 'pending')`,
      [outTradeNo, user.id, creditAmount, bonusAmount, payValue, email, user.id]
    );
    await conn.commit();
    return {
      orderNo: outTradeNo,
      user,
      creditAmount,
      bonusAmount,
      tier,
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

function getPublicSiteUrl(req) {
  const fallback = `${req.protocol}://${req.get('host')}`;
  const raw = process.env.PUBLIC_SITE_URL || fallback;
  try {
    const parsed = new URL(raw);
    return parsed.origin;
  } catch {
    try {
      return new URL(fallback).origin;
    } catch {
      return fallback;
    }
  }
}

async function getGuestKeyDetailsByHash(keyHash) {
  const [[row]] = await db.query(
    `SELECT k.id, k.key_display, k.name, k.status, k.created_at, k.last_used_at, k.user_id,
            u.email, u.username,
            COALESCE(q.balance, 0) AS quota_balance,
            COALESCE(ro_stats.guest_paid_quota, 0) AS guest_paid_quota,
            ro_stats.last_paid_at
     FROM openclaw_api_keys k
     JOIN users u ON u.id = k.user_id
     LEFT JOIN openclaw_quota q ON q.user_id = k.user_id
     LEFT JOIN (
       SELECT guest_key_id,
              SUM(amount) AS guest_paid_quota,
              MAX(paid_at) AS last_paid_at
       FROM recharge_orders
       WHERE order_type = 'guest_key' AND status = 'paid'
       GROUP BY guest_key_id
     ) ro_stats ON ro_stats.guest_key_id = k.id
     WHERE k.key_hash = ? AND k.is_deleted = 0
     LIMIT 1`,
    [keyHash]
  );
  return row || null;
}

async function getGuestKeyLogsByHash({ keyHash, page = 1, limit = 10 }) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM openclaw_call_logs l
     JOIN openclaw_api_keys k ON k.id = l.api_key_id
     WHERE k.key_hash = ? AND k.is_deleted = 0`,
    [keyHash]
  );

  const [logs] = await db.query(
    `SELECT l.id, l.request_id, l.model, l.prompt_tokens, l.completion_tokens, l.total_cost,
            l.status, l.error_message, l.ip,
            DATE_FORMAT(DATE_ADD(l.created_at, INTERVAL 8 HOUR), '%Y-%m-%d %H:%i:%s') as created_at,
            LEFT(r.user_prompt, 180) as user_prompt_preview,
            (r.request_id IS NOT NULL) as has_detail
     FROM openclaw_call_logs l
     JOIN openclaw_api_keys k ON k.id = l.api_key_id
     LEFT JOIN openclaw_request_logs r ON r.request_id = l.request_id
     WHERE k.key_hash = ? AND k.is_deleted = 0
     ORDER BY l.created_at DESC
     LIMIT ? OFFSET ?`,
    [keyHash, safeLimit, offset]
  );

  const sanitizedLogs = logs.map((log) => ({
    ...log,
    user_prompt_preview: stripUntrustedSenderMetadata(log.user_prompt_preview),
  }));

  return {
    logs: sanitizedLogs,
    total: Number(total || 0),
    page: safePage,
    limit: safeLimit,
  };
}

// 公开：查询 API Key
router.post('/key-query', async (req, res) => {
  try {
    const key = normalizeApiKey(req.body?.key || '');
    if (!key) return res.status(400).json({ error: '请输入 API Key' });
    if (!isValidApiKeyFormat(key)) {
      return res.status(400).json({ error: 'API Key 格式不正确，请粘贴完整的 sk- 开头密钥' });
    }
    const keyHash = hashApiKey(key);
    const row = await getGuestKeyDetailsByHash(keyHash);
    if (!row) return res.status(404).json({ error: '未找到该 Key' });
    const usedQuota = Math.max(0, Number(row.guest_paid_quota || 0) - Number(row.quota_balance || 0));
    res.json({
      valid: true,
      key_display: row.key_display,
      name: row.name,
      status: row.status,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      owner_email: maskEmail(row.email || ''),
      owner_username: row.username,
      quota_balance: Number(row.quota_balance || 0),
      total_quota: Number(row.guest_paid_quota || 0),
      used_quota: usedQuota,
      last_paid_at: row.last_paid_at || null,
    });
  } catch (error) {
    console.error('[guest] key query failed:', error.message);
    res.status(500).json({ error: '查询失败' });
  }
});

// 公开：查询 Key 的请求日志
router.post('/key-logs', async (req, res) => {
  try {
    const key = normalizeApiKey(req.body?.key || '');
    if (!key) return res.status(400).json({ error: '请输入 API Key' });
    if (!isValidApiKeyFormat(key)) {
      return res.status(400).json({ error: 'API Key 格式不正确，请粘贴完整的 sk- 开头密钥' });
    }
    const keyHash = hashApiKey(key);
    const row = await getGuestKeyDetailsByHash(keyHash);
    if (!row) return res.status(404).json({ error: '未找到该 Key' });

    const { logs, total, page, limit } = await getGuestKeyLogsByHash({
      keyHash,
      page: req.body?.page,
      limit: req.body?.limit,
    });

    res.json({
      key_display: row.key_display,
      name: row.name,
      logs,
      total,
      page,
      limit,
    });
  } catch (error) {
    console.error('[guest] key logs query failed:', error.message);
    res.status(500).json({ error: '查询失败' });
  }
});

// 公开：查询游客订单
router.get('/order/:out_trade_no', async (req, res) => {
  try {
    const [[order]] = await db.query(
      `SELECT ro.out_trade_no, ro.status, ro.order_type, ro.amount, ro.quota, ro.bonus_quota, ro.actual_paid,
              ro.guest_email, ro.delivery_status, ro.delivery_message, ro.delivery_sent_at, ro.paid_at,
              k.key_display
       FROM recharge_orders ro
       LEFT JOIN openclaw_api_keys k ON k.id = ro.guest_key_id
       WHERE ro.out_trade_no = ?`,
      [req.params.out_trade_no]
    );
    if (!order) return res.status(404).json({ error: '订单不存在' });
    res.json({ order });
  } catch (error) {
    console.error('[guest] order query failed:', error.message);
    res.status(500).json({ error: '查询失败' });
  }
});

// 公开：游客购买额度并自动发卡
router.post('/create-recharge', async (req, res) => {
  const { email, amount, mobile } = req.body || {};
  try {
    const isMobile = typeof mobile === 'boolean' ? mobile : isMobileRequest(req);
    const order = await createGuestKeyOrder({ email, payAmount: amount });
    const payUrl = `${getPublicSiteUrl(req)}/api/pay/h5/${order.orderNo}`;
    res.json({
      out_trade_no: order.orderNo,
      amount: Number(amount),
      credit_amount: order.creditAmount,
      bonus_amount: order.bonusAmount,
      discount_label: order.tier.label,
      pay_url: payUrl,
      guest_email: email,
      mobile: isMobile,
    });
  } catch (error) {
    console.error('[guest] create recharge failed:', error.message);
    res.status(500).json({ error: error.message || '创建订单失败' });
  }
});

module.exports = router;
