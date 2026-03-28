const router = require('express').Router();
const db = require('../config/db');
const { adminAuth } = require('../middleware/auth');

// 管理：用户列表
router.get('/', adminAuth, async (req, res) => {
  const [rows] = await db.query('SELECT id,username,email,role,is_active,created_at FROM users ORDER BY created_at DESC');
  res.json(rows);
});

// 管理：封禁/解封
router.put('/:id/status', adminAuth, async (req, res) => {
  const { is_active } = req.body;
  await db.query('UPDATE users SET is_active=? WHERE id=?', [is_active, req.params.id]);
  res.json({ message: '操作成功' });
});

// 管理：改角色
router.put('/:id/role', adminAuth, async (req, res) => {
  const { role } = req.body;
  await db.query('UPDATE users SET role=? WHERE id=?', [role, req.params.id]);
  res.json({ message: '操作成功' });
});

module.exports = router;
