const router = require('express').Router();
const db = require('../config/db');
const { auth, requireReviewer } = require('../middleware/auth');
const { getSetting, getSettingCached } = require('./quota');
const nodemailer = require('nodemailer');

const NOTIFY_EMAIL = '2743319061@qq.com'; // fallback default, overridden by getSettingCached('contact_email')

async function sendRejectMail(content, note) {
  const host = await getSetting('smtp_host') || 'smtp.qq.com';
  const port = parseInt(await getSetting('smtp_port')) || 465;
  const user = await getSetting('smtp_user');
  const pass = await getSetting('smtp_pass');
  if (!user || !pass) return;
  const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  await transporter.sendMail({
    from: user,
    to: await getSettingCached('contact_email', '2743319061@qq.com'),
    subject: `【审核不通过】${content.title}`,
    html: `
      <h3>视频审核未通过通知</h3>
      <p><strong>视频标题：</strong>${content.title}</p>
      <p><strong>所属分类：</strong>${content.category || '未分类'}</p>
      <p><strong>不通过原因：</strong>${note}</p>
      <p><strong>时间：</strong>${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>
    `,
  }).catch(e => console.error('[审核邮件] 发送失败:', e.message));
}

// GET /api/review — 获取待审核列表（审核员只能看自己分类）
router.get('/', auth, requireReviewer, async (req, res) => {
  const user = req.user;
  const status = req.query.status || 'pending';

  let categoryFilter = '';
  const params = [status];

  if (user.role === 'reviewer') {
    const [[dbUser]] = await db.query('SELECT review_category FROM users WHERE id = ?', [user.id]);
    if (!dbUser?.review_category) return res.json({ data: [], total: 0 });
    categoryFilter = 'AND c.category = ?';
    params.push(dbUser.review_category);
  }

  const [rows] = await db.query(
    `SELECT c.id, c.title, c.category, c.copy, c.image_path, c.video_path, c.created_at, c.review_status, c.review_note,
            u.username as author
     FROM content c
     LEFT JOIN users u ON c.created_by = u.id
     WHERE c.review_status = ? ${categoryFilter}
     ORDER BY c.created_at DESC`,
    params
  );
  res.json({ data: rows, total: rows.length });
});

// POST /api/review/:id/approve — 审核通过
router.post('/:id/approve', auth, requireReviewer, async (req, res) => {
  const [[content]] = await db.query('SELECT * FROM content WHERE id = ?', [req.params.id]);
  if (!content) return res.status(404).json({ message: '内容不存在' });

  if (req.user.role === 'reviewer') {
    const [[dbUser]] = await db.query('SELECT review_category FROM users WHERE id = ?', [req.user.id]);
    if (content.category !== dbUser?.review_category) return res.status(403).json({ message: '无权审核该分类' });
  }

  await db.query('UPDATE content SET review_status = "approved", review_note = NULL WHERE id = ?', [req.params.id]);
  res.json({ message: '审核通过' });
});

// POST /api/review/:id/reject — 审核不通过
router.post('/:id/reject', auth, requireReviewer, async (req, res) => {
  const { note } = req.body;
  if (!note || !note.trim()) return res.status(400).json({ message: '请填写不通过原因' });

  const [[content]] = await db.query('SELECT * FROM content WHERE id = ?', [req.params.id]);
  if (!content) return res.status(404).json({ message: '内容不存在' });

  if (req.user.role === 'reviewer') {
    const [[dbUser]] = await db.query('SELECT review_category FROM users WHERE id = ?', [req.user.id]);
    if (content.category !== dbUser?.review_category) return res.status(403).json({ message: '无权审核该分类' });
  }

  await db.query('UPDATE content SET review_status = "rejected", review_note = ? WHERE id = ?', [note.trim(), req.params.id]);
  await sendRejectMail(content, note.trim());
  res.json({ message: '已标记为不通过，通知邮件已发送' });
});

module.exports = router;
