const db = require('../config/db');
const crypto = require('crypto');
const { generateApiKey, hashApiKey, maskApiKey } = require('../utils/crypto');

// ── 速率限制：10 次/分钟（Free 套餐及无套餐用户）──────────────────────────
const rateLimitMap = new Map(); // userId -> [timestamps]
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 1000;

// 每 5 分钟清理过期记录
setInterval(() => {
  const now = Date.now();
  for (const [uid, times] of rateLimitMap) {
    const recent = times.filter(t => now - t < RATE_WINDOW_MS);
    if (recent.length === 0) rateLimitMap.delete(uid);
    else rateLimitMap.set(uid, recent);
  }
}, 5 * 60 * 1000);

function checkRateLimit(userId, packageType) {
  // 付费套餐不限速
  if (packageType && packageType !== 'free') return true;
  const now = Date.now();
  const times = rateLimitMap.get(userId) || [];
  const recent = times.filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  rateLimitMap.set(userId, recent);
  return true;
}

// ── 查询用户套餐 ────────────────────────────────────────────────────────────
async function getUserPackage(userId) {
  const [[userPkg]] = await db.query(
    `SELECT p.models_allowed, p.type FROM openclaw_user_packages up
     JOIN openclaw_packages p ON up.package_id = p.id
     WHERE up.user_id = ? AND up.status = 'active' AND (up.expires_at IS NULL OR up.expires_at > NOW())
     ORDER BY up.started_at DESC LIMIT 1`,
    [userId]
  );
  return userPkg || null;
}

// ── 确保 openclaw_quota 记录存在，新用户自动发放 Free 套餐 ─────────────────
async function ensureQuota(userId) {
  await db.query(
    'INSERT INTO openclaw_quota (user_id, balance) VALUES (?, 0) ON DUPLICATE KEY UPDATE user_id = user_id',
    [userId]
  );

  const [[quota]] = await db.query('SELECT balance FROM openclaw_quota WHERE user_id = ?', [userId]);
  const balance = Number(quota?.balance || 0);

  if (balance > 0) return balance;

  // 余额为 0，检查是否已领取过 Free 套餐
  const [[freePkg]] = await db.query(
    'SELECT * FROM openclaw_packages WHERE type = "free" AND status = "active" LIMIT 1'
  );
  if (!freePkg) return 0;

  const [[recentGrant]] = await db.query(
    'SELECT id FROM openclaw_user_packages WHERE user_id = ? AND package_id = ? AND started_at > DATE_SUB(NOW(), INTERVAL 30 DAY) LIMIT 1',
    [userId, freePkg.id]
  );
  if (recentGrant) return 0; // 已领取过，不重复发放

  // 自动发放 Free 套餐：$1 配额 + 30天有效期
  const monthlyQuota = Number(freePkg.monthly_quota);
  if (monthlyQuota <= 0) return 0;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'INSERT INTO openclaw_user_packages (user_id, package_id, started_at, expires_at, status) VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY), "active")',
      [userId, freePkg.id]
    );
    await conn.query('UPDATE openclaw_quota SET balance = ? WHERE user_id = ?', [monthlyQuota, userId]);
    await conn.query(
      'INSERT INTO balance_logs (user_id, amount, balance_before, balance_after, type, description) VALUES (?, ?, 0, ?, "recharge", ?)',
      [userId, monthlyQuota, monthlyQuota, `自动发放 ${freePkg.name} 套餐配额（注册赠送 $${monthlyQuota}，30天有效）`]
    );
    await conn.commit();
    return monthlyQuota;
  } catch (err) {
    await conn.rollback();
    console.error('Auto grant free quota error:', err);
    return 0;
  } finally {
    conn.release();
  }
}

// ── API Key 鉴权中间件 ──────────────────────────────────────────────────────
async function apiKeyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const xApiKey = req.headers['x-api-key'];

  let token;
  if (authHeader?.startsWith('Bearer ')) token = authHeader.slice(7);
  else if (xApiKey) token = xApiKey;

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
      const userPkg = await getUserPackage(userInfo.id);

      if (!checkRateLimit(userInfo.id, userPkg?.type)) {
        return res.status(429).json({ error: { message: '请求过于频繁，Free 套餐限制 10 次/分钟', type: 'rate_limit_error' } });
      }

      req.apiKeyId = null;
      req.apiUserId = userInfo.id;
      req.userBalance = balance;
      req.userPackageType = userPkg?.type || 'free';
      req.userModelsAllowed = userPkg?.models_allowed || null;
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
    const userPkg = await getUserPackage(row.user_id);

    if (!checkRateLimit(row.user_id, userPkg?.type)) {
      return res.status(429).json({ error: { message: '请求过于频繁，Free 套餐限制 10 次/分钟', type: 'rate_limit_error' } });
    }

    req.apiKeyId = row.id;
    req.apiUserId = row.user_id;
    req.userBalance = balance;
    req.userPackageType = userPkg?.type || 'free';
    req.userModelsAllowed = userPkg?.models_allowed || null;

    db.query('UPDATE openclaw_api_keys SET last_used_at = NOW() WHERE id = ?', [row.id]).catch(() => {});
    next();
  } catch (err) {
    console.error('API Key auth error:', err);
    return res.status(500).json({ error: { message: 'Internal server error', type: 'server_error' } });
  }
}

module.exports = { apiKeyAuth, ensureQuota };
