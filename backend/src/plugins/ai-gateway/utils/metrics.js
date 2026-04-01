const LATENCY_BUCKETS = [100, 250, 500, 1000, 3000, 8000, 15000, 30000, 60000];

const state = {
  startedAt: Date.now(),
  inflight: 0,
  totalRequests: 0,
  totalDurationMs: 0,
  statusCounts: new Map(),
  routeCounts: new Map(),
  latencyBuckets: new Map(),
  queue: {
    activeCount: 0,
    waitingCount: 0,
    maxConcurrent: 0,
    maxQueueSize: 0,
    waitTimeoutMs: 0,
    lastWaitMs: 0,
    queuedRequests: 0,
    updatedAt: null,
  },
  latencyStages: {
    messages: createLatencyStageState(),
    byModel: new Map(),
  },
};

function createLatencyStageState() {
  return {
    count: 0,
    queueWaitMsTotal: 0,
    dispatchMsTotal: 0,
    headersFlushedMsTotal: 0,
    firstCommentPingMsTotal: 0,
    upstreamConnectMsTotal: 0,
    firstRealEventMsTotal: 0,
    firstChunkMsTotal: 0,
    totalStreamMsTotal: 0,
    last: {
      model: null,
      queueWaitMs: 0,
      dispatchMs: 0,
      headersFlushedMs: 0,
      firstCommentPingMs: 0,
      upstreamConnectMs: 0,
      firstRealEventMs: 0,
      firstChunkMs: 0,
      totalStreamMs: 0,
      fastStartEnabled: false,
      fastStartCommentSent: false,
      updatedAt: null,
    },
  };
}

function roundMetric(value) {
  return Number((Math.max(0, Number(value) || 0)).toFixed(2));
}

function averageMetric(total, count) {
  return count > 0 ? roundMetric(total / count) : 0;
}

function normalizeModel(model) {
  return String(model || '').trim().slice(0, 160) || 'unknown';
}

function statusFamily(statusCode) {
  const code = Number(statusCode) || 0;
  if (code >= 500) return '5xx';
  if (code >= 400) return '4xx';
  if (code >= 300) return '3xx';
  if (code >= 200) return '2xx';
  return 'other';
}

function increment(map, key, value = 1) {
  map.set(key, (map.get(key) || 0) + value);
}

function normalizeRouteName(routeName) {
  return routeName || 'unknown';
}

function recordRequestStart() {
  state.inflight += 1;
}

function recordRequestFinish({ routeName, statusCode, durationMs }) {
  state.inflight = Math.max(0, state.inflight - 1);
  state.totalRequests += 1;
  state.totalDurationMs += Math.max(0, Number(durationMs) || 0);

  const normalizedRoute = normalizeRouteName(routeName);
  increment(state.statusCounts, statusFamily(statusCode));
  increment(state.statusCounts, `status:${statusCode || 0}`);
  increment(state.routeCounts, normalizedRoute);

  const latency = Math.max(0, Number(durationMs) || 0);
  for (const bucket of LATENCY_BUCKETS) {
    if (latency <= bucket) {
      increment(state.latencyBuckets, bucket);
    }
  }
}

function recordQueueSnapshot(snapshot = {}) {
  state.queue = {
    ...state.queue,
    ...snapshot,
    updatedAt: new Date().toISOString(),
  };
}

function recordQueueWait(waitMs, queued) {
  state.queue.lastWaitMs = Math.max(0, Number(waitMs) || 0);
  if (queued) state.queue.queuedRequests += 1;
}

function recordMessagesStageTiming({
  model,
  queueWaitMs = 0,
  dispatchMs = 0,
  headersFlushedMs = 0,
  firstCommentPingMs = 0,
  upstreamConnectMs = 0,
  firstRealEventMs = 0,
  firstChunkMs = 0,
  totalStreamMs = 0,
  fastStartEnabled = false,
  fastStartCommentSent = false,
} = {}) {
  const normalizedModel = normalizeModel(model);
  const routeState = state.latencyStages.messages;
  routeState.count += 1;
  routeState.queueWaitMsTotal += Math.max(0, Number(queueWaitMs) || 0);
  routeState.dispatchMsTotal += Math.max(0, Number(dispatchMs) || 0);
  routeState.headersFlushedMsTotal += Math.max(0, Number(headersFlushedMs) || 0);
  routeState.firstCommentPingMsTotal += Math.max(0, Number(firstCommentPingMs) || 0);
  routeState.upstreamConnectMsTotal += Math.max(0, Number(upstreamConnectMs) || 0);
  routeState.firstRealEventMsTotal += Math.max(0, Number(firstRealEventMs) || 0);
  routeState.firstChunkMsTotal += Math.max(0, Number(firstChunkMs) || 0);
  routeState.totalStreamMsTotal += Math.max(0, Number(totalStreamMs) || 0);
  routeState.last = {
    model: normalizedModel,
    queueWaitMs: roundMetric(queueWaitMs),
    dispatchMs: roundMetric(dispatchMs),
    headersFlushedMs: roundMetric(headersFlushedMs),
    firstCommentPingMs: roundMetric(firstCommentPingMs),
    upstreamConnectMs: roundMetric(upstreamConnectMs),
    firstRealEventMs: roundMetric(firstRealEventMs),
    firstChunkMs: roundMetric(firstChunkMs),
    totalStreamMs: roundMetric(totalStreamMs),
    fastStartEnabled: Boolean(fastStartEnabled),
    fastStartCommentSent: Boolean(fastStartCommentSent),
    updatedAt: new Date().toISOString(),
  };

  const existingModelState = state.latencyStages.byModel.get(normalizedModel) || createLatencyStageState();
  existingModelState.count += 1;
  existingModelState.queueWaitMsTotal += Math.max(0, Number(queueWaitMs) || 0);
  existingModelState.dispatchMsTotal += Math.max(0, Number(dispatchMs) || 0);
  existingModelState.headersFlushedMsTotal += Math.max(0, Number(headersFlushedMs) || 0);
  existingModelState.firstCommentPingMsTotal += Math.max(0, Number(firstCommentPingMs) || 0);
  existingModelState.upstreamConnectMsTotal += Math.max(0, Number(upstreamConnectMs) || 0);
  existingModelState.firstRealEventMsTotal += Math.max(0, Number(firstRealEventMs) || 0);
  existingModelState.firstChunkMsTotal += Math.max(0, Number(firstChunkMs) || 0);
  existingModelState.totalStreamMsTotal += Math.max(0, Number(totalStreamMs) || 0);
  existingModelState.last = {
    model: normalizedModel,
    queueWaitMs: roundMetric(queueWaitMs),
    dispatchMs: roundMetric(dispatchMs),
    headersFlushedMs: roundMetric(headersFlushedMs),
    firstCommentPingMs: roundMetric(firstCommentPingMs),
    upstreamConnectMs: roundMetric(upstreamConnectMs),
    firstRealEventMs: roundMetric(firstRealEventMs),
    firstChunkMs: roundMetric(firstChunkMs),
    totalStreamMs: roundMetric(totalStreamMs),
    fastStartEnabled: Boolean(fastStartEnabled),
    fastStartCommentSent: Boolean(fastStartCommentSent),
    updatedAt: new Date().toISOString(),
  };
  state.latencyStages.byModel.set(normalizedModel, existingModelState);
}

function summarizeLatencyStage(stageState) {
  return {
    count: stageState.count || 0,
    avgQueueWaitMs: averageMetric(stageState.queueWaitMsTotal, stageState.count || 0),
    avgDispatchMs: averageMetric(stageState.dispatchMsTotal, stageState.count || 0),
    avgHeadersFlushedMs: averageMetric(stageState.headersFlushedMsTotal, stageState.count || 0),
    avgFirstCommentPingMs: averageMetric(stageState.firstCommentPingMsTotal, stageState.count || 0),
    avgUpstreamConnectMs: averageMetric(stageState.upstreamConnectMsTotal, stageState.count || 0),
    avgFirstRealEventMs: averageMetric(stageState.firstRealEventMsTotal, stageState.count || 0),
    avgFirstChunkMs: averageMetric(stageState.firstChunkMsTotal, stageState.count || 0),
    avgTotalStreamMs: averageMetric(stageState.totalStreamMsTotal, stageState.count || 0),
    last: { ...(stageState.last || {}) },
  };
}

function getSnapshot() {
  const modelLatency = {};
  for (const [model, stageState] of state.latencyStages.byModel.entries()) {
    modelLatency[model] = summarizeLatencyStage(stageState);
  }
  return {
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    inflight: state.inflight,
    totalRequests: state.totalRequests,
    averageDurationMs: state.totalRequests > 0 ? Number((state.totalDurationMs / state.totalRequests).toFixed(2)) : 0,
    statusCounts: Object.fromEntries(state.statusCounts.entries()),
    routeCounts: Object.fromEntries(state.routeCounts.entries()),
    latencyBuckets: Object.fromEntries(state.latencyBuckets.entries()),
    queue: { ...state.queue },
    latencyStages: {
      messages: summarizeLatencyStage(state.latencyStages.messages),
      byModel: modelLatency,
    },
  };
}

function renderPrometheusMetrics({ queueStats = null, dbStats = null, redisReady = null, schedulerSummary = null } = {}) {
  const snapshot = getSnapshot();
  const queue = queueStats || snapshot.queue;
  const messagesLatency = snapshot.latencyStages.messages || {};
  const lines = [
    '# HELP ai_gateway_inflight_requests Current in-flight AI gateway requests.',
    '# TYPE ai_gateway_inflight_requests gauge',
    `ai_gateway_inflight_requests ${snapshot.inflight}`,
    '# HELP ai_gateway_requests_total Total AI gateway requests.',
    '# TYPE ai_gateway_requests_total counter',
    `ai_gateway_requests_total ${snapshot.totalRequests}`,
    '# HELP ai_gateway_request_duration_ms_avg Average request duration in milliseconds.',
    '# TYPE ai_gateway_request_duration_ms_avg gauge',
    `ai_gateway_request_duration_ms_avg ${snapshot.averageDurationMs}`,
    '# HELP ai_gateway_queue_waiting Current waiting queue depth.',
    '# TYPE ai_gateway_queue_waiting gauge',
    `ai_gateway_queue_waiting ${queue.waitingCount || 0}`,
    '# HELP ai_gateway_queue_active Current active queue slots.',
    '# TYPE ai_gateway_queue_active gauge',
    `ai_gateway_queue_active ${queue.activeCount || 0}`,
    '# HELP ai_gateway_queue_last_wait_ms Last observed queue wait in milliseconds.',
    '# TYPE ai_gateway_queue_last_wait_ms gauge',
    `ai_gateway_queue_last_wait_ms ${queue.lastWaitMs || 0}`,
    '# HELP ai_gateway_messages_first_chunk_ms_avg Average first chunk latency for /v1/messages in milliseconds.',
    '# TYPE ai_gateway_messages_first_chunk_ms_avg gauge',
    `ai_gateway_messages_first_chunk_ms_avg ${messagesLatency.avgFirstChunkMs || 0}`,
    '# HELP ai_gateway_messages_first_real_event_ms_avg Average first real SSE event latency for /v1/messages in milliseconds.',
    '# TYPE ai_gateway_messages_first_real_event_ms_avg gauge',
    `ai_gateway_messages_first_real_event_ms_avg ${messagesLatency.avgFirstRealEventMs || 0}`,
    '# HELP ai_gateway_messages_upstream_connect_ms_avg Average upstream connect latency for /v1/messages in milliseconds.',
    '# TYPE ai_gateway_messages_upstream_connect_ms_avg gauge',
    `ai_gateway_messages_upstream_connect_ms_avg ${messagesLatency.avgUpstreamConnectMs || 0}`,
  ];

  for (const [key, value] of Object.entries(snapshot.statusCounts)) {
    lines.push(`ai_gateway_status_total{status="${key}"} ${value}`);
  }
  for (const [key, value] of Object.entries(snapshot.routeCounts)) {
    lines.push(`ai_gateway_route_total{route="${key}"} ${value}`);
  }
  for (const bucket of LATENCY_BUCKETS) {
    lines.push(`ai_gateway_request_duration_bucket_ms{le="${bucket}"} ${snapshot.latencyBuckets[String(bucket)] || 0}`);
  }
  if (dbStats) {
    lines.push(`ai_gateway_db_pool_connections ${dbStats.total || 0}`);
    lines.push(`ai_gateway_db_pool_free_connections ${dbStats.free || 0}`);
    lines.push(`ai_gateway_db_pool_waiting ${dbStats.waiting || 0}`);
  }
  if (redisReady !== null) {
    lines.push(`ai_gateway_redis_ready ${redisReady ? 1 : 0}`);
  }
  if (schedulerSummary) {
    lines.push('# HELP ai_gateway_upstream_endpoints_total Total upstream endpoints tracked by the scheduler.');
    lines.push('# TYPE ai_gateway_upstream_endpoints_total gauge');
    lines.push(`ai_gateway_upstream_endpoints_total ${schedulerSummary.totalEndpoints || 0}`);
    lines.push('# HELP ai_gateway_upstream_open_circuits Number of upstream circuits currently open.');
    lines.push('# TYPE ai_gateway_upstream_open_circuits gauge');
    lines.push(`ai_gateway_upstream_open_circuits ${schedulerSummary.openCircuits || 0}`);
    lines.push('# HELP ai_gateway_upstream_degraded_endpoints Number of degraded upstream endpoints in the current scheduler summary.');
    lines.push('# TYPE ai_gateway_upstream_degraded_endpoints gauge');
    lines.push(`ai_gateway_upstream_degraded_endpoints ${Array.isArray(schedulerSummary.degraded) ? schedulerSummary.degraded.length : 0}`);
  }

  return `${lines.join('\n')}\n`;
}

module.exports = {
  getSnapshot,
  recordMessagesStageTiming,
  recordQueueSnapshot,
  recordQueueWait,
  recordRequestFinish,
  recordRequestStart,
  renderPrometheusMetrics,
};
