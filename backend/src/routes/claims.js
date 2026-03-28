const router = require('express').Router();
const db = require('../config/db');
const { auth } = require('../middleware/auth');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { getSetting, ensureQuota, addQuotaLog, isVip } = require('./quota');
const { checkLowStock } = require('../scheduler');
require('dotenv').config();

// 计算并更新用户等级
async function updateLevel(userId) {
  const [[u]] = await db.query('SELECT total_claimed, total_rated FROM users WHERE id = ?', [userId]);
  if (!u) return;
  let level = 1;
  if (u.total_claimed >= 100 && u.total_rated >= 30) level = 4;
  else if (u.total_claimed >= 30 && u.total_rated >= 10) level = 3;
  else if (u.total_claimed >= 10) level = 2;
  await db.query('UPDATE users SET level = ? WHERE id = ? AND level < ?', [level, userId, 5]); // Lv5 仅管理员授予
}

// Preview a content item
router.post('/:contentId/preview', auth, async (req, res) => {
  const { contentId } = req.params;
  const [content] = await db.query('SELECT * FROM content WHERE id = ?', [contentId]);
  if (!content[0]) return res.status(404).json({ message: 'Content not found' });

  // 已领取则免费预览
  const [[claimed]] = await db.query('SELECT id FROM claims WHERE user_id = ? AND content_id = ?', [req.user.id, contentId]);
  if (claimed) return res.json({ message: 'ok', quota_deducted: false });

  // 已预览过则免费
  const [[previewed]] = await db.query('SELECT id FROM previews WHERE user_id = ? AND content_id = ?', [req.user.id, contentId]);
  if (previewed) return res.json({ message: 'ok', quota_deducted: false });

  const quota = await ensureQuota(req.user.id);
  const vip = isVip(quota);
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const previewLimit = parseInt(await getSetting(vip ? 'vip_preview_daily_limit' : 'preview_daily_limit')) || (vip ? 30 : 10);

  const [[{ count }]] = await db.query(
    'SELECT COUNT(*) as count FROM previews WHERE user_id = ? AND DATE(created_at) = ?',
    [req.user.id, today]
  );

  // 超出限额直接禁止
  if (count >= previewLimit) {
    return res.status(403).json({ message: `今日预览次数已达上限（${previewLimit}次），请明天再来或兑换VIP`, code: 'QUOTA_EXCEEDED' });
  }

  // 每次预览扣1积分
  if (quota.extra_quota < 1) {
    return res.status(403).json({ message: '积分不足，预览需要1积分，请签到或充值', code: 'QUOTA_EXCEEDED' });
  }
  await db.query('UPDATE user_quota SET extra_quota = extra_quota - 1 WHERE user_id = ?', [req.user.id]);
  await addQuotaLog(req.user.id, -1, `预览「${content[0].title}」`);

  await db.query('INSERT IGNORE INTO previews (user_id, content_id, quota_deducted) VALUES (?, ?, 1)', [req.user.id, contentId]);
  res.json({ message: 'ok', quota_deducted: true });
});

// Claim a content item
router.post('/:contentId', auth, async (req, res) => {
  const { contentId } = req.params;
  const [content] = await db.query('SELECT * FROM content WHERE id = ?', [contentId]);
  if (!content[0]) return res.status(404).json({ message: 'Content not found' });
  if (!content[0].video_path) return res.status(400).json({ message: 'No video to claim' });

  const [existing] = await db.query('SELECT * FROM claims WHERE content_id = ?', [contentId]);
  if (existing[0]) {
    if (existing[0].user_id === req.user.id) return res.status(409).json({ message: '您已领取过该视频' });
    return res.status(409).json({ message: '该视频已被其他用户领取' });
  }

  const quota = await ensureQuota(req.user.id);
  const vip = isVip(quota);
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  let claimLimit;
  const [[userRow]] = await db.query('SELECT level, role FROM users WHERE id = ?', [req.user.id]);
  if (userRow?.role === 'reviewer') {
    claimLimit = 30;
  } else if (vip) {
    claimLimit = parseInt(await getSetting('vip_claim_daily_limit')) || 10;
  } else {
    const level = userRow?.level || 1;
    const levelLimits = { 1: 3, 2: 4, 3: 5, 4: 8, 5: 10 };
    claimLimit = levelLimits[level] || 3;
  }

  const [[{ claimed_today }]] = await db.query(
    'SELECT COUNT(*) as claimed_today FROM claims WHERE user_id = ? AND DATE(claimed_at) = ?',
    [req.user.id, today]
  );

  // 超出限额直接禁止
  if (claimed_today >= claimLimit) {
    return res.status(403).json({ message: `今日领取次数已达上限（${claimLimit}次），请明天再来或兑换VIP`, code: 'QUOTA_EXCEEDED' });
  }

  // 每次领取扣1积分
  if (quota.extra_quota < 1) {
    return res.status(403).json({ message: '积分不足，领取需要1积分，请签到或充值', code: 'QUOTA_EXCEEDED' });
  }
  await db.query('UPDATE user_quota SET extra_quota = extra_quota - 1 WHERE user_id = ?', [req.user.id]);
  await addQuotaLog(req.user.id, -1, `领取「${content[0].title}」`);

  try {
    await db.query('INSERT INTO claims (user_id, content_id) VALUES (?, ?)', [req.user.id, contentId]);
    // 更新累计领取数并重新计算等级
    await db.query('UPDATE users SET total_claimed = total_claimed + 1 WHERE id = ?', [req.user.id]);
    await updateLevel(req.user.id);

    // 更新任务进度
    const { updateTaskProgress } = require('./tasks');
    await updateTaskProgress(req.user.id, 'newbie_first_claim', 1);
    await updateTaskProgress(req.user.id, 'daily_claim_3', 1);
    await updateTaskProgress(req.user.id, 'achievement_claim_10', 1);
    await updateTaskProgress(req.user.id, 'achievement_claim_50', 1);

    res.status(201).json({ message: 'Claimed successfully' });
    checkLowStock(contentId).catch(e => console.error('[预警]', e.message));
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: '该视频已被领取' });
    throw err;
  }
});

// List current user's claims
router.get('/', auth, async (req, res) => {
  const [rows] = await db.query(
    `SELECT cl.id as claim_id, cl.claimed_at, cl.downloaded_at, c.id, c.title, c.copy, c.image_path, c.video_path, c.category
     FROM claims cl JOIN content c ON cl.content_id = c.id
     WHERE cl.user_id = ? ORDER BY cl.claimed_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// Send video to email
router.post('/:contentId/send-email', auth, async (req, res) => {
  const { contentId } = req.params;
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: '请输入有效的邮箱地址' });

  const [claim] = await db.query('SELECT * FROM claims WHERE user_id = ? AND content_id = ?', [req.user.id, contentId]);
  if (!claim[0]) return res.status(403).json({ message: '无权操作' });

  const [content] = await db.query('SELECT * FROM content WHERE id = ?', [contentId]);
  if (!content[0] || !content[0].video_path) return res.status(404).json({ message: '视频不存在' });

  const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads');
  const filePath = path.join(UPLOAD_DIR, content[0].video_path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ message: '视频文件不存在' });

  await db.query('UPDATE users SET email = ? WHERE id = ?', [email, req.user.id]);

  const smtpHost = await getSetting('smtp_host') || 'smtp.qq.com';
  const smtpPort = parseInt(await getSetting('smtp_port')) || 465;
  const smtpUser = await getSetting('smtp_user');
  const smtpPass = await getSetting('smtp_pass');
  if (!smtpUser || !smtpPass) return res.status(500).json({ message: '邮件服务未配置，请联系管理员' });

  await db.query('UPDATE claims SET downloaded_at = NOW() WHERE user_id = ? AND content_id = ?', [req.user.id, contentId]);
  res.json({ message: '视频发送中，请稍后查收邮件' });

  const transporter = nodemailer.createTransport({ host: smtpHost, port: smtpPort, secure: smtpPort === 465, auth: { user: smtpUser, pass: smtpPass } });
  transporter.sendMail({
    from: smtpUser, to: email,
    subject: `【AI短视频】${content[0].title}`,
    text: `您好，您领取的视频「${content[0].title}」已作为附件发送，请查收。${content[0].copy ? `\n\n视频文案：\n${content[0].copy}` : ''}`,
    attachments: [{ filename: `${content[0].title}.mp4`, path: filePath }],
  }).catch(err => console.error('邮件发送失败:', err));
});

// Download claimed video
router.get('/:contentId/download', auth, async (req, res) => {
  const { contentId } = req.params;
  const [claim] = await db.query('SELECT * FROM claims WHERE user_id = ? AND content_id = ?', [req.user.id, contentId]);
  if (!claim[0]) return res.status(403).json({ message: 'You have not claimed this content' });

  const [content] = await db.query('SELECT * FROM content WHERE id = ?', [contentId]);
  if (!content[0] || !content[0].video_path) return res.status(404).json({ message: 'Video not found' });

  const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads');
  const filePath = path.join(UPLOAD_DIR, content[0].video_path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'File not found on server' });

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(content[0].title)}.mp4"`);
  res.setHeader('Content-Type', 'video/mp4');
  await db.query('UPDATE claims SET downloaded_at = NOW() WHERE user_id = ? AND content_id = ?', [req.user.id, contentId]);
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
module.exports.updateLevel = updateLevel;

