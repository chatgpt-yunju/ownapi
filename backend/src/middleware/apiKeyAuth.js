const db = require('../config/db');
const crypto = require('crypto');

// API Key 鉴权中间件 — 用于 /v1/ 路由
// 支持两种认证方式：API Key (sk-xxx) 和 SSO Token（Playground用）
async function apiKeyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: { message: 'Missing authorization header', type: 'invalid_request_error' } });
  }

  const token = authHeader.slice(7);

  // SSO Token 认证（Playground 调试用）
  if (!token.startsWith('sk-')) {
    try {
      const ssoRes = await fetch('http://localhost:3000/api/sso/silent', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!ssoRes.ok) {
        return res.status(401).json({ error: { message: 'Invalid API key or token', type: 'invalid_request_error' } });
      }
      const userInfo = await ssoRes.json();
      const [[quota]] = await db.query('SELECT balance FROM user_quota WHERE user_id = ?', [userInfo.id]);
      req.apiKeyId = null; // Playground 无 key
      req.apiUserId = userInfo.id;
      req.userBalance = quota?.balance ?? 0;
      return next();
    } catch (err) {
      return res.status(401).json({ error: { message: 'Invalid API key or token', type: 'invalid_request_error' } });
    }
  }

  // API Key 认证
  const keyHash = crypto.createHash('sha256').update(token).digest('hex');

  try {
    const [[row]] = await db.query(
      'SELECT k.id, k.user_id, k.status FROM openclaw_api_keys k WHERE k.key_hash = ?',
      [keyHash]
    );

    if (!row) {
      return res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error' } });
    }
    if (row.status !== 'active') {
      return res.status(403).json({ error: { message: 'API key is disabled', type: 'invalid_request_error' } });
    }

    // 获取用户余额
    const [[quota]] = await db.query(
      'SELECT balance FROM user_quota WHERE user_id = ?',
      [row.user_id]
    );

    req.apiKeyId = row.id;
    req.apiUserId = row.user_id;
    req.userBalance = quota?.balance ?? 0;

    // 更新最后使用时间（异步，不阻塞）
    db.query('UPDATE openclaw_api_keys SET last_used_at = NOW() WHERE id = ?', [row.id]).catch(() => {});

    next();
  } catch (err) {
    console.error('API Key auth error:', err);
    return res.status(500).json({ error: { message: 'Internal server error', type: 'server_error' } });
  }
}

module.exports = { apiKeyAuth };
