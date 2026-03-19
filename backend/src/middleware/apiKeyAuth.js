const db = require('../config/db');
const crypto = require('crypto');
const { generateApiKey, hashApiKey, maskApiKey } = require('../utils/crypto');

// 确保 openclaw_quota 记录存在，余额为 0 时自动发放 Free 套餐配额
async function ensureQuota(userId) {
  await db.query(
    'INSERT INTO openclaw_quota (user_id, balance) VALUES (?, 0) ON DUPLICATE KEY UPDATE user_id = user_id',
    [userId]
  );

  const [[quota]] = await db.query('SELECT balance FROM openclaw_quota WHERE user_id = ?', [userId]);
  const balance = Number(quota?.balance || 0);

  if (balance > 0) return balance;

  // 余额为 0，检查是否有未过期的 Free 套餐（30天内已领取过）
  const [[freePkg]] = await db.query(
    'SELECT * FROM openclaw_packages WHERE type = "free" AND status = "active" LIMIT 1'
  );
  if (!freePkg) return 0;

  const [[recentGrant]] = await db.query(
    'SELECT id FROM openclaw_user_packages WHERE user_id = ? AND package_id = ? AND started_at > DATE_SUB(NOW(), INTERVAL 30 DAY) LIMIT 1',
    [userId, freePkg.id]
  );
  if (recentGrant) return 0; // 30天内已领取过，不重复发放

  // 发放 Free 套餐配额
  const monthlyQuota = Number(freePkg.monthly_quota);
  if (monthlyQuota <= 0) return 0;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      'INSERT INTO openclaw_user_packages (user_id, package_id, expires_at, status) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY), "active")',
      [userId, freePkg.id]
    );

    const newBalance = monthlyQuota;
    await conn.query('UPDATE openclaw_quota SET balance = ? WHERE user_id = ?', [newBalance, userId]);

    await conn.query(
      'INSERT INTO balance_logs (user_id, amount, balance_before, balance_after, type, description) VALUES (?, ?, 0, ?, "recharge", ?)',
      [userId, monthlyQuota, newBalance, `自动发放 ${freePkg.name} 套餐月度配额`]
    );

    await conn.commit();
    return newBalance;
  } catch (err) {
    await conn.rollback();
    console.error('Auto grant free quota error:', err);
    return 0;
  } finally {
    conn.release();
  }
}

// API Key 鉴权中间件 — 用于 /v1/ 路由
// 支持三种认证方式：Authorization: Bearer (OpenAI)、x-api-key (Anthropic)、SSO Token（Playground）
async function apiKeyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const xApiKey = req.headers['x-api-key'];

  let token;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (xApiKey) {
    token = xApiKey;
  }

  if (!token) {
    return res.status(401).json({ error: { message: 'Missing authorization header', type: 'invalid_request_error' } });
  }

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
      const balance = await ensureQuota(userInfo.id);
      req.apiKeyId = null;
      req.apiUserId = userInfo.id;
      req.userBalance = balance;
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

    const balance = await ensureQuota(row.user_id);
    req.apiKeyId = row.id;
    req.apiUserId = row.user_id;
    req.userBalance = balance;
  // 获取用户套餐的模型限制
  const [[userPkg]] = await db.query(
    `SELECT p.models_allowed, p.type FROM openclaw_user_packages up
     JOIN openclaw_packages p ON up.package_id = p.id
     WHERE up.user_id = ? AND up.status = 'active' AND (up.expires_at IS NULL OR up.expires_at > NOW())
     ORDER BY up.started_at DESC LIMIT 1`,
    [row.user_id]
  );
  req.userPackageType = userPkg?.type || 'free';
  req.userModelsAllowed = userPkg?.models_allowed || null;

    db.query('UPDATE openclaw_api_keys SET last_used_at = NOW() WHERE id = ?', [row.id]).catch(() => {});

    next();
  } catch (err) {
    console.error('API Key auth error:', err);
    return res.status(500).json({ error: { message: 'Internal server error', type: 'server_error' } });
  }
}

module.exports = { apiKeyAuth };
