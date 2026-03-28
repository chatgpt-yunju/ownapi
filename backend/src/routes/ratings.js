const router = require('express').Router();
const db = require('../config/db');
const { auth } = require('../middleware/auth');
const { addQuotaLog, getSetting } = require('./quota');
const { updateLevel } = require('./claims');

// 提交或更新打分（只能评价已预览的视频）
router.post('/:contentId', auth, async (req, res) => {
  const { score, comment } = req.body;
  if (!score || score < 1 || score > 5) return res.status(400).json({ message: '评分需在1-5之间' });

  const contentId = req.params.contentId;

  // 必须已预览或已领取
  const [[previewed]] = await db.query('SELECT id FROM previews WHERE user_id = ? AND content_id = ?', [req.user.id, contentId]);
  const [[claimed]] = await db.query('SELECT id FROM claims WHERE user_id = ? AND content_id = ?', [req.user.id, contentId]);
  if (!previewed && !claimed) {
    return res.status(403).json({ message: '请先预览视频后再评价', code: 'NOT_PREVIEWED' });
  }

  // 检查是否已评价过（用于判断是否发放积分）
  const [[existing]] = await db.query('SELECT id FROM ratings WHERE content_id = ? AND user_id = ?', [contentId, req.user.id]);

  await db.query(
    'INSERT INTO ratings (content_id, user_id, score, comment) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE score=?, comment=?, created_at=NOW()',
    [contentId, req.user.id, score, comment || null, score, comment || null]
  );

  // 首次评价才发放积分
  if (!existing) {
    const ratingReward = parseInt(await getSetting('rating_reward')) || 1;
    const commentBonus = parseInt(await getSetting('rating_comment_bonus')) || 1;
    const hasComment = comment && comment.trim().length > 0;
    const total = ratingReward + (hasComment ? commentBonus : 0);

    await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [total, req.user.id]);
    const reason = hasComment ? `评价视频（含文字）` : `评价视频`;
    await addQuotaLog(req.user.id, total, reason);
    // 更新累计评分数并重新计算等级
    await db.query('UPDATE users SET total_rated = total_rated + 1 WHERE id = ?', [req.user.id]);
    await updateLevel(req.user.id);
    return res.json({ message: '评分成功', rewarded: total });
  }

  res.json({ message: '评分已更新', rewarded: 0 });
});

// 获取某内容的所有评分
router.get('/:contentId', auth, async (req, res) => {
  const [rows] = await db.query(
    `SELECT r.score, r.comment, r.created_at, u.username
     FROM ratings r JOIN users u ON r.user_id = u.id
     WHERE r.content_id = ? ORDER BY r.created_at DESC`,
    [req.params.contentId]
  );
  const avg = rows.length ? (rows.reduce((s, r) => s + r.score, 0) / rows.length).toFixed(1) : null;
  res.json({ avg, total: rows.length, list: rows });
});

// 获取当前用户对某内容的评分
router.get('/:contentId/mine', auth, async (req, res) => {
  const [rows] = await db.query(
    'SELECT score, comment FROM ratings WHERE content_id = ? AND user_id = ?',
    [req.params.contentId, req.user.id]
  );
  res.json(rows[0] || null);
});

module.exports = router;
