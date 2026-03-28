const router = require('express').Router();
const db = require('../config/db');
const { auth } = require('../middleware/auth');

// 共享工具函数 — 委托到 yunjunet-common 公共基础
const { getSetting, getSettingCached, ensureQuota, addQuotaLog, todayCST, isVip } = require('yunjunet-common/backend-core/wallet/quota');

// GET /api/quota
router.get('/', auth, async (req, res) => {
  const quota = await ensureQuota(req.user.id);
  const today = todayCST();
  const vip = isVip(quota);

  // 等级限额：VIP 优先，其次按等级
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

// POST /api/quota/checkin
router.post('/checkin', auth, async (req, res) => {
  const reward = parseInt(await getSetting('checkin_reward')) || 1;
  const quota = await ensureQuota(req.user.id);
  const today = todayCST();
  const lastCheckin = quota.last_checkin_date ? String(quota.last_checkin_date).slice(0, 10) : null;
  if (lastCheckin === today) return res.status(400).json({ message: '今天已经签到过了' });

  await db.query(
    'UPDATE user_quota SET extra_quota = extra_quota + ?, last_checkin_date = ? WHERE user_id = ?',
    [reward, today, req.user.id]
  );
  await addQuotaLog(req.user.id, reward, '每日签到');

  // 计算连续签到天数并更新任务进度
  const yesterday = new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
  let consecutiveDays = 1;
  if (lastCheckin === yesterday) {
    // 连续签到
    const [[userTask]] = await db.query(
      'SELECT current_count FROM user_tasks WHERE user_id = ? AND task_key = ?',
      [req.user.id, 'achievement_checkin_7']
    );
    consecutiveDays = (userTask?.current_count || 0) + 1;
  }

  // 更新连续签到任务（7天和30天共享进度）
  const { updateTaskProgress } = require('./tasks');
  await db.query(
    'INSERT INTO user_tasks (user_id, task_key, current_count) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE current_count = ?',
    [req.user.id, 'achievement_checkin_7', consecutiveDays, consecutiveDays]
  );
  await db.query(
    'INSERT INTO user_tasks (user_id, task_key, current_count) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE current_count = ?',
    [req.user.id, 'achievement_checkin_30', consecutiveDays, consecutiveDays]
  );

  res.json({ message: `签到成功，获得 ${reward} 积分`, reward, consecutiveDays });
});

// POST /api/quota/buy-vip — 已禁用，VIP仅支持支付宝购买
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
module.exports.getSettingCached = getSettingCached;
module.exports.ensureQuota = ensureQuota;
module.exports.addQuotaLog = addQuotaLog;
module.exports.todayCST = todayCST;
module.exports.isVip = isVip;
