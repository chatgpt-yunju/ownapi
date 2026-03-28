/**
 * 内部服务认证中间件
 * 用于主后端等内部服务调用 api.yunjunet.cn 的 AI 接口
 * 通过 X-Internal-Secret + X-User-Id 鉴权，无需用户 API Key
 */
const db = require('../../../config/db');
const { ensureQuota } = require('./apiKeyAuth');

const RATE_LIMIT_INTERNAL = 30;
const RATE_WINDOW_MS = 60 * 1000;
const internalRateMap = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [uid, times] of internalRateMap) {
    const recent = times.filter(t => now - t < RATE_WINDOW_MS);
    if (recent.length === 0) internalRateMap.delete(uid);
    else internalRateMap.set(uid, recent);
  }
}, 5 * 60 * 1000);

function checkInternalRateLimit(userId) {
  const now = Date.now();
  const times = internalRateMap.get(userId) || [];
  const recent = times.filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_INTERNAL) return false;
  recent.push(now);
  internalRateMap.set(userId, recent);
  return true;
}

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

async function internalAuth(req, res, next) {
  const secret = req.headers['x-internal-secret'];
  const userId = req.headers['x-user-id'];

  const expectedSecret = process.env.INTERNAL_API_SECRET;
  if (!expectedSecret) {
    console.error('[internalAuth] INTERNAL_API_SECRET not configured');
    return res.status(500).json({
      error: { message: 'Internal API not configured', type: 'server_error' },
    });
  }

  if (!secret || secret !== expectedSecret) {
    return res.status(401).json({
      error: { message: 'Invalid internal secret', type: 'authentication_error' },
    });
  }

  if (!userId) {
    return res.status(400).json({
      error: { message: 'X-User-Id header is required', type: 'invalid_request_error' },
    });
  }

  const numericUserId = parseInt(userId, 10);
  if (isNaN(numericUserId) || numericUserId <= 0) {
    return res.status(400).json({
      error: { message: 'X-User-Id must be a positive integer', type: 'invalid_request_error' },
    });
  }

  if (!checkInternalRateLimit(numericUserId)) {
    return res.status(429).json({
      error: { message: '请求过于频繁，内部调用限制 30 次/分钟', type: 'rate_limit_error' },
    });
  }

  try {
    const balance = await ensureQuota(numericUserId);
    const userPkg = await getUserPackage(numericUserId);

    req.apiKeyId = null;
    req.apiUserId = numericUserId;
    req.userBalance = balance;
    req.userPackageType = userPkg?.type || 'free';
    req.userModelsAllowed = userPkg?.models_allowed || null;
    req.internalCall = true;

    next();
  } catch (err) {
    console.error('[internalAuth] Error:', err.message);
    return res.status(500).json({
      error: { message: 'Internal server error', type: 'server_error' },
    });
  }
}

module.exports = { internalAuth };
