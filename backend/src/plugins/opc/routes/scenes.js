const router = require('express').Router();
const db = require('../config/db');
const { adminAuth } = require('../middleware/auth');

// 公开：获取所有启用场景
router.get('/', async (req, res) => {
  const [rows] = await db.query('SELECT id,name,prompt,description,sort_order FROM scenes WHERE is_active=1 ORDER BY sort_order');
  res.json(rows);
});

// 管理：获取全部场景
router.get('/all', adminAuth, async (req, res) => {
  const [rows] = await db.query('SELECT * FROM scenes ORDER BY sort_order');
  res.json(rows);
});

// 管理：新增场景
router.post('/', adminAuth, async (req, res) => {
  const { name, prompt, description, sort_order } = req.body;
  await db.query('INSERT INTO scenes (name,prompt,description,sort_order) VALUES (?,?,?,?)',
    [name, prompt, description || '', sort_order || 0]);
  res.json({ message: '创建成功' });
});

// 管理：编辑场景
router.put('/:id', adminAuth, async (req, res) => {
  const { name, prompt, description, sort_order, is_active } = req.body;
  await db.query('UPDATE scenes SET name=?,prompt=?,description=?,sort_order=?,is_active=? WHERE id=?',
    [name, prompt, description, sort_order, is_active, req.params.id]);
  res.json({ message: '更新成功' });
});

// 管理：删除场景
router.delete('/:id', adminAuth, async (req, res) => {
  await db.query('UPDATE scenes SET is_active=0 WHERE id=?', [req.params.id]);
  res.json({ message: '已停用' });
});

module.exports = router;
