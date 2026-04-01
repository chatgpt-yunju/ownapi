const db = require('../../../config/db');
const crypto = require('crypto');
const { generateApiKey, hashApiKey, maskApiKey } = require('../utils/crypto');
const cache = require('../utils/cache');
const { logDebugStep } = require('../utils/requestDebug');
const {
  ensureQuotaBalance,
  ensureWalletBalance,
  adjustBalance,
} = require('../utils/billing');
const { validateSilentToken } = require('../../../services/ssoAuth');
const { trackApiKeyLastUsed } = require('../utils/lastUsedTracker');

const KEY_CACHE_TTL = 15 * 60 * 1000;  // API Key 缓存 15 分钟（含 user_status）
const PKG_CACHE_TTL = 10 * 60 * 1000;  // 用户套餐缓存 10 分钟
const QUOTA_CACHE_TTL = 10 * 60 * 1000; // 用户余额缓存 10 分钟
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;

// ── 速率限制：Redis Lua 原子操作（多进程共享）+ 内存降级 ─────────────────────
const rateLimitLua = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local current = redis.call('INCR', key)
if current == 1 then redis.call('PEXPIRE', key, window) end
return current
`;

// 内存降级备用
const rateLimitMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [uid, times] of rateLimitMap) {
    const recent = times.filter(t => now - t < RATE_WINDOW_MS);
    if (recent.length === 0) rateLimitMap.delete(uid);
    else rateLimitMap.set(uid, recent);
  }
}, 5 * 60 * 1000);

async function debugStep(req, stepNo, status, detail = {}, extra = {}) {
  if (!req?.aiGatewayRequestId) return;
  await logDebugStep({
    requestId: req.aiGatewayRequestId,
    traceType: req.aiGatewayTraceType || 'live',
    routeName: req.aiGatewayRouteName,
    requestPath: req.originalUrl,
    model: req.aiGatewayRequestedModel || req.body?.model || null,
    userId: req.apiUserId || null,
    apiKeyId: req.apiKeyId || null,
    stepNo,
    status,
    detail,
    errorMessage: extra.errorMessage,
  });
}

async function checkRateLimit(userId, packageType) {
  if (packageType && packageType !== 'free') return true;

  // 尝试 Redis 原子计数
  if (cache.redis && cache.redis.status === 'ready') {
    try {
      const count = await cache.redis.eval(rateLimitLua, 1, `rl:${userId}`, RATE_LIMIT, RATE_WINDOW_MS);
      return Number(count) <= RATE_LIMIT;
    } catch { /* 降级到内存 */ }
  }

  // 内存降级
  const now = Date.now();
  const times = rateLimitMap.get(userId) || [];
  const recent = times.filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  rateLimitMap.set(userId, recent);
  return true;
}

// ── 查询用户套餐（Redis 缓存 3 分钟）────────────────────────────────────────
async function getUserPackage(userId) {
  const cacheKey = `pkg:${userId}`;
  const cached = await cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const [[userPkg]] = await db.query(
    `SELECT p.models_allowed, p.type FROM openclaw_user_packages up
     JOIN openclaw_packages p ON up.package_id = p.id
     WHERE up.user_id = ? AND up.status = 'active' AND (up.expires_at IS NULL OR up.expires_at > NOW())
     ORDER BY up.started_at DESC LIMIT 1`,
    [userId]
  );
  const result = userPkg || null;
  await cache.set(cacheKey, result, PKG_CACHE_TTL);
  return result;
}

// ── 确保 openclaw_quota 记录存在，新用户自动发放 Free 套餐 ─────────────────
async function ensureQuota(userId) {
  await Promise.all([
    ensureQuotaBalance(userId),
    ensureWalletBalance(userId),
  ]);

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
  if (recentGrant) return 0;

  const monthlyQuota = Number(freePkg.monthly_quota);
  if (monthlyQuota <= 0) return 0;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'INSERT INTO openclaw_user_packages (user_id, package_id, started_at, expires_at, status) VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY), "active")',
      [userId, freePkg.id]
    );
    await adjustBalance(
      userId,
      'quota',
      monthlyQuota,
      'recharge',
      `自动发放 ${freePkg.name} 套餐配额（注册赠送 $${monthlyQuota}，30天有效）`,
      { source: 'auto_free_package', package_id: freePkg.id },
      conn
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

// ── 缓存版 ensureQuota：10 分钟缓存余额状态，避免每次请求都查 DB ─────────────
async function getQuotaBalanceCached(userId) {
  const cacheKey = `quota_status:${userId}`;
  const cached = await cache.get(cacheKey);
  if (cached !== undefined) return cached.balance;

  // 缓存未命中，执行原有逻辑
  const balance = await ensureQuota(userId);
  await cache.set(cacheKey, { balance }, QUOTA_CACHE_TTL);
  return balance;
}

// ── API Key 鉴权中间件 ──────────────────────────────────────────────────────
async function apiKeyAuth(req, res, next) {
  if (req._gatewayAuthDone) return next();
  const authHeader = req.headers.authorization;
  const xApiKey = req.headers['x-api-key'];
  const xGoogApiKey = req.headers['x-goog-api-key'];

  let token;
  if (authHeader?.startsWith('Bearer ')) token = authHeader.slice(7);
  else if (xApiKey) token = xApiKey;
  else if (xGoogApiKey) token = xGoogApiKey;

  if (!token) {
    await debugStep(req, 2, 'error', { reason: 'missing_authorization' }, { errorMessage: 'Missing authorization header' });
    return res.status(401).json({ error: { message: 'Missing authorization header', type: 'invalid_request_error' } });
  }

  // SSO Token 认证（Playground 调试用）
  if (!token.startsWith('sk-')) {
    try {
      const ssoResult = await validateSilentToken(token);
      if (!ssoResult.ok) {
        await debugStep(req, 2, 'error', { auth_mode: 'sso', reason: 'invalid_token' }, { errorMessage: 'Invalid API key or token' });
        return res.status(401).json({ error: { message: 'Invalid API key or token', type: 'invalid_request_error' } });
      }
      const userInfo = ssoResult.user;
      if (userInfo.status === 'banned') {
        await debugStep(req, 2, 'error', { auth_mode: 'sso', reason: 'user_banned', user_id: userInfo.id }, { errorMessage: '账号已被封禁' });
        return res.status(403).json({ error: { message: '账号已被封禁，请联系管理员', type: 'invalid_request_error' } });
      }
      const balance = await getQuotaBalanceCached(userInfo.id);
      const userPkg = await getUserPackage(userInfo.id);
      req.apiKeyId = null;
      req.apiUserId = userInfo.id;
      req.userBalance = balance;
      req.userPackageType = userPkg?.type || 'free';
      req.userModelsAllowed = userPkg?.models_allowed || null;

      await debugStep(req, 2, 'success', {
        auth_mode: 'sso',
        user_id: userInfo.id,
        package_type: req.userPackageType,
        balance
      });

      if (!await checkRateLimit(userInfo.id, userPkg?.type)) {
        await debugStep(req, 3, 'error', {
          package_type: userPkg?.type || 'free',
          window_ms: RATE_WINDOW_MS,
          limit: RATE_LIMIT
        }, { errorMessage: '请求过于频繁' });
        return res.status(429).json({ error: { message: '请求过于频繁，Free 套餐限制 30 次/分钟', type: 'rate_limit_error' } });
      }
      await debugStep(req, 3, userPkg?.type && userPkg.type !== 'free' ? 'skipped' : 'success', {
        package_type: req.userPackageType,
        window_ms: RATE_WINDOW_MS,
        limit: RATE_LIMIT,
        reason: userPkg?.type && userPkg.type !== 'free' ? 'non_free_package_bypass' : 'passed'
      });
      req._gatewayAuthDone = true;
      return next();
    } catch (err) {
      await debugStep(req, 2, 'error', { auth_mode: 'sso', reason: 'sso_validate_failed' }, { errorMessage: 'Invalid API key or token' });
      return res.status(401).json({ error: { message: 'Invalid API key or token', type: 'invalid_request_error' } });
    }
  }

  // API Key 认证（Redis 缓存 15 分钟，含 user_status）
  const keyHash = crypto.createHash('sha256').update(token).digest('hex');
  try {
    let row = await cache.get(`key:${keyHash}`);
    if (row === undefined) {
      // 单次 JOIN 查询，同时取 key 信息和用户封禁状态，避免后续额外查询
      const [[dbRow]] = await db.query(
        `SELECT k.id, k.user_id, k.status, u.status AS user_status
         FROM openclaw_api_keys k
         JOIN users u ON k.user_id = u.id
         WHERE k.key_hash = ? AND k.is_deleted = 0`,
        [keyHash]
      );
      row = dbRow || null;
      await cache.set(`key:${keyHash}`, row, KEY_CACHE_TTL);
    }
    if (!row) {
      await debugStep(req, 2, 'error', { auth_mode: 'api_key', reason: 'key_not_found' }, { errorMessage: 'Invalid API key' });
      return res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error' } });
    }
    if (row.status !== 'active') {
      await debugStep(req, 2, 'error', { auth_mode: 'api_key', reason: 'key_disabled', api_key_id: row.id, user_id: row.user_id }, { errorMessage: 'API key is disabled' });
      return res.status(403).json({ error: { message: 'API key is disabled', type: 'invalid_request_error' } });
    }

    // user_status 已缓存在 row 中，无需额外 DB 查询
    if (row.user_status === 'banned') {
      await debugStep(req, 2, 'error', { auth_mode: 'api_key', reason: 'user_banned', user_id: row.user_id }, { errorMessage: '账号已被封禁' });
      return res.status(403).json({ error: { message: '账号已被封禁，请联系管理员', type: 'invalid_request_error' } });
    }

    const balance = await getQuotaBalanceCached(row.user_id);
    const userPkg = await getUserPackage(row.user_id);
    req.apiKeyId = row.id;
    req.apiUserId = row.user_id;
    req.userBalance = balance;
    req.userPackageType = userPkg?.type || 'free';
    req.userModelsAllowed = userPkg?.models_allowed || null;

    await debugStep(req, 2, 'success', {
      auth_mode: 'api_key',
      api_key_id: row.id,
      user_id: row.user_id,
      package_type: req.userPackageType,
      balance
    });

    if (!await checkRateLimit(row.user_id, userPkg?.type)) {
      await debugStep(req, 3, 'error', {
        package_type: req.userPackageType,
        window_ms: RATE_WINDOW_MS,
        limit: RATE_LIMIT
      }, { errorMessage: '请求过于频繁' });
      return res.status(429).json({ error: { message: '请求过于频繁，Free 套餐限制 30 次/分钟', type: 'rate_limit_error' } });
    }

    await debugStep(req, 3, userPkg?.type && userPkg.type !== 'free' ? 'skipped' : 'success', {
      package_type: req.userPackageType,
      window_ms: RATE_WINDOW_MS,
      limit: RATE_LIMIT,
      reason: userPkg?.type && userPkg.type !== 'free' ? 'non_free_package_bypass' : 'passed'
    });

    trackApiKeyLastUsed(row.id).catch(() => {});
    req._gatewayAuthDone = true;
    next();
  } catch (err) {
    console.error('API Key auth error:', err);
    await debugStep(req, 2, 'error', { auth_mode: token.startsWith('sk-') ? 'api_key' : 'sso', reason: 'auth_internal_error' }, { errorMessage: err.message });
    return res.status(500).json({ error: { message: 'Internal server error', type: 'server_error' } });
  }
}

async function invalidateKeyCache(keyHash) {
  await cache.del(`key:${keyHash}`);
}

async function invalidateUserCache(userId) {
  await cache.del(`pkg:${userId}`);
}

module.exports = { apiKeyAuth, ensureQuota, invalidateKeyCache, invalidateUserCache };
