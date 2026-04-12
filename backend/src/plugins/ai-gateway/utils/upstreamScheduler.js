const crypto = require('crypto');
const cache = require('./cache');

const DEFAULTS = {
  ENDPOINT_MAX_INFLIGHT: 10,
  LEASE_TTL_MS: 180000,
  FAILURE_THRESHOLD: 5,
  CIRCUIT_OPEN_MS: 60000,
  HEALTH_TTL_MS: 24 * 60 * 60 * 1000,
};

const memoryHealth = new Map();
const memoryLeases = new Map();

let config = { ...DEFAULTS };
let configLoadedAt = 0;
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

async function refreshConfig() {
  const now = Date.now();
  if ((now - configLoadedAt) < 60 * 1000) return config;

  try {
    const getSettingCached = getSettingFn();
    const [endpointMaxInflight, failureThreshold, circuitOpenMs] = await Promise.all([
      getSettingCached('gateway_endpoint_max_inflight_default', String(DEFAULTS.ENDPOINT_MAX_INFLIGHT)),
      getSettingCached('gateway_upstream_failure_threshold', String(DEFAULTS.FAILURE_THRESHOLD)),
      getSettingCached('gateway_upstream_circuit_open_ms', String(DEFAULTS.CIRCUIT_OPEN_MS)),
    ]);

    config = {
      ...config,
      ENDPOINT_MAX_INFLIGHT: Math.max(1, parseInt(endpointMaxInflight, 10) || DEFAULTS.ENDPOINT_MAX_INFLIGHT),
      FAILURE_THRESHOLD: Math.max(1, parseInt(failureThreshold, 10) || DEFAULTS.FAILURE_THRESHOLD),
      CIRCUIT_OPEN_MS: Math.max(1000, parseInt(circuitOpenMs, 10) || DEFAULTS.CIRCUIT_OPEN_MS),
    };
  } catch {
    // Keep previous config.
  }

  configLoadedAt = now;
  return config;
}

function stableHash(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 24);
}

function getEndpointIdentity(endpoint = {}) {
  if (endpoint.schedulerKey) return endpoint.schedulerKey;
  if (endpoint.id !== undefined && endpoint.id !== null && endpoint.id !== 0) {
    return `id:${endpoint.id}`;
  }
  return `hash:${stableHash([
    endpoint.provider_name || '',
    endpoint.base_url || '',
    endpoint.api_key || '',
    endpoint.upstream_model_id || '',
  ].join('|'))}`;
}

function getHealthKey(endpoint) {
  return `ai-gw:upstream:health:${getEndpointIdentity(endpoint)}`;
}

function getLeaseKey(endpoint) {
  return `ai-gw:upstream:lease:${getEndpointIdentity(endpoint)}`;
}

function normalizeSnapshot(raw = {}) {
  return {
    successCount: Number(raw.successCount || raw.success_count || 0),
    failureCount: Number(raw.failureCount || raw.failure_count || 0),
    rateLimitCount: Number(raw.rateLimitCount || raw.rate_limit_count || 0),
    serverErrorCount: Number(raw.serverErrorCount || raw.server_error_count || 0),
    timeoutCount: Number(raw.timeoutCount || raw.timeout_count || 0),
    consecutiveFailures: Number(raw.consecutiveFailures || raw.consecutive_failures || 0),
    circuitOpenUntil: Number(raw.circuitOpenUntil || raw.circuit_open_until || 0),
    latencyEwmaMs: Number(raw.latencyEwmaMs || raw.latency_ewma_ms || 0),
    successEwma: raw.successEwma !== undefined || raw.success_ewma !== undefined
      ? Number(raw.successEwma || raw.success_ewma || 0)
      : 1,
    lastStatusCode: raw.lastStatusCode || raw.last_status_code || null,
    lastError: raw.lastError || raw.last_error || null,
    updatedAt: Number(raw.updatedAt || raw.updated_at || 0),
    lastSuccessAt: Number(raw.lastSuccessAt || raw.last_success_at || 0),
    lastFailureAt: Number(raw.lastFailureAt || raw.last_failure_at || 0),
  };
}

function ewma(current, next, alpha = 0.25) {
  if (!Number.isFinite(current) || current <= 0) return next;
  return (current * (1 - alpha)) + (next * alpha);
}

async function getHealthSnapshot(endpoint) {
  const key = getHealthKey(endpoint);

  if (cache.redis && cache.redis.status === 'ready') {
    try {
      return normalizeSnapshot(await cache.redis.hgetall(key));
    } catch {
      // Fallback to memory.
    }
  }

  return normalizeSnapshot(memoryHealth.get(key));
}

async function setHealthSnapshot(endpoint, snapshot) {
  const key = getHealthKey(endpoint);
  const payload = {
    success_count: String(snapshot.successCount || 0),
    failure_count: String(snapshot.failureCount || 0),
    rate_limit_count: String(snapshot.rateLimitCount || 0),
    server_error_count: String(snapshot.serverErrorCount || 0),
    timeout_count: String(snapshot.timeoutCount || 0),
    consecutive_failures: String(snapshot.consecutiveFailures || 0),
    circuit_open_until: String(snapshot.circuitOpenUntil || 0),
    latency_ewma_ms: String(snapshot.latencyEwmaMs || 0),
    success_ewma: String(snapshot.successEwma || 0),
    last_status_code: snapshot.lastStatusCode === null || snapshot.lastStatusCode === undefined ? '' : String(snapshot.lastStatusCode),
    last_error: snapshot.lastError || '',
    updated_at: String(snapshot.updatedAt || Date.now()),
    last_success_at: String(snapshot.lastSuccessAt || 0),
    last_failure_at: String(snapshot.lastFailureAt || 0),
  };

  if (cache.redis && cache.redis.status === 'ready') {
    try {
      await cache.redis.hmset(key, payload);
      await cache.redis.pexpire(key, DEFAULTS.HEALTH_TTL_MS);
      return;
    } catch {
      // Fallback to memory.
    }
  }

  memoryHealth.set(key, payload);
}

function isTimeoutError(statusCode, errorMessage = '') {
  const msg = String(errorMessage || '').toLowerCase();
  return statusCode === 408 || msg.includes('timeout') || msg.includes('timed out') || msg.includes('econnaborted');
}

function isRetryableStatus(statusCode) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(statusCode));
}

function isRetryableUpstreamError(error) {
  const statusCode = error?.response?.status;
  const message = String(
    error?.response?.data?.error?.message
    || error?.response?.data?.message
    || error?.message
    || ''
  ).toLowerCase();

  if (isRetryableStatus(statusCode)) return true;
  if (message.includes('timeout') || message.includes('rate limit') || message.includes('econnreset') || message.includes('socket hang up')) {
    return true;
  }
  return false;
}

async function recordUpstreamSuccess(endpoint, { latencyMs = 0, statusCode = 200 } = {}) {
  const snapshot = await getHealthSnapshot(endpoint);
  const now = Date.now();
  const updated = {
    ...snapshot,
    successCount: snapshot.successCount + 1,
    consecutiveFailures: 0,
    lastStatusCode: statusCode,
    lastError: null,
    updatedAt: now,
    lastSuccessAt: now,
    latencyEwmaMs: Number(ewma(snapshot.latencyEwmaMs, Math.max(1, Number(latencyMs) || 1), 0.2).toFixed(2)),
    successEwma: Number(ewma(snapshot.successEwma, 1, 0.2).toFixed(4)),
  };
  if (updated.circuitOpenUntil <= now) updated.circuitOpenUntil = 0;
  await setHealthSnapshot(endpoint, updated);
}

async function recordUpstreamFailure(endpoint, {
  latencyMs = 0,
  statusCode = 0,
  errorMessage = '',
} = {}) {
  await refreshConfig();
  const snapshot = await getHealthSnapshot(endpoint);
  const now = Date.now();
  const updated = {
    ...snapshot,
    failureCount: snapshot.failureCount + 1,
    consecutiveFailures: snapshot.consecutiveFailures + 1,
    lastStatusCode: statusCode || null,
    lastError: String(errorMessage || '').slice(0, 500),
    updatedAt: now,
    lastFailureAt: now,
    latencyEwmaMs: latencyMs ? Number(ewma(snapshot.latencyEwmaMs, Math.max(1, Number(latencyMs) || 1), 0.35).toFixed(2)) : snapshot.latencyEwmaMs,
    successEwma: Number(ewma(snapshot.successEwma, 0, 0.3).toFixed(4)),
  };

  if (Number(statusCode) === 429) updated.rateLimitCount = snapshot.rateLimitCount + 1;
  else if (isTimeoutError(statusCode, errorMessage)) updated.timeoutCount = snapshot.timeoutCount + 1;
  else if (Number(statusCode) >= 500) updated.serverErrorCount = snapshot.serverErrorCount + 1;

  if (updated.consecutiveFailures >= config.FAILURE_THRESHOLD && isRetryableStatus(statusCode || 0)) {
    updated.circuitOpenUntil = now + config.CIRCUIT_OPEN_MS;
  }

  await setHealthSnapshot(endpoint, updated);
}

function cleanupMemoryLeases(endpointKey) {
  const items = memoryLeases.get(endpointKey);
  if (!items) return [];
  const now = Date.now();
  const fresh = items.filter((item) => item.expiresAt > now);
  if (fresh.length === 0) {
    memoryLeases.delete(endpointKey);
    return [];
  }
  memoryLeases.set(endpointKey, fresh);
  return fresh;
}

async function getEndpointInflight(endpoint) {
  await refreshConfig();
  const leaseKey = getLeaseKey(endpoint);
  const now = Date.now();

  if (cache.redis && cache.redis.status === 'ready') {
    try {
      await cache.redis.zremrangebyscore(leaseKey, '-inf', now - DEFAULTS.LEASE_TTL_MS);
      return Number(await cache.redis.zcard(leaseKey));
    } catch {
      // Fallback to memory.
    }
  }

  return cleanupMemoryLeases(leaseKey).length;
}

async function acquireEndpointLease(endpoint, token) {
  await refreshConfig();
  const leaseKey = getLeaseKey(endpoint);
  const now = Date.now();

  if (cache.redis && cache.redis.status === 'ready') {
    try {
      const script = `
local key = KEYS[1]
local nowMs = tonumber(ARGV[1])
local leaseTtlMs = tonumber(ARGV[2])
local token = ARGV[3]
local limit = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', key, '-inf', nowMs - leaseTtlMs)
local count = redis.call('ZCARD', key)
if redis.call('ZSCORE', key, token) then
  redis.call('ZADD', key, 'XX', nowMs, token)
  return {1, count}
end
if count < limit then
  redis.call('ZADD', key, nowMs, token)
  redis.call('PEXPIRE', key, leaseTtlMs)
  return {1, count + 1}
end
return {0, count}
`;
      const result = await cache.redis.eval(
        script,
        1,
        leaseKey,
        now,
        DEFAULTS.LEASE_TTL_MS,
        token,
        config.ENDPOINT_MAX_INFLIGHT
      );
      return {
        acquired: Number(result[0]) === 1,
        inflight: Number(result[1]),
        limit: config.ENDPOINT_MAX_INFLIGHT,
      };
    } catch {
      // Fallback to memory.
    }
  }

  const current = cleanupMemoryLeases(leaseKey);
  if (current.some((item) => item.token === token)) {
    return { acquired: true, inflight: current.length, limit: config.ENDPOINT_MAX_INFLIGHT };
  }
  if (current.length >= config.ENDPOINT_MAX_INFLIGHT) {
    return { acquired: false, inflight: current.length, limit: config.ENDPOINT_MAX_INFLIGHT };
  }
  current.push({ token, expiresAt: now + DEFAULTS.LEASE_TTL_MS });
  memoryLeases.set(leaseKey, current);
  return { acquired: true, inflight: current.length, limit: config.ENDPOINT_MAX_INFLIGHT };
}

async function releaseEndpointLease(endpoint, token) {
  const leaseKey = getLeaseKey(endpoint);

  if (cache.redis && cache.redis.status === 'ready') {
    try {
      await cache.redis.zrem(leaseKey, token);
      return;
    } catch {
      // Fallback to memory.
    }
  }

  const current = cleanupMemoryLeases(leaseKey);
  const next = current.filter((item) => item.token !== token);
  if (next.length === 0) memoryLeases.delete(leaseKey);
  else memoryLeases.set(leaseKey, next);
}

function computeHealthScore(endpoint, snapshot, inflight, options = {}) {
  const weight = Math.max(1, Number(endpoint.weight || 1));
  const latencyCritical = Boolean(options.latencyCritical);
  const latencyDivisor = latencyCritical ? 22 : 30;
  const inflightPenalty = latencyCritical ? 90 : 75;
  const recentSuccessWindowMs = latencyCritical ? 10 * 60 * 1000 : 5 * 60 * 1000;
  const recentSuccessBonus = latencyCritical ? 45 : 20;
  const recentFailureWindowMs = latencyCritical ? 2 * 60 * 1000 : 5 * 60 * 1000;
  const recentFailurePenalty = latencyCritical ? 40 : 20;
  let score = 1000;
  score += Math.min(weight, 10) * 15;
  score += (snapshot.successEwma || 1) * 100;
  score -= Math.min(snapshot.latencyEwmaMs || 0, 15000) / latencyDivisor;
  score -= (snapshot.consecutiveFailures || 0) * 120;
  score -= (snapshot.rateLimitCount || 0) * 45;
  score -= (snapshot.serverErrorCount || 0) * 35;
  score -= (snapshot.timeoutCount || 0) * 50;
  score -= inflight * inflightPenalty;
  if ((snapshot.lastSuccessAt || 0) > 0 && (Date.now() - snapshot.lastSuccessAt) <= recentSuccessWindowMs) {
    score += recentSuccessBonus;
  }
  if ((snapshot.lastFailureAt || 0) > 0 && (Date.now() - snapshot.lastFailureAt) <= recentFailureWindowMs) {
    score -= recentFailurePenalty;
  }
  if ((snapshot.circuitOpenUntil || 0) > Date.now()) score -= 5000;
  if (inflight >= config.ENDPOINT_MAX_INFLIGHT) score -= 2000;
  return Number(score.toFixed(2));
}

async function rankUpstreams(endpoints, options = {}) {
  await refreshConfig();

  const candidates = await Promise.all((endpoints || []).map(async (endpoint) => {
    const snapshot = await getHealthSnapshot(endpoint);
    const inflight = await getEndpointInflight(endpoint);
    const score = computeHealthScore(endpoint, snapshot, inflight, options);
    const circuitOpen = (snapshot.circuitOpenUntil || 0) > Date.now();
    const saturated = inflight >= config.ENDPOINT_MAX_INFLIGHT;
    return {
      ...endpoint,
      schedulerKey: getEndpointIdentity(endpoint),
      scheduler: {
        score,
        inflight,
        circuitOpen,
        saturated,
        limit: config.ENDPOINT_MAX_INFLIGHT,
        snapshot,
      },
    };
  }));

  const available = candidates.filter((item) => !item.scheduler.circuitOpen && !item.scheduler.saturated);
  const halfOpen = candidates.filter((item) => !item.scheduler.circuitOpen);
  const pool = available.length > 0 ? available : (halfOpen.length > 0 ? halfOpen : candidates);

  return pool.sort((a, b) => {
    if (b.scheduler.score !== a.scheduler.score) return b.scheduler.score - a.scheduler.score;
    if ((b.weight || 1) !== (a.weight || 1)) return (b.weight || 1) - (a.weight || 1);
    return getEndpointIdentity(a).localeCompare(getEndpointIdentity(b));
  });
}

async function acquireBestEndpoint(endpoints, token, options = {}) {
  const ranked = await rankUpstreams(endpoints, options);
  for (const endpoint of ranked) {
    const lease = await acquireEndpointLease(endpoint, token);
    if (!lease.acquired) continue;
    return { endpoint, ranked, lease };
  }
  return { endpoint: null, ranked, lease: null };
}

async function getSchedulerSummary(limit = 10) {
  const now = Date.now();
  const entries = [];

  if (cache.redis && cache.redis.status === 'ready') {
    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await cache.redis.scan(cursor, 'MATCH', 'ai-gw:upstream:health:*', 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          const payloads = await Promise.all(keys.map((key) => cache.redis.hgetall(key).catch(() => ({}))));
          for (let i = 0; i < keys.length; i++) {
            const snapshot = normalizeSnapshot(payloads[i]);
            entries.push({
              key: keys[i].slice('ai-gw:upstream:health:'.length),
              ...snapshot,
            });
          }
        }
      } while (cursor !== '0');
    } catch {
      // Fallback to memory.
    }
  }

  if (entries.length === 0) {
    for (const [key, value] of memoryHealth.entries()) {
      entries.push({
        key: key.slice('ai-gw:upstream:health:'.length),
        ...normalizeSnapshot(value),
      });
    }
  }

  const degraded = entries
    .map((entry) => ({
      key: entry.key,
      circuitOpen: entry.circuitOpenUntil > now,
      consecutiveFailures: entry.consecutiveFailures || 0,
      lastStatusCode: entry.lastStatusCode || null,
      latencyEwmaMs: entry.latencyEwmaMs || 0,
      lastError: entry.lastError || null,
      updatedAt: entry.updatedAt || 0,
    }))
    .filter((entry) => entry.circuitOpen || entry.consecutiveFailures > 0 || entry.lastStatusCode >= 400)
    .sort((a, b) => {
      if (Number(b.circuitOpen) !== Number(a.circuitOpen)) return Number(b.circuitOpen) - Number(a.circuitOpen);
      if (b.consecutiveFailures !== a.consecutiveFailures) return b.consecutiveFailures - a.consecutiveFailures;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    })
    .slice(0, limit);

  return {
    totalEndpoints: entries.length,
    openCircuits: entries.filter((entry) => entry.circuitOpenUntil > now).length,
    degraded,
  };
}

module.exports = {
  acquireBestEndpoint,
  acquireEndpointLease,
  getEndpointIdentity,
  getEndpointInflight,
  getSchedulerSummary,
  isRetryableUpstreamError,
  rankUpstreams,
  recordUpstreamFailure,
  recordUpstreamSuccess,
  releaseEndpointLease,
};
