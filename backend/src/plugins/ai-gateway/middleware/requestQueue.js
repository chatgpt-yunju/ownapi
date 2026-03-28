'use strict';
/**
 * 请求排队中间件 — API中转站 Step 4
 * 优先级队列控制并发，防止上游过载
 */

const cache = require('../utils/cache');
const { logDebugStep } = require('../utils/requestDebug');

// ── 优先级映射（数值越小越优先）────────────────────────────────────────────
const PRIORITY = {
  enterprise: 0,
  pro:        1,
  basic:      2,
  free:       3,
  guest:      4,
};

function getPriority(req) {
  const type = req.userPackageType || 'guest';
  return PRIORITY[type] ?? PRIORITY.guest;
}

// ── 配置默认值（可通过 settings 表覆盖）────────────────────────────────────
const DEFAULTS = {
  MAX_CONCURRENT:  10,
  MAX_QUEUE_SIZE: 100,
  WAIT_TIMEOUT_MS: 30000,
};

let config = { ...DEFAULTS };

// 懒加载 getSettingCached，避免模块循环依赖
let _getSettingCached = null;
function getSettingFn() {
  if (!_getSettingCached) {
    try {
      _getSettingCached = require('../../../routes/quota').getSettingCached;
    } catch {
      _getSettingCached = async (_key, def) => def;
    }
  }
  return _getSettingCached;
}

async function refreshConfig() {
  const getSetting = getSettingFn();
  try {
    const [c, s, t] = await Promise.all([
      getSetting('queue_max_concurrent',  String(DEFAULTS.MAX_CONCURRENT)),
      getSetting('queue_max_size',         String(DEFAULTS.MAX_QUEUE_SIZE)),
      getSetting('queue_wait_timeout_ms',  String(DEFAULTS.WAIT_TIMEOUT_MS)),
    ]);
    config = {
      MAX_CONCURRENT:  Math.max(1, parseInt(c, 10)  || DEFAULTS.MAX_CONCURRENT),
      MAX_QUEUE_SIZE:  Math.max(0, parseInt(s, 10)  || DEFAULTS.MAX_QUEUE_SIZE),
      WAIT_TIMEOUT_MS: Math.max(1000, parseInt(t, 10) || DEFAULTS.WAIT_TIMEOUT_MS),
    };
  } catch { /* 保留上次配置 */ }
}

// 启动加载一次，之后每 5 分钟刷新
refreshConfig();
setInterval(refreshConfig, 5 * 60 * 1000).unref();

// ── 核心队列状态 ─────────────────────────────────────────────────────────────
let activeCount = 0;
// 元素：{ priority, enqueuedAt, resolve, reject, _aborted }
const waitingQueue = [];

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

// ── 调度器：从等待队列提升请求到处理中 ────────────────────────────────────
function scheduleNext() {
  while (activeCount < config.MAX_CONCURRENT && waitingQueue.length > 0) {
    const item = waitingQueue.shift();
    if (item._aborted) continue;  // 客户端已断开，跳过
    activeCount++;
    item.resolve();
  }
}

// ── Redis 统计上报（2秒防抖，不影响请求路径）─────────────────────────────
let _statsTimer = null;
function debouncedPublishStats() {
  if (_statsTimer) return;
  _statsTimer = setTimeout(() => {
    _statsTimer = null;
    if (cache.redis && cache.redis.status === 'ready') {
      cache.redis.hset('queue:stats',
        'activeCount',  String(activeCount),
        'waitingCount', String(waitingQueue.length),
        'updatedAt',    String(Date.now())
      ).then(() => cache.redis.expire('queue:stats', 60)).catch(() => {});
    }
  }, 2000);
}

// ── 槽位释放（WeakSet 防重复触发）─────────────────────────────────────────
const _released = new WeakSet();
function releaseSlot() {
  if (_released.has(this)) return;
  _released.add(this);
  activeCount = Math.max(0, activeCount - 1);
  setImmediate(scheduleNext);
  debouncedPublishStats();
}

// ── Express 中间件入口 ────────────────────────────────────────────────────
async function requestQueueMiddleware(req, res, next) {
  if (req._queueChecked) return next();
  // 只对推理接口排队
  if (req.method !== 'POST') return next();
  const path = req.path || '';
  const isGemini = path.includes(':generateContent') || path.includes(':streamGenerateContent');
  if (!path.endsWith('/chat/completions') && !path.endsWith('/embeddings') && !path.endsWith('/messages') && !path.endsWith('/responses') && !isGemini) {
    return next();
  }
  req._queueChecked = true;

  // 槽位充足：直接处理
  if (activeCount < config.MAX_CONCURRENT) {
    activeCount++;
    debouncedPublishStats();
    await debugQueueStep(req, 'success', {
      queued: false,
      active_count: activeCount,
      waiting_count: waitingQueue.length,
      max_concurrent: config.MAX_CONCURRENT,
    });
    res.on('finish', releaseSlot);
    res.on('close',  releaseSlot);
    return next();
  }

  // 队列已满：立即 503
  if (waitingQueue.length >= config.MAX_QUEUE_SIZE) {
    await debugQueueStep(req, 'error', {
      queued: false,
      active_count: activeCount,
      waiting_count: waitingQueue.length,
      max_queue_size: config.MAX_QUEUE_SIZE,
    }, { errorMessage: '服务器繁忙，请稍后重试（队列已满）' });
    return res.status(503).json({
      error: {
        message: '服务器繁忙，请稍后重试（队列已满）',
        type: 'overloaded_error',
        queue_depth: waitingQueue.length,
        retry_after: 5,
      }
    });
  }

  // ── 入队等待 ──────────────────────────────────────────────────────────────
  const priority   = getPriority(req);
  const enqueuedAt = Date.now();
  let _aborted     = false;
  let timeoutHandle;

  await new Promise((resolve, reject) => {
    const item = {
      priority,
      enqueuedAt,
      resolve,
      reject,
      get _aborted() { return _aborted; },
    };

    // 按优先级有序插入（O(n)，队列上限100条，可接受）
    let insertAt = waitingQueue.length;
    for (let i = 0; i < waitingQueue.length; i++) {
      if (
        priority < waitingQueue[i].priority ||
        (priority === waitingQueue[i].priority && enqueuedAt < waitingQueue[i].enqueuedAt)
      ) {
        insertAt = i;
        break;
      }
    }
    waitingQueue.splice(insertAt, 0, item);
    debouncedPublishStats();
    debugQueueStep(req, 'pending', {
      queued: true,
      priority,
      enqueued_at: enqueuedAt,
      waiting_count: waitingQueue.length,
      active_count: activeCount,
    }).catch(() => {});

    // 等待超时
    timeoutHandle = setTimeout(() => {
      _aborted = true;
      const idx = waitingQueue.indexOf(item);
      if (idx !== -1) waitingQueue.splice(idx, 1);
      debouncedPublishStats();
      reject(new Error('QUEUE_TIMEOUT'));
    }, config.WAIT_TIMEOUT_MS);

    // 客户端断开（SSE流式场景尤为重要）
    req.on('close', () => {
      _aborted = true;
      clearTimeout(timeoutHandle);
      const idx = waitingQueue.indexOf(item);
      if (idx !== -1) waitingQueue.splice(idx, 1);
      debouncedPublishStats();
      // 连接已关闭，不需要 reject，Express 无需再响应
    });
  }).then(() => {
    clearTimeout(timeoutHandle);
    debouncedPublishStats();
    const waitMs = Date.now() - enqueuedAt;
    debugQueueStep(req, 'success', {
      queued: true,
      priority,
      wait_ms: waitMs,
      active_count: activeCount,
      waiting_count: waitingQueue.length,
    }).catch(() => {});
    res.on('finish', releaseSlot);
    res.on('close',  releaseSlot);
    next();
  }).catch((err) => {
    if (err.message === 'QUEUE_TIMEOUT') {
      const waitMs = Date.now() - enqueuedAt;
      debugQueueStep(req, 'error', {
        queued: true,
        priority,
        wait_ms: waitMs,
        waiting_count: waitingQueue.length,
        timeout_ms: config.WAIT_TIMEOUT_MS,
      }, { errorMessage: '请求排队超时' }).catch(() => {});
      return res.status(503).json({
        error: {
          message: `请求排队超时（超过 ${Math.round(config.WAIT_TIMEOUT_MS / 1000)} 秒），请稍后重试`,
          type: 'overloaded_error',
          retry_after: Math.ceil(config.WAIT_TIMEOUT_MS / 1000),
        }
      });
    }
    next(err);
  });
}

// ── 暴露内部状态（供监控接口读取）────────────────────────────────────────
function getQueueStats() {
  const priorityBreakdown = {};
  for (const item of waitingQueue) {
    const label = Object.keys(PRIORITY).find(k => PRIORITY[k] === item.priority) || 'unknown';
    priorityBreakdown[label] = (priorityBreakdown[label] || 0) + 1;
  }
  return {
    activeCount,
    waitingCount: waitingQueue.length,
    maxConcurrent: config.MAX_CONCURRENT,
    maxQueueSize: config.MAX_QUEUE_SIZE,
    waitTimeoutMs: config.WAIT_TIMEOUT_MS,
    priorityBreakdown,
  };
}

module.exports = { requestQueueMiddleware, getQueueStats, refreshConfig };
