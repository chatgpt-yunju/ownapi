const db = require('../../../config/db');

const PIPELINE_STEPS = {
  1: { key: 'entry', name: '入口接入' },
  2: { key: 'auth', name: '鉴权验证' },
  3: { key: 'rate_limit', name: '智能限流' },
  4: { key: 'queue', name: '请求排队' },
  5: { key: 'dispatch', name: '动态调度' },
  6: { key: 'upstream_call', name: '上游调用' },
  7: { key: 'response', name: '响应回传' },
  8: { key: 'recovery', name: '容灾处理' },
};

const DEBUG_QUEUE_MAX = Math.max(200, parseInt(process.env.GATEWAY_DEBUG_QUEUE_MAX, 10) || 3000);
const DEBUG_BATCH_SIZE = Math.max(1, parseInt(process.env.GATEWAY_DEBUG_BATCH_SIZE, 10) || 50);
const DEBUG_FLUSH_INTERVAL_MS = Math.max(200, parseInt(process.env.GATEWAY_DEBUG_FLUSH_INTERVAL_MS, 10) || 500);

let debugQueue = [];

db.query(`
  CREATE TABLE IF NOT EXISTS openclaw_request_debug_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    request_id VARCHAR(80) NOT NULL,
    trace_type ENUM('live', 'manual') DEFAULT 'live',
    route_name VARCHAR(64) DEFAULT NULL,
    request_path VARCHAR(255) DEFAULT NULL,
    model VARCHAR(200) DEFAULT NULL,
    user_id INT DEFAULT NULL,
    api_key_id INT DEFAULT NULL,
    step_no TINYINT NOT NULL,
    step_key VARCHAR(50) NOT NULL,
    step_name VARCHAR(100) NOT NULL,
    status ENUM('success', 'error', 'pending', 'skipped', 'info') DEFAULT 'info',
    duration_ms INT DEFAULT NULL,
    attempt_no INT DEFAULT 1,
    upstream_id INT DEFAULT NULL,
    upstream_provider VARCHAR(100) DEFAULT NULL,
    upstream_base_url VARCHAR(500) DEFAULT NULL,
    error_message TEXT,
    detail_json LONGTEXT,
    created_at DATETIME DEFAULT NOW(),
    INDEX idx_request_id (request_id, id),
    INDEX idx_created_at (created_at),
    INDEX idx_trace_type (trace_type, created_at),
    INDEX idx_model (model, created_at),
    INDEX idx_route (route_name, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`).catch(() => {});

function safeString(value, max = 1000) {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

function trimObject(value, depth = 0) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return safeString(value, 2000);
  if (depth >= 4) return safeString(value, 1000);
  if (Array.isArray(value)) return value.slice(0, 20).map(item => trimObject(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      output[key] = trimObject(item, depth + 1);
    }
    return output;
  }
  return safeString(String(value), 1000);
}

function maskSecret(secret) {
  const text = String(secret || '');
  if (!text) return '';
  if (text.length <= 10) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function serializeDetail(detail) {
  try {
    return JSON.stringify(trimObject(detail || {}));
  } catch (err) {
    return JSON.stringify({ serialize_error: err.message });
  }
}

function enqueueDebugStepRecord(payload = {}) {
  if (!payload.requestId) return false;

  const detailJson = payload.detailJson === undefined
    ? null
    : serializeDetail(payload.detailJson);

  if (debugQueue.length >= DEBUG_QUEUE_MAX) {
    debugQueue.shift();
  }

  debugQueue.push({
    requestId: payload.requestId,
    traceType: payload.traceType || 'live',
    routeName: payload.routeName || null,
    requestPath: payload.requestPath || null,
    model: payload.model || null,
    userId: payload.userId || null,
    apiKeyId: payload.apiKeyId || null,
    stepNo: Number(payload.stepNo) || 9,
    stepKey: payload.stepKey || 'timing',
    stepName: payload.stepName || '耗时统计',
    status: payload.status || 'info',
    durationMs: payload.durationMs === undefined ? null : Math.max(0, Number(payload.durationMs) || 0),
    attemptNo: Number(payload.attemptNo) || 1,
    upstreamId: payload.upstreamId === undefined ? null : payload.upstreamId,
    upstreamProvider: payload.upstreamProvider || null,
    upstreamBaseUrl: payload.upstreamBaseUrl || null,
    errorMessage: payload.errorMessage || null,
    detailJson,
  });

  return true;
}

async function flushDebugStepRecords() {
  if (debugQueue.length === 0) return;

  const batch = debugQueue.splice(0, DEBUG_BATCH_SIZE);
  const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
  const values = [];

  for (const item of batch) {
    values.push(
      item.requestId,
      item.traceType,
      item.routeName,
      item.requestPath,
      item.model,
      item.userId,
      item.apiKeyId,
      item.stepNo,
      item.stepKey,
      item.stepName,
      item.status,
      item.durationMs,
      item.attemptNo,
      item.upstreamId,
      item.upstreamProvider,
      item.upstreamBaseUrl,
      item.errorMessage,
      item.detailJson,
    );
  }

  try {
    await db.query(
      `INSERT INTO openclaw_request_debug_logs
        (request_id, trace_type, route_name, request_path, model, user_id, api_key_id, step_no, step_key,
         step_name, status, duration_ms, attempt_no, upstream_id, upstream_provider, upstream_base_url,
         error_message, detail_json)
       VALUES ${placeholders}`,
      values
    );
  } catch (error) {
    console.error('[request-debug] flush failed:', error.message);
    debugQueue = batch.concat(debugQueue);
  }
}

setInterval(() => {
  flushDebugStepRecords().catch((error) => console.error('[request-debug] timer failed:', error.message));
}, DEBUG_FLUSH_INTERVAL_MS).unref();

function detectRouteName(req) {
  const path = req.path || req.originalUrl || '';
  if (path.endsWith('/chat/completions')) return 'chat.completions';
  if (path.endsWith('/embeddings')) return 'embeddings';
  if (path.endsWith('/messages')) return 'messages';
  if (path.endsWith('/responses')) return 'responses';
  if (path.includes(':generateContent') || path.includes(':streamGenerateContent')) return 'gemini.generateContent';
  return 'unknown';
}

function detectRequestedModel(req) {
  if (req.body?.model) return req.body.model;
  const path = req.path || req.originalUrl || '';
  const match = path.match(/\/models\/(.+):(generateContent|streamGenerateContent)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Step trace logging disabled — no-op to reduce DB writes
async function logDebugStep(_payload) {
  // Recording disabled
}

function createDebugRecorder(base = {}) {
  return {
    async step(stepNo, status, detail = {}, extra = {}) {
      await logDebugStep({
        ...base,
        ...extra,
        stepNo,
        status,
        detail
      });
    }
  };
}

module.exports = {
  PIPELINE_STEPS,
  createDebugRecorder,
  detectRequestedModel,
  detectRouteName,
  enqueueDebugStepRecord,
  logDebugStep,
  maskSecret,
  safeString,
};
