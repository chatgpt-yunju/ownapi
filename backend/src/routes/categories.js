const router = require('express').Router();
const db = require('../config/db');
const { auth, requireAdmin } = require('../middleware/auth');

// 获取所有分类（公开接口，游客可访问）
router.get('/', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM categories ORDER BY created_at ASC');
  const [counts] = await db.query(
    `SELECT category,
      COUNT(*) as total,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM claims WHERE content_id = c.id) THEN 1 ELSE 0 END) as claimed,
      SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM claims WHERE content_id = c.id) THEN 1 ELSE 0 END) as unclaimed
     FROM content c WHERE review_status = 'approved' GROUP BY category`
  );
  const countMap = {};
  counts.forEach(r => { if (r.category) countMap[r.category] = { total: Number(r.total), claimed: Number(r.claimed), unclaimed: Number(r.unclaimed) }; });
  res.json(rows.map(r => ({ ...r, ...(countMap[r.name] || { total: 0, claimed: 0, unclaimed: 0 }) })));
});

// 创建分类（仅管理员）
router.post('/', auth, requireAdmin, async (req, res) => {
  const { name, daily_quota, receive_email } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ message: '分类名称不能为空' });
  const [exist] = await db.query('SELECT id FROM categories WHERE name = ?', [name.trim()]);
  if (exist.length) return res.status(400).json({ message: '分类名称已存在' });
  const quota = parseInt(daily_quota) > 0 ? parseInt(daily_quota) : 3;
  const email = receive_email?.trim() || null;
  const [result] = await db.query('INSERT INTO categories (name, daily_quota, receive_email, review_enabled) VALUES (?, ?, ?, 1)', [name.trim(), quota, email]);
  res.status(201).json({ id: result.insertId, name: name.trim(), daily_quota: quota, receive_email: email, review_enabled: 1 });
});

// 更新分类（仅管理员）
router.put('/:id', auth, requireAdmin, async (req, res) => {
  const { name, daily_quota, receive_email, review_enabled } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ message: '分类名称不能为空' });
  const [rows] = await db.query('SELECT id FROM categories WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: '分类不存在' });
  const [exist] = await db.query('SELECT id FROM categories WHERE name = ? AND id != ?', [name.trim(), req.params.id]);
  if (exist.length) return res.status(400).json({ message: '分类名称已存在' });
  const quota = parseInt(daily_quota) > 0 ? parseInt(daily_quota) : 3;
  const email = receive_email?.trim() || null;
  await db.query('UPDATE categories SET name = ?, daily_quota = ?, receive_email = ?, review_enabled = ? WHERE id = ?', [name.trim(), quota, email, review_enabled ? 1 : 0, req.params.id]);
  res.json({ message: '更新成功' });
});

// 删除分类（仅管理员）
router.delete('/:id', auth, requireAdmin, async (req, res) => {
  const [rows] = await db.query('SELECT id FROM categories WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: '分类不存在' });
  await db.query('DELETE FROM categories WHERE id = ?', [req.params.id]);
  res.json({ message: '删除成功' });
});

module.exports = router;
