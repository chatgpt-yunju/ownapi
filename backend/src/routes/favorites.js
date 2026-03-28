const router = require('express').Router();
const db = require('../config/db');
const { auth } = require('../middleware/auth');

// 建表
db.query(`CREATE TABLE IF NOT EXISTS favorites (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  title VARCHAR(128),
  content TEXT NOT NULL,
  source VARCHAR(64),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`).catch(() => {});

// 获取我的收藏
router.get('/', auth, async (req, res) => {
  const [rows] = await db.query(
    'SELECT * FROM favorites WHERE user_id = ? ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json(rows);
});

// 新增收藏
router.post('/', auth, async (req, res) => {
  const { title, content, source } = req.body;
  if (!content) return res.status(400).json({ message: '内容不能为空' });
  const [result] = await db.query(
    'INSERT INTO favorites (user_id, title, content, source) VALUES (?, ?, ?, ?)',
    [req.user.id, title || null, content, source || null]
  );
  res.status(201).json({ id: result.insertId, message: '收藏成功' });
});

// 删除收藏
router.delete('/:id', auth, async (req, res) => {
  const [rows] = await db.query('SELECT id FROM favorites WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ message: '收藏不存在' });
  await db.query('DELETE FROM favorites WHERE id = ?', [req.params.id]);
  res.json({ message: '删除成功' });
});

module.exports = router;
