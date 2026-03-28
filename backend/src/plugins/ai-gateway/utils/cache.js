/**
 * Redis TTL 缓存（多进程共享）
 * 回退策略：Redis 不可用时自动降级为内存缓存，保证服务不中断
 */

const Redis = require('ioredis');

// ── Redis 客户端 ─────────────────────────────────────────────────────────────
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redis = new Redis(redisUrl, {
  enableOfflineQueue: false,      // Redis 断开时不积压请求，直接报错触发降级
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  connectTimeout: 2000,
});

let redisAvailable = false;
redis.connect().then(() => {
  redisAvailable = true;
  console.log('[cache] Redis connected');
}).catch(() => {
  console.warn('[cache] Redis unavailable, falling back to in-memory cache');
});
redis.on('error', () => { redisAvailable = false; });
redis.on('connect', () => { redisAvailable = true; });

// ── 内存降级缓存 ──────────────────────────────────────────────────────────────
const memStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memStore) {
    if (now > v.expireAt) memStore.delete(k);
  }
}, 60 * 1000);

function memGet(key) {
  const entry = memStore.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expireAt) { memStore.delete(key); return undefined; }
  return entry.value;
}
function memSet(key, value, ttlMs) {
  memStore.set(key, { value, expireAt: Date.now() + ttlMs });
}

// ── 公共接口 ─────────────────────────────────────────────────────────────────
const DEFAULT_TTL = 5 * 60 * 1000;

async function get(key) {
  if (redisAvailable) {
    try {
      const val = await redis.get(key);
      return val !== null ? JSON.parse(val) : undefined;
    } catch { /* 降级 */ }
  }
  return memGet(key);
}

async function set(key, value, ttlMs = DEFAULT_TTL) {
  if (redisAvailable) {
    try {
      await redis.set(key, JSON.stringify(value), 'PX', ttlMs);
      return;
    } catch { /* 降级 */ }
  }
  memSet(key, value, ttlMs);
}

async function del(key) {
  if (redisAvailable) {
    try { await redis.del(key); } catch { /* 降级 */ }
  }
  memStore.delete(key);
}

async function delByPrefix(prefix) {
  if (redisAvailable) {
    try {
      // 使用 SCAN 避免阻塞（比 KEYS * 安全）
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== '0');
      return;
    } catch { /* 降级 */ }
  }
  for (const k of memStore.keys()) {
    if (k.startsWith(prefix)) memStore.delete(k);
  }
}

module.exports = { get, set, del, delByPrefix, redis };
