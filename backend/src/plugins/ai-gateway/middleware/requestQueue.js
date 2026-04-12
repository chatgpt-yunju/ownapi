'use strict';

const crypto = require('crypto');
const cache = require('../utils/cache');
const { logDebugStep } = require('../utils/requestDebug');
const { recordQueueSnapshot, recordQueueWait } = require('../utils/metrics');

const PRIORITY = {
  enterprise: 0,
  pro: 1,
  basic: 2,
  free: 3,
  guest: 4,
};

const DEFAULTS = {
  GLOBAL_MAX_INFLIGHT: 120,
  MODEL_MAX_INFLIGHT_DEFAULT: 30,
  DEEPSEEK_V32_MODEL_MAX_INFLIGHT: 50,
  DEEPSEEK_V32_MODEL_MAX_INFLIGHT_ENABLED: true,
  MAX_QUEUE_SIZE: 3000,
  WAIT_TIMEOUT_MS: 45000,
  POLL_INTERVAL_MS: 50,
  LEASE_TTL_MS: 180000,
  HEARTBEAT_INTERVAL_MS: 15000,
};

const REDIS_KEYS = {
  GLOBAL_ACTIVE: 'ai-gw:queue:active:global',
  WAITING: 'ai-gw:queue:waiting',
};

const WAITING_SCORE_BASE = 1e15;

let config = { ...DEFAULTS };
let modelInflightOverrides = {};

let getSettingCachedFn = null;
function getSettingFn() {
  if (!getSettingCachedFn) {
    try {
      getSettingCachedFn = require('../../../routes/quota').getSettingCached;
    } catch {
      getSettingCachedFn = async (_key, def) => def;
    }
  }
  return getSettingCachedFn;
}

function getPriority(req) {
  const type = req.userPackageType || 'guest';
  return PRIORITY[type] ?? PRIORITY.guest;
}

function isTargetRoute(req) {
  if (req.method !== 'POST') return false;
  const path = req.path || '';
  const isGemini = path.includes(':generateContent') || path.includes(':streamGenerateContent');
  return (
    path.endsWith('/chat/completions') ||
    path.endsWith('/embeddings') ||
    path.endsWith('/messages') ||
    path.endsWith('/responses') ||
    isGemini
  );
}

function normalizeModelKey(model) {
  if (!model) return 'unknown';
  return encodeURIComponent(String(model).slice(0, 160));
}

function isDeepseekV32Model(model) {
  const normalized = String(model || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return normalized.includes('deepseekv32') || normalized.includes('deepseekv3251201');
}

function getModelActiveKey(model) {
  return `ai-gw:queue:active:model:${normalizeModelKey(model)}`;
}

function getModelInflightLimit(model) {
  if (config.DEEPSEEK_V32_MODEL_MAX_INFLIGHT_ENABLED && isDeepseekV32Model(model)) {
    return Math.max(1, Number(config.DEEPSEEK_V32_MODEL_MAX_INFLIGHT) || DEFAULTS.DEEPSEEK_V32_MODEL_MAX_INFLIGHT);
  }
  return modelInflightOverrides[normalizeModelKey(model)] || config.MODEL_MAX_INFLIGHT_DEFAULT;
}

function buildWaitingScore(priority, enqueuedAt) {
  return priority * WAITING_SCORE_BASE + enqueuedAt;
}

async function debugQueueStep(req, status, detail = {}, extra = {}) {
  if (!req?.aiGatewayRequestId) return;
  await logDebugStep({
    requestId: req.aiGatewayRequestId,
    traceType: req.aiGatewayTraceType || 'live',
    routeName: req.aiGatewayRouteName,
    requestPath: req.originalUrl,
    model: req.aiGatewayRequestedModel || req.body?.model || null,
    userId: req.apiUserId || null,
    apiKeyId: req.apiKeyId || null,
    stepNo: 4,
    status,
    detail,
    errorMessage: extra.errorMessage,
  });
}

async function getSettingWithFallback(primaryKey, fallbackKey, defaultValue) {
  const getSettingCached = getSettingFn();
  const primary = await getSettingCached(primaryKey, '');
  if (String(primary || '').trim()) return primary;
  if (!fallbackKey) return defaultValue;
  return getSettingCached(fallbackKey, defaultValue);
}

async function refreshConfig() {
  try {
    const [globalInflight, modelInflight, queueSize, waitTimeoutMs, pollIntervalMs, overridesRaw, deepseekInflightRaw, deepseekEnabledRaw] = await Promise.all([
      getSettingWithFallback('gateway_global_max_inflight', 'queue_max_concurrent', String(DEFAULTS.GLOBAL_MAX_INFLIGHT)),
      getSettingWithFallback('gateway_model_max_inflight_default', null, String(DEFAULTS.MODEL_MAX_INFLIGHT_DEFAULT)),
      getSettingWithFallback('gateway_queue_max_size', 'queue_max_size', String(DEFAULTS.MAX_QUEUE_SIZE)),
      getSettingWithFallback('gateway_queue_wait_timeout_ms', 'queue_wait_timeout_ms', String(DEFAULTS.WAIT_TIMEOUT_MS)),
      getSettingWithFallback('gateway_queue_poll_interval_ms', null, String(DEFAULTS.POLL_INTERVAL_MS)),
      getSettingWithFallback('gateway_model_max_inflight_overrides', null, ''),
      getSettingWithFallback('gateway_model_max_inflight_deepseek_v32', null, String(DEFAULTS.DEEPSEEK_V32_MODEL_MAX_INFLIGHT)),
      getSettingWithFallback('gateway_model_max_inflight_deepseek_v32_enabled', null, String(DEFAULTS.DEEPSEEK_V32_MODEL_MAX_INFLIGHT_ENABLED)),
    ]);

    let parsedOverrides = {};
    if (String(overridesRaw || '').trim()) {
      try {
        const parsed = JSON.parse(overridesRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          parsedOverrides = Object.fromEntries(
            Object.entries(parsed)
              .map(([key, value]) => [normalizeModelKey(key), Math.max(1, parseInt(value, 10) || 0)])
              .filter(([, value]) => value > 0)
          );
        }
      } catch {
        parsedOverrides = {};
      }
    }

    config = {
      ...config,
      GLOBAL_MAX_INFLIGHT: Math.max(1, parseInt(globalInflight, 10) || DEFAULTS.GLOBAL_MAX_INFLIGHT),
      MODEL_MAX_INFLIGHT_DEFAULT: Math.max(1, parseInt(modelInflight, 10) || DEFAULTS.MODEL_MAX_INFLIGHT_DEFAULT),
      DEEPSEEK_V32_MODEL_MAX_INFLIGHT: Math.max(1, parseInt(deepseekInflightRaw, 10) || DEFAULTS.DEEPSEEK_V32_MODEL_MAX_INFLIGHT),
      DEEPSEEK_V32_MODEL_MAX_INFLIGHT_ENABLED: String(deepseekEnabledRaw).trim().toLowerCase() !== 'false',
      MAX_QUEUE_SIZE: Math.max(0, parseInt(queueSize, 10) || DEFAULTS.MAX_QUEUE_SIZE),
      WAIT_TIMEOUT_MS: Math.max(1000, parseInt(waitTimeoutMs, 10) || DEFAULTS.WAIT_TIMEOUT_MS),
      POLL_INTERVAL_MS: Math.max(10, parseInt(pollIntervalMs, 10) || DEFAULTS.POLL_INTERVAL_MS),
    };
    modelInflightOverrides = parsedOverrides;
  } catch {
    // Keep the previous config.
  }
}

refreshConfig();
setInterval(refreshConfig, 5 * 60 * 1000).unref();

const tryAcquireScript = `
local globalKey = KEYS[1]
local waitingKey = KEYS[2]
local modelKey = KEYS[3]

local nowMs = tonumber(ARGV[1])
local leaseTtlMs = tonumber(ARGV[2])
local token = ARGV[3]
local waitingScore = tonumber(ARGV[4])
local maxGlobal = tonumber(ARGV[5])
local maxModel = tonumber(ARGV[6])
local maxQueueSize = tonumber(ARGV[7])

redis.call('ZREMRANGEBYSCORE', globalKey, '-inf', nowMs - leaseTtlMs)
if modelKey ~= '' then
  redis.call('ZREMRANGEBYSCORE', modelKey, '-inf', nowMs - leaseTtlMs)
end

local activeCount = redis.call('ZCARD', globalKey)
local modelCount = 0
if modelKey ~= '' then
  modelCount = redis.call('ZCARD', modelKey)
end

local existing = redis.call('ZSCORE', waitingKey, token)
local waitingCount = redis.call('ZCARD', waitingKey)
if not existing then
  if waitingCount >= maxQueueSize and not (activeCount < maxGlobal and modelCount < maxModel and waitingCount == 0) then
    return {-1, activeCount, waitingCount, modelCount, -1}
  end
  redis.call('ZADD', waitingKey, 'NX', waitingScore, token)
  waitingCount = waitingCount + 1
end

local rank = redis.call('ZRANK', waitingKey, token)
if activeCount < maxGlobal and modelCount < maxModel and rank == 0 then
  redis.call('ZREM', waitingKey, token)
  redis.call('ZADD', globalKey, nowMs, token)
  if modelKey ~= '' then
    redis.call('ZADD', modelKey, nowMs, token)
  end
  return {1, activeCount + 1, math.max(waitingCount - 1, 0), modelCount + 1, rank}
end

return {0, activeCount, waitingCount, modelCount, rank or -1}
`;

const heartbeatScript = `
local globalKey = KEYS[1]
local modelKey = KEYS[2]
local token = ARGV[1]
local nowMs = tonumber(ARGV[2])

if redis.call('ZSCORE', globalKey, token) then
  redis.call('ZADD', globalKey, 'XX', nowMs, token)
end
if modelKey ~= '' and redis.call('ZSCORE', modelKey, token) then
  redis.call('ZADD', modelKey, 'XX', nowMs, token)
end
return 1
`;

const releaseScript = `
local globalKey = KEYS[1]
local waitingKey = KEYS[2]
local modelKey = KEYS[3]
local token = ARGV[1]

redis.call('ZREM', globalKey, token)
redis.call('ZREM', waitingKey, token)
if modelKey ~= '' then
  redis.call('ZREM', modelKey, token)
end
return 1
`;

async function tryAcquireRedisSlot(token, model, priority, enqueuedAt) {
  const modelKey = getModelActiveKey(model);
  const modelLimit = getModelInflightLimit(model);
  const result = await cache.redis.eval(
    tryAcquireScript,
    3,
    REDIS_KEYS.GLOBAL_ACTIVE,
    REDIS_KEYS.WAITING,
    modelKey,
    Date.now(),
    config.LEASE_TTL_MS,
    token,
    buildWaitingScore(priority, enqueuedAt),
    config.GLOBAL_MAX_INFLIGHT,
    modelLimit,
    config.MAX_QUEUE_SIZE
  );

  return {
    state: Number(result[0]),
    activeCount: Number(result[1]),
    waitingCount: Number(result[2]),
    modelCount: Number(result[3]),
    rank: Number(result[4]),
    modelKey,
    modelLimit,
  };
}

async function releaseRedisSlot(token, modelKey) {
  if (!cache.redis || cache.redis.status !== 'ready') return;
  await cache.redis.eval(
    releaseScript,
    3,
    REDIS_KEYS.GLOBAL_ACTIVE,
    REDIS_KEYS.WAITING,
    modelKey || '',
    token
  ).catch(() => {});
}

function startRedisHeartbeat(token, modelKey) {
  if (!cache.redis || cache.redis.status !== 'ready') return null;
  return setInterval(() => {
    cache.redis.eval(
      heartbeatScript,
      2,
      REDIS_KEYS.GLOBAL_ACTIVE,
      modelKey || '',
      token,
      Date.now()
    ).catch(() => {});
  }, config.HEARTBEAT_INTERVAL_MS).unref();
}

async function getRedisPriorityBreakdown() {
  const counts = {};
  for (const [label, priority] of Object.entries(PRIORITY)) {
    const min = priority * WAITING_SCORE_BASE;
    const max = ((priority + 1) * WAITING_SCORE_BASE) - 1;
    counts[label] = Number(await cache.redis.zcount(REDIS_KEYS.WAITING, min, max).catch(() => 0));
  }
  return counts;
}

async function getRedisQueueStats() {
  const [activeCount, waitingCount, priorityBreakdown] = await Promise.all([
    cache.redis.zcard(REDIS_KEYS.GLOBAL_ACTIVE).catch(() => 0),
    cache.redis.zcard(REDIS_KEYS.WAITING).catch(() => 0),
    getRedisPriorityBreakdown(),
  ]);

  const snapshot = {
    activeCount: Number(activeCount),
    waitingCount: Number(waitingCount),
    maxConcurrent: config.GLOBAL_MAX_INFLIGHT,
    maxQueueSize: config.MAX_QUEUE_SIZE,
    waitTimeoutMs: config.WAIT_TIMEOUT_MS,
    mode: 'redis',
    priorityBreakdown,
  };
  recordQueueSnapshot(snapshot);
  return snapshot;
}

let memoryActiveCount = 0;
const memoryWaitingQueue = [];
const memoryReleased = new WeakSet();

function scheduleMemoryNext() {
  while (memoryActiveCount < config.GLOBAL_MAX_INFLIGHT && memoryWaitingQueue.length > 0) {
    const item = memoryWaitingQueue.shift();
    if (item.aborted) continue;
    memoryActiveCount += 1;
    item.resolve();
  }
}

function releaseMemorySlot() {
  if (memoryReleased.has(this)) return;
  memoryReleased.add(this);
  memoryActiveCount = Math.max(0, memoryActiveCount - 1);
  setImmediate(scheduleMemoryNext);
  recordQueueSnapshot({
    activeCount: memoryActiveCount,
    waitingCount: memoryWaitingQueue.length,
    maxConcurrent: config.GLOBAL_MAX_INFLIGHT,
    maxQueueSize: config.MAX_QUEUE_SIZE,
    waitTimeoutMs: config.WAIT_TIMEOUT_MS,
    mode: 'memory',
  });
}

async function handleMemoryQueue(req, res, next) {
  if (memoryActiveCount < config.GLOBAL_MAX_INFLIGHT) {
    memoryActiveCount += 1;
    recordQueueSnapshot({
      activeCount: memoryActiveCount,
      waitingCount: memoryWaitingQueue.length,
      maxConcurrent: config.GLOBAL_MAX_INFLIGHT,
      maxQueueSize: config.MAX_QUEUE_SIZE,
      waitTimeoutMs: config.WAIT_TIMEOUT_MS,
      mode: 'memory',
    });
    recordQueueWait(0, false);
    await debugQueueStep(req, 'success', {
      queued: false,
      active_count: memoryActiveCount,
      waiting_count: memoryWaitingQueue.length,
      max_concurrent: config.GLOBAL_MAX_INFLIGHT,
      mode: 'memory',
    });
    res.setHeader('X-Queue-Wait-Ms', '0');
    req.aiGatewayQueueWaitMs = 0;
    res.on('finish', releaseMemorySlot);
    res.on('close', releaseMemorySlot);
    return next();
  }

  if (memoryWaitingQueue.length >= config.MAX_QUEUE_SIZE) {
    await debugQueueStep(req, 'error', {
      queued: false,
      active_count: memoryActiveCount,
      waiting_count: memoryWaitingQueue.length,
      max_queue_size: config.MAX_QUEUE_SIZE,
      mode: 'memory',
    }, { errorMessage: '服务器繁忙，请稍后重试（队列已满）' });
    return res.status(503).json({
      error: {
        message: '服务器繁忙，请稍后重试（队列已满）',
        type: 'overloaded_error',
        queue_depth: memoryWaitingQueue.length,
        retry_after: 5,
      }
    });
  }

  const priority = getPriority(req);
  const enqueuedAt = Date.now();
  let aborted = false;
  let timeoutHandle;

  await new Promise((resolve, reject) => {
    const item = {
      priority,
      enqueuedAt,
      resolve,
      reject,
      get aborted() { return aborted; },
    };

    let insertAt = memoryWaitingQueue.length;
    for (let i = 0; i < memoryWaitingQueue.length; i++) {
      if (
        priority < memoryWaitingQueue[i].priority ||
        (priority === memoryWaitingQueue[i].priority && enqueuedAt < memoryWaitingQueue[i].enqueuedAt)
      ) {
        insertAt = i;
        break;
      }
    }
    memoryWaitingQueue.splice(insertAt, 0, item);
    recordQueueSnapshot({
      activeCount: memoryActiveCount,
      waitingCount: memoryWaitingQueue.length,
      maxConcurrent: config.GLOBAL_MAX_INFLIGHT,
      maxQueueSize: config.MAX_QUEUE_SIZE,
      waitTimeoutMs: config.WAIT_TIMEOUT_MS,
      mode: 'memory',
    });
    debugQueueStep(req, 'pending', {
      queued: true,
      priority,
      enqueued_at: enqueuedAt,
      waiting_count: memoryWaitingQueue.length,
      active_count: memoryActiveCount,
      mode: 'memory',
    }).catch(() => {});

    timeoutHandle = setTimeout(() => {
      aborted = true;
      const index = memoryWaitingQueue.indexOf(item);
      if (index !== -1) memoryWaitingQueue.splice(index, 1);
      reject(new Error('QUEUE_TIMEOUT'));
    }, config.WAIT_TIMEOUT_MS);

    req.on('close', () => {
      aborted = true;
      clearTimeout(timeoutHandle);
      const index = memoryWaitingQueue.indexOf(item);
      if (index !== -1) memoryWaitingQueue.splice(index, 1);
      reject(new Error('QUEUE_ABORTED'));
    });
  }).then(async () => {
    clearTimeout(timeoutHandle);
    const waitMs = Date.now() - enqueuedAt;
    recordQueueWait(waitMs, true);
    await debugQueueStep(req, 'success', {
      queued: true,
      priority,
      wait_ms: waitMs,
      active_count: memoryActiveCount,
      waiting_count: memoryWaitingQueue.length,
      mode: 'memory',
    });
    res.setHeader('X-Queue-Wait-Ms', String(waitMs));
    req.aiGatewayQueueWaitMs = waitMs;
    res.on('finish', releaseMemorySlot);
    res.on('close', releaseMemorySlot);
    next();
  }).catch(async (error) => {
    if (error.message === 'QUEUE_ABORTED') return;
    if (error.message !== 'QUEUE_TIMEOUT') return next(error);
    const waitMs = Date.now() - enqueuedAt;
    await debugQueueStep(req, 'error', {
      queued: true,
      priority,
      wait_ms: waitMs,
      waiting_count: memoryWaitingQueue.length,
      timeout_ms: config.WAIT_TIMEOUT_MS,
      mode: 'memory',
    }, { errorMessage: '请求排队超时' });
    res.status(503).json({
      error: {
        message: `请求排队超时（超过 ${Math.round(config.WAIT_TIMEOUT_MS / 1000)} 秒），请稍后重试`,
        type: 'overloaded_error',
        retry_after: Math.ceil(config.WAIT_TIMEOUT_MS / 1000),
      }
    });
  });
}

async function handleRedisQueue(req, res, next) {
  const model = req.aiGatewayRequestedModel || req.body?.model || 'unknown';
  const token = req.aiGatewayRequestId || `queue_${crypto.randomBytes(8).toString('hex')}`;
  const priority = getPriority(req);
  const enqueuedAt = Date.now();
  let aborted = false;
  let heartbeat = null;
  let acquired = false;
  let modelKey = getModelActiveKey(model);
  let initialPosition = null;
  let queued = false;

  const onClose = () => {
    aborted = true;
    if (!acquired) {
      releaseRedisSlot(token, modelKey).catch(() => {});
    }
  };

  req.on('close', onClose);

  try {
    while (!aborted) {
      const result = await tryAcquireRedisSlot(token, model, priority, enqueuedAt);
      modelKey = result.modelKey;
      recordQueueSnapshot({
        activeCount: result.activeCount,
        waitingCount: result.waitingCount,
        maxConcurrent: config.GLOBAL_MAX_INFLIGHT,
        maxQueueSize: config.MAX_QUEUE_SIZE,
        waitTimeoutMs: config.WAIT_TIMEOUT_MS,
        mode: 'redis',
      });

      if (result.rank >= 0 && initialPosition === null) {
        initialPosition = result.rank + 1;
      }

      if (result.state === -1) {
        await debugQueueStep(req, 'error', {
          queued: false,
          active_count: result.activeCount,
          waiting_count: result.waitingCount,
          max_queue_size: config.MAX_QUEUE_SIZE,
          mode: 'redis',
        }, { errorMessage: '服务器繁忙，请稍后重试（队列已满）' });
        return res.status(503).json({
          error: {
            message: '服务器繁忙，请稍后重试（队列已满）',
            type: 'overloaded_error',
            queue_depth: result.waitingCount,
            retry_after: 5,
          }
        });
      }

      if (result.state === 1) {
        acquired = true;
        const waitMs = Date.now() - enqueuedAt;
        recordQueueWait(waitMs, queued);
        await debugQueueStep(req, 'success', {
          queued,
          priority,
          wait_ms: waitMs,
          active_count: result.activeCount,
          waiting_count: result.waitingCount,
          max_concurrent: config.GLOBAL_MAX_INFLIGHT,
          model_max_inflight: result.modelLimit,
          mode: 'redis',
        });
        res.setHeader('X-Queue-Wait-Ms', String(waitMs));
        if (queued && initialPosition) {
          res.setHeader('X-Queue-Position', String(initialPosition));
        }
        req.aiGatewayQueueWaitMs = waitMs;
        req.aiGatewayQueueInitialPosition = initialPosition;
        req.aiGatewayQueueModelLimit = result.modelLimit;

        heartbeat = startRedisHeartbeat(token, modelKey);
        const release = () => {
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = null;
          releaseRedisSlot(token, modelKey).catch(() => {});
        };
        res.on('finish', release);
        res.on('close', release);
        return next();
      }

      if (!queued) {
        queued = true;
        await debugQueueStep(req, 'pending', {
          queued: true,
          priority,
          enqueued_at: enqueuedAt,
          waiting_count: result.waitingCount,
          active_count: result.activeCount,
          position: initialPosition,
          model_max_inflight: result.modelLimit,
          mode: 'redis',
        });
      }

      if ((Date.now() - enqueuedAt) >= config.WAIT_TIMEOUT_MS) {
        await releaseRedisSlot(token, modelKey);
        const waitMs = Date.now() - enqueuedAt;
        await debugQueueStep(req, 'error', {
          queued: true,
          priority,
          wait_ms: waitMs,
          waiting_count: result.waitingCount,
          timeout_ms: config.WAIT_TIMEOUT_MS,
          mode: 'redis',
        }, { errorMessage: '请求排队超时' });
        return res.status(503).json({
          error: {
            message: `请求排队超时（超过 ${Math.round(config.WAIT_TIMEOUT_MS / 1000)} 秒），请稍后重试`,
            type: 'overloaded_error',
            retry_after: Math.ceil(config.WAIT_TIMEOUT_MS / 1000),
          }
        });
      }

      await new Promise((resolve) => setTimeout(resolve, config.POLL_INTERVAL_MS));
    }
  } catch (error) {
    await releaseRedisSlot(token, modelKey);
    return next(error);
  } finally {
    req.off('close', onClose);
  }
}

async function requestQueueMiddleware(req, res, next) {
  if (req._queueChecked) return next();
  if (!isTargetRoute(req)) return next();
  req._queueChecked = true;

  if (cache.redis && cache.redis.status === 'ready') {
    return handleRedisQueue(req, res, next);
  }
  return handleMemoryQueue(req, res, next);
}

async function getQueueStats() {
  if (cache.redis && cache.redis.status === 'ready') {
    return getRedisQueueStats();
  }

  const priorityBreakdown = {};
  for (const item of memoryWaitingQueue) {
    const label = Object.keys(PRIORITY).find((key) => PRIORITY[key] === item.priority) || 'unknown';
    priorityBreakdown[label] = (priorityBreakdown[label] || 0) + 1;
  }

  const snapshot = {
    activeCount: memoryActiveCount,
    waitingCount: memoryWaitingQueue.length,
    maxConcurrent: config.GLOBAL_MAX_INFLIGHT,
    maxQueueSize: config.MAX_QUEUE_SIZE,
    waitTimeoutMs: config.WAIT_TIMEOUT_MS,
    mode: 'memory',
    priorityBreakdown,
  };
  recordQueueSnapshot(snapshot);
  return snapshot;
}

module.exports = {
  requestQueueMiddleware,
  getQueueStats,
  refreshConfig,
};
