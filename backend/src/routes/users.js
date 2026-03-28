const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { auth, requireAdmin } = require('../middleware/auth');

// 创建用户（仅管理员）
router.post('/', auth, requireAdmin, async (req, res) => {
  const { username, password, role, review_category } = req.body;
  if (!username || !password) return res.status(400).json({ message: '用户名和密码不能为空' });
  if (password.length < 6) return res.status(400).json({ message: '密码不能少于6位' });
  if (!['admin', 'user', 'reviewer'].includes(role || 'user')) return res.status(400).json({ message: '无效角色' });
  const hash = await bcrypt.hash(password, 10);
  const finalRole = role || 'user';
  const finalCategory = finalRole === 'reviewer' ? (review_category || null) : null;
  try {
    const [result] = await db.query(
      'INSERT INTO users (username, password, role, review_category) VALUES (?, ?, ?, ?)',
      [username, hash, finalRole, finalCategory]
    );
    res.status(201).json({ id: result.insertId, message: '用户已创建' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: '用户名已存在' });
    throw err;
  }
});

// 获取所有用户列表（仅管理员）
router.get('/', auth, requireAdmin, async (req, res) => {
  const [rows] = await db.query(
    `SELECT u.id, u.username, u.role, u.review_category, u.created_at,
            COALESCE(uq.extra_quota, 0) AS extra_quota
     FROM users u
     LEFT JOIN user_quota uq ON uq.user_id = u.id
     ORDER BY u.created_at DESC`
  );
  res.json(rows);
});

// 修改密码（管理员可改任意用户，普通用户只能改自己）
router.put('/:id/password', auth, async (req, res) => {
  const targetId = parseInt(req.params.id);
  const { password } = req.body;

  if (!password || password.length < 6) {
    return res.status(400).json({ message: '密码不能少于6位' });
  }

  // 非管理员只能改自己
  if (req.user.role !== 'admin' && req.user.id !== targetId) {
    return res.status(403).json({ message: '无权限' });
  }

  const hash = await bcrypt.hash(password, 10);
  const [result] = await db.query('UPDATE users SET password = ? WHERE id = ?', [hash, targetId]);
  if (result.affectedRows === 0) return res.status(404).json({ message: '用户不存在' });
  res.json({ message: '密码已更新' });
});

// 修改角色（仅管理员）
router.put('/:id/role', auth, requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id);
  const { role, review_category } = req.body;
  if (!['admin', 'user', 'reviewer'].includes(role)) return res.status(400).json({ message: '无效角色' });
  if (req.user.id === targetId) return res.status(400).json({ message: '不能修改自己的角色' });
  await db.query('UPDATE users SET role = ?, review_category = ? WHERE id = ?', [role, role === 'reviewer' ? (review_category || null) : null, targetId]);
  res.json({ message: '角色已更新' });
});

// 修改积分（仅管理员）
router.put('/:id/quota', auth, requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id);
  const { extra_quota } = req.body;
  if (typeof extra_quota !== 'number' || extra_quota < 0) {
    return res.status(400).json({ message: '积分必须为非负整数' });
  }
  await db.query(
    'INSERT INTO user_quota (user_id, extra_quota) VALUES (?, ?) ON DUPLICATE KEY UPDATE extra_quota = ?',
    [targetId, extra_quota, extra_quota]
  );
  res.json({ message: '积分已更新' });
});

// 删除用户（仅管理员）
router.delete('/:id', auth, requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (req.user.id === targetId) return res.status(400).json({ message: '不能删除自己' });
  const [result] = await db.query('DELETE FROM users WHERE id = ?', [targetId]);
  if (result.affectedRows === 0) return res.status(404).json({ message: '用户不存在' });
  res.json({ message: '用户已删除' });
});

module.exports = router;
