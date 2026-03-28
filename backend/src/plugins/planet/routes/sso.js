const router = require('express').Router();
const jwt = require('jsonwebtoken');
const db = require('../../../config/db');

router.get('/silent', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: '未提供token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const [[user]] = await db.query('SELECT id, username, role FROM users WHERE id=?', [payload.id]);
    if (!user) return res.status(404).json({ message: '用户不存在' });
    const [[quota]] = await db.query('SELECT extra_quota, vip_expires_at, balance FROM user_quota WHERE user_id=?', [payload.id]);
    const vip = !!(quota?.vip_expires_at && new Date(quota.vip_expires_at) > new Date());
    res.json({ ...user, extra_quota: quota?.extra_quota ?? 0, vip, vip_expires_at: quota?.vip_expires_at ?? null, balance: quota?.balance ?? 0 });
  } catch {
    res.status(401).json({ message: 'token无效或已过期' });
  }
});

module.exports = router;
