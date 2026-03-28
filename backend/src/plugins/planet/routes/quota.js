const router = require('express').Router();
const db = require('../../../config/db');
const { auth } = require('../middleware/auth');

async function getSetting(key) {
  const [[row]] = await db.query('SELECT `value` FROM settings WHERE `key` = ?', [key]);
  return row ? row.value : null;
}

const _settingsCache = new Map();
const CACHE_TTL = 60000;
async function getSettingCached(key, defaultValue) {
  const cached = _settingsCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.val;
  const val = await getSetting(key);
  const result = val !== null ? val : defaultValue;
  _settingsCache.set(key, { val: result, ts: Date.now() });
  return result;
}

async function ensureQuota(userId) {
  await db.query('INSERT IGNORE INTO user_quota (user_id, extra_quota) VALUES (?, 0)', [userId]);
  const [[row]] = await db.query('SELECT * FROM user_quota WHERE user_id = ?', [userId]);
  return row;
}

async function addQuotaLog(userId, delta, reason) {
  await db.query('INSERT INTO quota_logs (user_id, delta, reason) VALUES (?, ?, ?)', [userId, delta, reason]);
}

function todayCST() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

function isVip(quota) {
  if (!quota.vip_expires_at) return false;
  return new Date(quota.vip_expires_at) > new Date();
}

// GET /api/quota
router.get('/', auth, async (req, res) => {
  const quota = await ensureQuota(req.user.id);
  const today = todayCST();
  const vip = isVip(quota);

  const [[userRow]] = await db.query('SELECT invite_code, level, role FROM users WHERE id = ?', [req.user.id]);
  const level = userRow?.level || 1;
  let claimLimit;
  if (userRow?.role === 'reviewer') {
    claimLimit = 30;
  } else if (vip) {
    claimLimit = parseInt(await getSetting('vip_claim_daily_limit')) || 10;
  } else {
    const levelLimits = { 1: 3, 2: 4, 3: 5, 4: 8, 5: 10 };
    claimLimit = levelLimits[level] || 3;
  }
  const previewLimit = parseInt(await getSetting(vip ? 'vip_preview_daily_limit' : 'preview_daily_limit')) || (vip ? 30 : 10);

  const [[{ previewed_today }]] = await db.query(
    'SELECT COUNT(*) as previewed_today FROM previews WHERE user_id = ? AND DATE(created_at) = ?',
    [req.user.id, today]
  );
  const [[{ claimed_today }]] = await db.query(
    'SELECT COUNT(*) as claimed_today FROM claims WHERE user_id = ? AND DATE(claimed_at) = ?',
    [req.user.id, today]
  );

  res.json({
    extra_quota: quota.extra_quota,
    vip: vip,
    vip_expires_at: quota.vip_expires_at,
    preview_limit: previewLimit,
    previewed_today,
    preview_remaining: Math.max(0, previewLimit - previewed_today),
    claim_limit: claimLimit,
    claimed_today,
    claim_remaining: Math.max(0, claimLimit - claimed_today),
    last_checkin_date: quota.last_checkin_date,
    invite_code: userRow?.invite_code || null,
  });
});

// POST /api/quota/daily-reward
router.post('/daily-reward', auth, async (req, res) => {
  await ensureQuota(req.user.id);
  const today = todayCST();
  const [result] = await db.query(
    'UPDATE user_quota SET extra_quota = extra_quota + 1, last_daily_reward_date = ? WHERE user_id = ? AND (last_daily_reward_date IS NULL OR last_daily_reward_date != ?)',
    [today, req.user.id, today]
  );
  if (result.affectedRows > 0) {
    await addQuotaLog(req.user.id, 1, '每日登录奖励');
    return res.json({ rewarded: true, message: '今日登录奖励 +1 积分' });
  }
  res.json({ rewarded: false });
});

// POST /api/quota/buy-vip — 已禁用
router.post('/buy-vip', auth, async (req, res) => {
  return res.status(403).json({ message: 'VIP 仅支持支付宝购买，请前往开通VIP页面' });
});

// GET /api/quota/invite-records
router.get('/invite-records', auth, async (req, res) => {
  const [[me]] = await db.query('SELECT invite_code FROM users WHERE id = ?', [req.user.id]);
  if (!me?.invite_code) return res.json([]);
  const [rows] = await db.query(
    `SELECT u.id, u.username, u.created_at FROM users u
     JOIN quota_logs ql ON ql.user_id = ? AND ql.reason LIKE CONCAT('邀请用户 ', u.username, '%')
     WHERE u.id != ? ORDER BY u.created_at DESC LIMIT 50`,
    [req.user.id, req.user.id]
  );
  res.json(rows);
});

// GET /api/quota/logs
router.get('/logs', auth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 20;
  const offset = (page - 1) * limit;
  const [rows] = await db.query(
    'SELECT id, delta, reason, created_at FROM quota_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [req.user.id, limit, offset]
  );
  const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM quota_logs WHERE user_id = ?', [req.user.id]);
  res.json({ logs: rows, total, page, limit });
});

module.exports = router;
module.exports.getSetting = getSetting;
module.exports.ensureQuota = ensureQuota;
module.exports.addQuotaLog = addQuotaLog;
module.exports.isVip = isVip;
module.exports.getSettingCached = getSettingCached;
