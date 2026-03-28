const router = require('express').Router();
const db = require('../config/db');
const upload = require('../middleware/upload');
const { auth, optionalAuth, requireAdmin } = require('../middleware/auth');
const storage = require('../storage/local');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const nodemailer = require('nodemailer');
const { getSetting } = require('./quota');

ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads');

// 运行时迁移：加 is_top 字段
db.query("ALTER TABLE content ADD COLUMN is_top TINYINT(1) NOT NULL DEFAULT 0").catch(() => {});

function extractThumbnail(videoPath) {
  return new Promise((resolve) => {
    const imgDir = path.join(UPLOAD_DIR, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const filename = `thumb-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
    ffmpeg(videoPath)
      .screenshots({ timestamps: ['1'], filename, folder: imgDir, size: '?x720' })
      .on('end', () => resolve(path.join('images', filename).replace(/\\/g, '/')))
      .on('error', () => resolve(null));
  });
}

// List all content (both admin and user)
router.get('/', optionalAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  const category = req.query.category !== undefined ? req.query.category : null;
  const search = req.query.search || null;
  const claimStatus = req.query.claimStatus || null; // 'claimed' | 'unclaimed'
  const showClaimed = req.query.showClaimed !== '0';
  const showTaken = req.query.showTaken !== '0';
  const userId = req.user?.id || null;

  const conditions = [];
  const params = [];
  if (category === '') { conditions.push('(c.category IS NULL OR c.category = "")'); }
  else if (category) { conditions.push('c.category = ?'); params.push(category); }
  if (search) { conditions.push('(c.title LIKE ? OR c.copy LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (userId) {
    if (claimStatus === 'claimed') { conditions.push('EXISTS (SELECT 1 FROM claims WHERE content_id = c.id AND user_id = ?)'); params.push(userId); }
    if (claimStatus === 'unclaimed') { conditions.push('NOT EXISTS (SELECT 1 FROM claims WHERE content_id = c.id AND user_id = ?)'); params.push(userId); }

    // 复选框筛选：默认不显示已领取/已被领取
    const excludes = [];
    if (!showClaimed) { excludes.push('NOT EXISTS (SELECT 1 FROM claims WHERE content_id = c.id AND user_id = ?)'); params.push(userId); }
    if (!showTaken) { excludes.push('NOT EXISTS (SELECT 1 FROM claims WHERE content_id = c.id AND user_id != ?)'); params.push(userId); }
    excludes.forEach(e => conditions.push(e));
  }

  // 后台管理员复选框筛选
  if (req.query.adminFilterClaimed !== undefined) {
    const adminClaimed = req.query.adminFilterClaimed !== '0';
    const adminTaken = req.query.adminFilterTaken !== '0';
    const adminUnclaimed = req.query.adminFilterUnclaimed !== '0';
    if (!adminClaimed || !adminTaken || !adminUnclaimed) {
      const orParts = [];
      if (adminUnclaimed) orParts.push('NOT EXISTS (SELECT 1 FROM claims WHERE content_id = c.id)');
      if (adminClaimed || adminTaken) orParts.push('EXISTS (SELECT 1 FROM claims WHERE content_id = c.id)');
      if (orParts.length === 1) conditions.push(orParts[0]);
    }
  }
  // user端只显示审核通过的内容
  if (!req.query.adminView) {
    conditions.push('c.review_status = "approved"');
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const [rows] = await db.query(
    `SELECT c.*, u.username as author,
      (SELECT COUNT(*) FROM claims WHERE content_id = c.id) as claim_count,
      (SELECT u2.username FROM claims cl JOIN users u2 ON cl.user_id = u2.id WHERE cl.content_id = c.id LIMIT 1) as claimed_by,
      (SELECT ROUND(AVG(score),1) FROM ratings WHERE content_id = c.id) as avg_score,
      (SELECT COUNT(*) FROM ratings WHERE content_id = c.id) as rating_count
     FROM content c
     LEFT JOIN users u ON c.created_by = u.id
     ${where}
     ORDER BY ${userId ? '(SELECT COUNT(*) FROM claims WHERE content_id = c.id AND user_id = ?) DESC,' : ''} c.created_at DESC
     LIMIT ? OFFSET ?`,
    userId ? [...params, userId, limit, offset] : [...params, limit, offset]
  );
  const [[countRow]] = await db.query(
    `SELECT COUNT(*) as total FROM content c ${where}`,
    params
  );
  res.json({ data: rows, total: countRow?.total || 0, page, limit });
});

// Get single content item
router.get('/:id', auth, async (req, res) => {
  const [rows] = await db.query(
    `SELECT c.*, u.username as author FROM content c
     LEFT JOIN users u ON c.created_by = u.id
     WHERE c.id = ?`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Not found' });
  res.json(rows[0]);
});

// Create content (admin only)
router.post(
  '/',
  auth,
  requireAdmin,
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }]),
  async (req, res) => {
    const { title, copy, category, source_url, play_count, share_count, convert_count } = req.body;
    const resolvedTitle = title?.trim() || (copy ? copy.trim().split('\n')[0] : '');
    if (!resolvedTitle) return res.status(400).json({ message: '标题不能为空，或请填写文案以自动提取标题' });
    if (!req.files?.video?.[0]) return res.status(400).json({ message: '视频文件不能为空' });

    // 重复检测
    const conflicts = [];
    const [titleCheck] = await db.query('SELECT id, title FROM content WHERE title = ?', [resolvedTitle]);
    if (titleCheck.length) conflicts.push(`标题「${resolvedTitle}」已存在（ID: ${titleCheck[0].id}）`);
    if (copy?.trim()) {
      const [copyCheck] = await db.query('SELECT id, title FROM content WHERE copy = ?', [copy.trim()]);
      if (copyCheck.length) conflicts.push(`文案内容与「${copyCheck[0].title}」（ID: ${copyCheck[0].id}）重复`);
    }
    const videoOriginalName = req.files?.video?.[0]?.originalname;
    if (videoOriginalName) {
      const [videoCheck] = await db.query('SELECT id, title FROM content WHERE video_original_name = ?', [videoOriginalName]);
      if (videoCheck.length) conflicts.push(`视频「${videoOriginalName}」与「${videoCheck[0].title}」（ID: ${videoCheck[0].id}）重复`);
    }
    if (conflicts.length) return res.status(400).json({ message: conflicts.join('；') });

    const videoPath = req.files?.video?.[0]
      ? path.relative(UPLOAD_DIR, req.files.video[0].path).replace(/\\/g, '/')
      : null;

    let imagePath = req.files?.image?.[0]
      ? path.relative(UPLOAD_DIR, req.files.image[0].path).replace(/\\/g, '/')
      : null;
    if (!imagePath && videoPath) {
      imagePath = await extractThumbnail(path.join(UPLOAD_DIR, videoPath));
    }

    // 检查分类是否开启审核，管理员可手动覆盖
    let reviewStatus = 'approved';
    const validStatuses = ['approved', 'pending', 'rejected'];
    if (req.body.review_status && validStatuses.includes(req.body.review_status)) {
      reviewStatus = req.body.review_status;
    } else if (category) {
      const [[cat]] = await db.query('SELECT review_enabled FROM categories WHERE name = ?', [category]);
      if (cat?.review_enabled) reviewStatus = 'pending';
    }

    const [result] = await db.query(
      'INSERT INTO content (title, category, copy, image_path, video_path, video_original_name, created_by, review_status, source_url, play_count, share_count, convert_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [resolvedTitle, category || null, copy || null, imagePath, videoPath, videoOriginalName || null, req.user.id, reviewStatus,
       source_url || null, play_count || null, share_count || null, convert_count || null]
    );
    res.status(201).json({ id: result.insertId, message: 'Created', review_status: reviewStatus });
  }
);

// Update content (admin only)
router.put(
  '/:id',
  auth,
  requireAdmin,
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }]),
  async (req, res) => {
    const [rows] = await db.query('SELECT * FROM content WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ message: 'Not found' });

    const { title, copy, category, source_url, play_count, share_count, convert_count } = req.body;
    let { image_path, video_path } = rows[0];

    if (req.files?.image?.[0]) {
      if (image_path) storage.delete(image_path);
      image_path = path.relative(path.resolve(process.env.UPLOAD_DIR || 'uploads'), req.files.image[0].path).replace(/\\/g, '/');
    }
    if (req.files?.video?.[0]) {
      if (video_path) storage.delete(video_path);
      video_path = path.relative(path.resolve(process.env.UPLOAD_DIR || 'uploads'), req.files.video[0].path).replace(/\\/g, '/');
    }

    const { review_status } = req.body;
    const validStatuses = ['pending', 'approved', 'rejected'];
    const newReviewStatus = validStatuses.includes(review_status) ? review_status : rows[0].review_status;
    await db.query(
      'UPDATE content SET title=?, category=?, copy=?, image_path=?, video_path=?, review_status=?, source_url=?, play_count=?, share_count=?, convert_count=? WHERE id=?',
      [title || rows[0].title, category ?? rows[0].category, copy ?? rows[0].copy, image_path, video_path, newReviewStatus,
       source_url ?? rows[0].source_url, play_count ?? rows[0].play_count, share_count ?? rows[0].share_count, convert_count ?? rows[0].convert_count,
       req.params.id]
    );
    res.json({ message: 'Updated' });
  }
);

// Batch upload content (admin only)
router.post(
  '/batch',
  auth,
  requireAdmin,
  upload.fields([{ name: 'images', maxCount: 50 }, { name: 'videos', maxCount: 50 }]),
  async (req, res) => {
    const images = req.files?.images || [];
    const videos = req.files?.videos || [];
    const { category, copy } = req.body;

    if (!images.length && !videos.length) {
      return res.status(400).json({ message: '请至少上传一个文件' });
    }

    const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads');
    const toRel = f => path.relative(UPLOAD_DIR, f.path).replace(/\\/g, '/');

    // 检查分类是否开启审核
    let batchReviewStatus = 'approved';
    if (category) {
      const [[cat]] = await db.query('SELECT review_enabled FROM categories WHERE name = ?', [category]);
      if (cat?.review_enabled) batchReviewStatus = 'pending';
    }

    // 按文件名（去扩展名）匹配图片和视频
    const imageMap = {};
    images.forEach(f => {
      const key = path.basename(f.originalname, path.extname(f.originalname));
      imageMap[key] = f;
    });
    const videoMap = {};
    videos.forEach(f => {
      const key = path.basename(f.originalname, path.extname(f.originalname));
      videoMap[key] = f;
    });

    // 合并所有文件名
    const allKeys = new Set([...Object.keys(imageMap), ...Object.keys(videoMap)]);
    const results = [];
    const skipped = [];

    for (const key of allKeys) {
      const img = imageMap[key] || null;
      const vid = videoMap[key] || null;
      const title = key;

      // 重复检测
      const conflicts = [];
      const [titleCheck] = await db.query('SELECT id FROM content WHERE title = ?', [title]);
      if (titleCheck.length) conflicts.push(`标题「${title}」已存在`);
      if (vid) {
        const [videoCheck] = await db.query('SELECT id, title FROM content WHERE video_original_name = ?', [vid.originalname]);
        if (videoCheck.length) conflicts.push(`视频「${vid.originalname}」与「${videoCheck[0].title}」（ID: ${videoCheck[0].id}）重复`);
      }
      if (conflicts.length) {
        skipped.push(`${title}：${conflicts.join('；')}`);
        continue;
      }
      const videoPath = vid ? toRel(vid) : null;
      let imagePath = img ? toRel(img) : null;
      if (!imagePath && vid) {
        imagePath = await extractThumbnail(vid.path);
      }
      const [result] = await db.query(
        'INSERT INTO content (title, category, copy, image_path, video_path, video_original_name, created_by, review_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [title, category || null, copy || null, imagePath, videoPath, vid?.originalname || null, req.user.id, batchReviewStatus]
      );
      results.push({ id: result.insertId, title });
    }

    res.status(201).json({
      message: `成功上传 ${results.length} 条，跳过 ${skipped.length} 条`,
      data: results,
      skipped
    });
  }
);

// POST /api/content/:id/send-email — 发送内容到邮箱（admin only）
router.post('/:id/send-email', auth, requireAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email || !email.trim()) return res.status(400).json({ message: '邮箱不能为空' });

  const [[content]] = await db.query('SELECT * FROM content WHERE id = ?', [req.params.id]);
  if (!content) return res.status(404).json({ message: '内容不存在' });

  const host = await getSetting('smtp_host') || 'smtp.qq.com';
  const port = parseInt(await getSetting('smtp_port')) || 465;
  const user = await getSetting('smtp_user');
  const pass = await getSetting('smtp_pass');
  if (!user || !pass) return res.status(500).json({ message: '邮件服务未配置，请在设置中填写 SMTP 信息' });

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const imageHtml = content.image_path
    ? `<p><strong>封面图：</strong><br/><img src="${baseUrl}/uploads/${content.image_path}" style="max-width:400px;border-radius:8px" /></p>`
    : '';
  const videoHtml = content.video_path
    ? `<p><strong>视频下载：</strong><br/><a href="${baseUrl}/uploads/${content.video_path}">${baseUrl}/uploads/${content.video_path}</a></p>`
    : '';
  const copyHtml = content.copy
    ? `<p><strong>文案：</strong></p><pre style="white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:6px">${content.copy}</pre>`
    : '';

  const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  await transporter.sendMail({
    from: user,
    to: email.trim(),
    subject: `【内容分享】${content.title}`,
    html: `
      <h2 style="margin-bottom:8px">${content.title}</h2>
      <p style="color:#888;font-size:13px">分类：${content.category || '未分类'} · 上传者：${content.author}</p>
      ${imageHtml}
      ${copyHtml}
      ${videoHtml}
    `,
  });

  res.json({ message: '邮件已发送' });
});

// Delete content (admin only)
router.delete('/:id', auth, requireAdmin, async (req, res) => {
  const [rows] = await db.query('SELECT * FROM content WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: 'Not found' });

  if (rows[0].image_path) storage.delete(rows[0].image_path);
  if (rows[0].video_path) storage.delete(rows[0].video_path);

  await db.query('DELETE FROM content WHERE id = ?', [req.params.id]);
  res.json({ message: 'Deleted' });
});

module.exports = router;
