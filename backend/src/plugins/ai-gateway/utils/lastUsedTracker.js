const db = require('../../../config/db');
const cache = require('./cache');

const FLUSH_INTERVAL_MS = Math.max(5000, parseInt(process.env.API_KEY_LAST_USED_FLUSH_INTERVAL_MS, 10) || 5000);
const THROTTLE_WINDOW_MS = Math.max(60000, parseInt(process.env.API_KEY_LAST_USED_THROTTLE_MS, 10) || 5 * 60 * 1000);
const pending = new Map();

function shouldWriteWithMemory(keyId, now) {
  const existing = pending.get(keyId);
  if (existing && (now - existing.ts) < THROTTLE_WINDOW_MS) {
    return false;
  }
  pending.set(keyId, { ts: now });
  return true;
}

async function shouldWriteWithRedis(keyId, now) {
  if (!cache.redis || cache.redis.status !== 'ready') {
    return shouldWriteWithMemory(keyId, now);
  }

  try {
    const result = await cache.redis.set(
      `ai-gw:last-used:${keyId}`,
      String(now),
      'PX',
      THROTTLE_WINDOW_MS,
      'NX'
    );
    if (result !== 'OK') return false;
    pending.set(keyId, { ts: now });
    return true;
  } catch {
    return shouldWriteWithMemory(keyId, now);
  }
}

async function trackApiKeyLastUsed(keyId) {
  if (!keyId) return false;
  return shouldWriteWithRedis(Number(keyId), Date.now());
}

async function flushPending() {
  if (pending.size === 0) return;

  const entries = Array.from(pending.entries());
  pending.clear();

  await Promise.all(entries.map(async ([keyId, meta]) => {
    try {
      await db.query(
        'UPDATE openclaw_api_keys SET last_used_at = FROM_UNIXTIME(? / 1000) WHERE id = ?',
        [meta.ts, keyId]
      );
    } catch (error) {
      console.error('[last-used] flush failed:', error.message);
      pending.set(keyId, meta);
    }
  }));
}

setInterval(() => {
  flushPending().catch((error) => console.error('[last-used] flush timer failed:', error.message));
}, FLUSH_INTERVAL_MS).unref();

module.exports = {
  flushPending,
  trackApiKeyLastUsed,
};
