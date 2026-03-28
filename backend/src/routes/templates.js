const router = require('express').Router();
const db = require('../config/db');
const { auth, requireAdmin } = require('../middleware/auth');

// 建表
db.query(`CREATE TABLE IF NOT EXISTS script_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(128) NOT NULL,
  category VARCHAR(64),
  type ENUM('口播','剧情','种草','直播','广告') DEFAULT '口播',
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).catch(() => {});

// 获取模板列表（公开）
router.get('/', async (req, res) => {
  const { type } = req.query;
  const conditions = type ? ['type = ?'] : [];
  const params = type ? [type] : [];
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const [rows] = await db.query(`SELECT * FROM script_templates ${where} ORDER BY created_at DESC`, params);
  res.json(rows);
});

// 新增模板（管理员）
router.post('/', auth, requireAdmin, async (req, res) => {
  const { title, category, type, content } = req.body;
  if (!title || !content) return res.status(400).json({ message: '标题和内容不能为空' });
  const [result] = await db.query(
    'INSERT INTO script_templates (title, category, type, content) VALUES (?, ?, ?, ?)',
    [title, category || null, type || '口播', content]
  );
  res.status(201).json({ id: result.insertId, message: '创建成功' });
});

// 删除模板（管理员）
router.delete('/:id', auth, requireAdmin, async (req, res) => {
  await db.query('DELETE FROM script_templates WHERE id = ?', [req.params.id]);
  res.json({ message: '删除成功' });
});

module.exports = router;
