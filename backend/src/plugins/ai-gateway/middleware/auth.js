const jwt = require('jsonwebtoken');
const db = require('../../../config/db');

// JWT 直接验证（不再需要 HTTP 调用 SSO）
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未提供认证token' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const [[user]] = await db.query(
      'SELECT id, username, role, extra_quota, vip_level, balance FROM users WHERE id = ?',
      [decoded.id]
    );
    if (!user) return res.status(401).json({ error: '用户不存在' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'token验证失败' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

module.exports = { authMiddleware, adminOnly };
