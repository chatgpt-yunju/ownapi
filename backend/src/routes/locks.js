const router = require('express').Router();
const db = require('../config/db');
const { auth } = require('../middleware/auth');
const { ensureQuota, addQuotaLog, getSetting } = require('./quota');

// POST /api/locks/:contentId — 锁定视频
router.post('/:contentId', auth, async (req, res) => {
  const { contentId } = req.params;

  const [content] = await db.query('SELECT id, title FROM content WHERE id = ?', [contentId]);
  if (!content[0]) return res.status(404).json({ message: '视频不存在' });

  // 已领取则不需要锁定
  const [[claimed]] = await db.query('SELECT id FROM claims WHERE user_id = ? AND content_id = ?', [req.user.id, contentId]);
  if (claimed) return res.status(400).json({ message: '您已领取该视频，无需锁定' });

  // 已被他人领取
  const [[takenByOther]] = await db.query('SELECT id FROM claims WHERE content_id = ? AND user_id != ?', [contentId, req.user.id]);
  if (takenByOther) return res.status(400).json({ message: '该视频已被其他用户领取' });

  // 已锁定过
  const [[existing]] = await db.query('SELECT id, expires_at FROM content_locks WHERE user_id = ? AND content_id = ?', [req.user.id, contentId]);
  if (existing && new Date(existing.expires_at) > new Date()) {
    return res.status(400).json({ message: '您已锁定该视频', expires_at: existing.expires_at });
  }

  const cost = parseInt(await getSetting('lock_cost')) || 10;
  const dailyLimit = parseInt(await getSetting('lock_daily_limit')) || 3;
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

  // 检查今日锁定次数
  const [[{ locked_today }]] = await db.query(
    'SELECT COUNT(*) as locked_today FROM content_locks WHERE user_id = ? AND DATE(locked_at) = ?',
    [req.user.id, today]
  );
  if (locked_today >= dailyLimit) {
    return res.status(403).json({ message: `今日锁定次数已达上限（${dailyLimit}次）`, code: 'LOCK_LIMIT' });
  }

  // 检查积分
  const quota = await ensureQuota(req.user.id);
  if (quota.extra_quota < cost) {
    return res.status(403).json({ message: `积分不足，锁定需要 ${cost} 积分，当前 ${quota.extra_quota} 积分`, code: 'QUOTA_EXCEEDED' });
  }

  const expiresAt = new Date(Date.now() + 24 * 3600000);

  await db.query('UPDATE user_quota SET extra_quota = extra_quota - ? WHERE user_id = ?', [cost, req.user.id]);
  await addQuotaLog(req.user.id, -cost, `锁定「${content[0].title}」24小时`);
  await db.query(
    'INSERT INTO content_locks (user_id, content_id, expires_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE locked_at=NOW(), expires_at=?',
    [req.user.id, contentId, expiresAt, expiresAt]
  );

  res.json({ message: `锁定成功，保留24小时`, expires_at: expiresAt });
});

// GET /api/locks — 获取当前用户的锁定列表及今日锁定次数
router.get('/', auth, async (req, res) => {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const dailyLimit = parseInt(await getSetting('lock_daily_limit')) || 3;

  const [locks] = await db.query(
    'SELECT content_id, expires_at FROM content_locks WHERE user_id = ? AND expires_at > NOW()',
    [req.user.id]
  );
  const [[{ locked_today }]] = await db.query(
    'SELECT COUNT(*) as locked_today FROM content_locks WHERE user_id = ? AND DATE(locked_at) = ?',
    [req.user.id, today]
  );

  res.json({
    locked_ids: locks.map(l => ({ content_id: l.content_id, expires_at: l.expires_at })),
    locked_today,
    daily_limit: dailyLimit,
  });
});

module.exports = router;
