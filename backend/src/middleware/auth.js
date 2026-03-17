const axios = require('axios');

// SSO token 验证中间件 — 调用主站 /api/sso/silent
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未提供认证token' });

  try {
    const resp = await axios.get('http://localhost:3000/api/sso/silent', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000
    });
    req.user = resp.data; // { id, username, role, extra_quota, vip, balance }
    next();
  } catch (err) {
    const status = err.response?.status || 500;
    const msg = err.response?.data?.message || 'token验证失败';
    return res.status(status).json({ error: msg });
  }
}

// 管理员中间件
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

module.exports = { authMiddleware, adminOnly };
