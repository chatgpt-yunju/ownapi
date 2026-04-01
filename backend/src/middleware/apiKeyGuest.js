/**
 * API Key 游客认证中间件
 * 当用户未携带 JWT 但携带 X-OpenClaw-Api-Key 时，
 * 验证 API Key 有效性并将 key 拥有者设为 req.user
 */
const db = require('../config/db');
const crypto = require('crypto');
const { trackApiKeyLastUsed } = require('../plugins/ai-gateway/utils/lastUsedTracker');

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function apiKeyGuest(req, res, next) {
  // If already authenticated via JWT, skip
  if (req.headers.authorization) return next();

  const apiKey = req.headers['x-openclaw-api-key'];
  if (!apiKey) return next();

  try {
    const keyHash = hashApiKey(apiKey);
    const [[row]] = await db.query(
      'SELECT ak.user_id, ak.id as key_id FROM openclaw_api_keys ak WHERE ak.key_hash = ? AND ak.status = "active" LIMIT 1',
      [keyHash]
    );
    if (!row) return next();

    // Set req.user so downstream auth/verifyToken can use it
    req.user = { id: row.user_id, role: 'user' };
    req.apiKeyGuest = true;
    req.apiKeyId = row.key_id;

    trackApiKeyLastUsed(row.key_id).catch(() => {});
  } catch (err) {
    console.error('[apiKeyGuest] validation error:', err.message);
  }

  next();
}

module.exports = { apiKeyGuest };
