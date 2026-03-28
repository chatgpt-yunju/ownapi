const router = require('express').Router();
const db = require('../config/db');
const { auth, requireAdmin } = require('../middleware/auth');
const upload = require('../middleware/upload');

// User submits stats for a claimed video
router.post('/:claimId', auth, upload.single('screenshot'), async (req, res) => {
  const { claimId } = req.params;
  const { likes, comments, favorites, completion_rate, rate_3s, platform, views, shares, post_url } = req.body;

  const [claim] = await db.query(
    'SELECT * FROM claims WHERE id = ? AND user_id = ?',
    [claimId, req.user.id]
  );
  if (!claim[0]) return res.status(403).json({ message: '无权操作' });

  const screenshotPath = req.file ? `images/${req.file.filename}` : null;

  // If no new screenshot, keep existing one
  let finalScreenshot = screenshotPath;
  if (!finalScreenshot) {
    const [[existing]] = await db.query('SELECT screenshot_path FROM publish_stats WHERE claim_id = ?', [claimId]);
    finalScreenshot = existing?.screenshot_path || null;
  }

  await db.query(
    `INSERT INTO publish_stats (claim_id, user_id, content_id, platform, likes, comments, favorites, completion_rate, rate_3s, views, shares, post_url, screenshot_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       platform=VALUES(platform), likes=VALUES(likes), comments=VALUES(comments), favorites=VALUES(favorites),
       completion_rate=VALUES(completion_rate), rate_3s=VALUES(rate_3s),
       views=VALUES(views), shares=VALUES(shares), post_url=COALESCE(VALUES(post_url), post_url),
       screenshot_path=COALESCE(VALUES(screenshot_path), screenshot_path), updated_at=NOW()`,
    [claimId, req.user.id, claim[0].content_id, platform || '视频号', likes || 0, comments || 0, favorites || 0, completion_rate || 0, rate_3s || 0, views || 0, shares || 0, post_url || null, finalScreenshot]
  );
  res.json({ message: '数据回填成功' });
});

// User gets their own stats
router.get('/my', auth, async (req, res) => {
  const [rows] = await db.query(
    `SELECT ps.*, c.title, c.image_path FROM publish_stats ps
     JOIN content c ON ps.content_id = c.id
     WHERE ps.user_id = ?
     ORDER BY ps.updated_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// Admin gets all stats
router.get('/', auth, requireAdmin, async (req, res) => {
  const { platform } = req.query;
  const where = platform ? 'WHERE ps.platform = ?' : '';
  const params = platform ? [platform] : [];
  const [rows] = await db.query(
    `SELECT ps.*, c.title, u.username,
      AVG(ps.likes) OVER() as avg_likes,
      AVG(ps.comments) OVER() as avg_comments,
      AVG(ps.favorites) OVER() as avg_favorites,
      AVG(ps.completion_rate) OVER() as avg_completion_rate,
      AVG(ps.rate_3s) OVER() as avg_rate_3s
     FROM publish_stats ps
     JOIN content c ON ps.content_id = c.id
     JOIN users u ON ps.user_id = u.id
     ${where}
     ORDER BY ps.updated_at DESC`,
    params
  );
  res.json(rows);
});

// GET /api/stats/dashboard — 活跃度看板
router.get('/dashboard', auth, requireAdmin, async (req, res) => {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() + 8 * 3600000 - 7 * 86400000).toISOString().slice(0, 10);

  const [[{ today_users }]] = await db.query("SELECT COUNT(*) as today_users FROM users WHERE DATE(created_at) = ?", [today]);
  const [[{ week_users }]] = await db.query("SELECT COUNT(*) as week_users FROM users WHERE DATE(created_at) >= ?", [weekAgo]);
  const [[{ today_claims }]] = await db.query("SELECT COUNT(*) as today_claims FROM claims WHERE DATE(claimed_at) = ?", [today]);
  const [[{ week_claims }]] = await db.query("SELECT COUNT(*) as week_claims FROM claims WHERE DATE(claimed_at) >= ?", [weekAgo]);
  const [[{ total_users }]] = await db.query("SELECT COUNT(*) as total_users FROM users");
  const [[{ total_claims }]] = await db.query("SELECT COUNT(*) as total_claims FROM claims");

  // 近7天日活趋势
  const [trend] = await db.query(
    `SELECT DATE(claimed_at) as date, COUNT(DISTINCT user_id) as active_users
     FROM claims WHERE DATE(claimed_at) >= ? GROUP BY DATE(claimed_at) ORDER BY date ASC`,
    [weekAgo]
  );

  // 近7天注册趋势
  const [regTrend] = await db.query(
    `SELECT DATE(created_at) as date, COUNT(*) as new_users
     FROM users WHERE DATE(created_at) >= ? GROUP BY DATE(created_at) ORDER BY date ASC`,
    [weekAgo]
  );

  res.json({ today_users, week_users, today_claims, week_claims, total_users, total_claims, trend, regTrend });
});

// GET /api/stats/category-rank — 分类热度排行
router.get('/category-rank', auth, requireAdmin, async (req, res) => {
  const [rows] = await db.query(
    `SELECT c.category,
      COUNT(cl.id) as claim_count,
      ROUND(AVG(r.score), 1) as avg_score,
      COUNT(DISTINCT r.id) as rating_count
     FROM content c
     LEFT JOIN claims cl ON cl.content_id = c.id
     LEFT JOIN ratings r ON r.content_id = c.id
     WHERE c.category IS NOT NULL
     GROUP BY c.category
     ORDER BY claim_count DESC`
  );
  res.json(rows);
});

module.exports = router;
