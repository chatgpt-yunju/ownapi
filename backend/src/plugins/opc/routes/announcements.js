const router = require('express').Router();
const db = require('../config/db');
const { adminAuth } = require('../middleware/auth');

// 公开：获取启用公告
router.get('/', async (req, res) => {
  const [rows] = await db.query('SELECT id,title,content,created_at FROM announcements WHERE is_active=1 ORDER BY created_at DESC LIMIT 5');
  res.json(rows);
});

// 管理：新增公告
router.post('/', adminAuth, async (req, res) => {
  const { title, content } = req.body;
  await db.query('INSERT INTO announcements (title,content) VALUES (?,?)', [title, content]);
  res.json({ message: '发布成功' });
});

// 管理：停用公告
router.delete('/:id', adminAuth, async (req, res) => {
  await db.query('UPDATE announcements SET is_active=0 WHERE id=?', [req.params.id]);
  res.json({ message: '已停用' });
});

module.exports = router;
