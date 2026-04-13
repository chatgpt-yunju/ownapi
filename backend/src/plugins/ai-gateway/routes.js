const router = require('express').Router();
const compression = require('compression');
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/db');
const cache = require('./utils/cache');
const { authMiddleware } = require('./middleware/auth');
const { apiKeyAuth } = require('./middleware/apiKeyAuth');
const { internalAuth } = require('./middleware/internalAuth');
const { requestQueueMiddleware, getQueueStats } = require('./middleware/requestQueue');
const {
  applySmartRouterAveragePricing,
  getDomesticAveragePricing,
  isSmartRouterModel,
} = require('./utils/smartRouterPricing');
const { createDebugRecorder, detectRequestedModel, detectRouteName } = require('./utils/requestDebug');
const { getSchedulerSummary } = require('./utils/upstreamScheduler');
const {
  getSnapshot,
  recordRequestFinish,
  recordRequestStart,
  renderPrometheusMetrics,
} = require('./utils/metrics');

function buildRequestId(routeName) {
  const suffix = uuidv4().replace(/-/g, '').slice(0, 24);
  if (routeName === 'chat.completions') return `chatcmpl-${suffix}`;
  if (routeName === 'embeddings') return `embd_${suffix}`;
  if (routeName === 'messages') return `msg_${suffix}`;
  if (routeName === 'responses') return `resp_${suffix}`;
  if (routeName === 'gemini.generateContent') return `gem_${suffix}`;
  return `gw_${suffix}`;
}

async function attachRequestTrace(req, _res, next) {
  if (req.aiGatewayEntryTraced) return next();
  const routeName = detectRouteName(req);
  if (routeName === 'unknown') return next();
  if (!req.aiGatewayRequestId) req.aiGatewayRequestId = buildRequestId(routeName);
  req.aiGatewayRouteName = routeName;
  req.aiGatewayRequestedModel = detectRequestedModel(req);
  req.aiGatewayTraceType = req.headers['x-debug-trace-type'] === 'manual' ? 'manual' : 'live';
  _res.setHeader('X-Request-Id', req.aiGatewayRequestId);
  const recorder = createDebugRecorder({
    requestId: req.aiGatewayRequestId,
    traceType: req.aiGatewayTraceType,
    routeName,
    requestPath: req.originalUrl,
    model: req.aiGatewayRequestedModel,
  });
  await recorder.step(1, 'success', {
    method: req.method,
    model: req.aiGatewayRequestedModel,
    ip: req.ip,
    stream: Boolean(req.body?.stream),
    has_authorization: Boolean(req.headers.authorization || req.headers['x-api-key'] || req.headers['x-goog-api-key']),
  });
  req.aiGatewayEntryTraced = true;
  next();
}

// gzip 压缩：仅压缩非流式响应（SSE text/event-stream 自动跳过），> 512B 才压缩
router.use(compression({ threshold: 512 }));

router.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  recordRequestStart();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    recordRequestFinish({
      routeName: req.aiGatewayRouteName || detectRouteName(req),
      statusCode: res.statusCode,
      durationMs,
    });
  });

  next();
});

// 请求日志
router.use('/v1', (req, res, next) => {
  console.log(`[AI-GW] ${req.method} ${req.originalUrl} | model: ${req.body?.model || '-'}`);
  next();
});

// 内部服务调用 (/v1/internal/*) — 必须在 apiKeyAuth 之前
router.use('/v1/internal', attachRequestTrace, internalAuth, require('./routes/chat'));

// Responses API 兼容端点 (/v1/responses) — Codex CLI
router.use('/v1', attachRequestTrace, apiKeyAuth, requestQueueMiddleware, require('./routes/responses'));

// API Key 鉴权路由 (/v1/*)
router.use('/v1', attachRequestTrace, apiKeyAuth, requestQueueMiddleware, require('./routes/chat'));

// Gemini API 兼容端点 (/v1beta/*)
router.use('/v1beta', (req, res, next) => {
  console.log(`[AI-GW] ${req.method} ${req.originalUrl} | model: ${req.body?.model || req.params?.modelAction?.split(':')[0] || '-'}`);
  next();
}, attachRequestTrace, apiKeyAuth, requestQueueMiddleware, require('./routes/gemini'));

function requireInternalSecret(req, res, next) {
  const secret = req.headers['x-internal-secret'];
  if (!process.env.INTERNAL_API_SECRET) {
    return res.status(500).json({ error: 'INTERNAL_API_SECRET not configured' });
  }
  if (secret !== process.env.INTERNAL_API_SECRET) {
    return res.status(401).json({ error: 'Invalid internal secret' });
  }
  next();
}

// 公开：模型列表
router.get('/api/models', async (req, res) => {
  try {
    const smartRouterPricing = await getDomesticAveragePricing();
    const [models] = await db.query(
      `SELECT model_id, display_name, provider,
              input_price_per_1k, output_price_per_1k, price_currency,
              billing_mode, per_call_price, model_category
       FROM openclaw_models
       WHERE status = "active"
       ORDER BY sort_order`
    );
    const normalizedModels = models.map((model) => (
      isSmartRouterModel(model)
        ? applySmartRouterAveragePricing(model, smartRouterPricing)
        : model
    )).map((model) => (
      isSmartRouterModel(model)
        ? { ...model, model_category: 'smart_route' }
        : model
    ));
    res.json(normalizedModels);
  } catch { res.status(500).json({ error: '获取模型失败' }); }
});

// 公开：套餐列表
router.get('/api/package/list', async (req, res) => {
  try {
    const [packages] = await db.query('SELECT * FROM openclaw_packages WHERE status = "active" ORDER BY price');
    res.json({ packages });
  } catch { res.status(500).json({ error: '获取套餐失败' }); }
});

router.get('/api/app-market', async (_req, res) => {
  try {
    const [apps] = await db.query(
      'SELECT id, name, description, url FROM openclaw_app_market ORDER BY id DESC'
    );
    res.json({ apps });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取应用市场失败' });
  }
});

router.get('/api/blog', async (_req, res) => {
  try {
    const [posts] = await db.query(
      'SELECT id, title, summary, created_at, updated_at FROM openclaw_blog_posts WHERE status = "published" ORDER BY id DESC'
    );
    res.json({ posts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取博客列表失败' });
  }
});

router.get('/api/blog/:id', async (req, res) => {
  try {
    const [[post]] = await db.query(
      'SELECT id, title, summary, content, created_at, updated_at FROM openclaw_blog_posts WHERE id = ? AND status = "published"',
      [Number(req.params.id)]
    );
    if (!post) return res.status(404).json({ error: '文章不存在' });
    res.json({ post });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取文章失败' });
  }
});

// 公开：游客 Key 查询/订单查询/购买入口
router.use('/api/guest', require('../../routes/guest'));

// SSO 鉴权路由
router.use('/api/user', authMiddleware, require('./routes/user'));
router.use('/api/api-key', authMiddleware, require('./routes/apiKey'));
router.use('/api/logs', authMiddleware, require('./routes/logs'));
router.use('/api/admin', authMiddleware, require('./routes/admin'));
router.use('/api/admin/queue', authMiddleware, require('./routes/queueStatus'));
router.use('/api/package', authMiddleware, require('./routes/packages'));

// 支付路由
const paymentRoutes = require('./routes/payment');
router.use('/api/payment', authMiddleware, paymentRoutes);
router.use('/api/user-extend', authMiddleware, require('./routes/userExtend'));
router.use('/payment', paymentRoutes); // 支付宝回调不需要鉴权

// 邮箱验证码（复用主后端 emailCode 模块）
router.use('/api/email-code', require('../../routes/emailCode'));

// 健康检查
router.get('/api/internal/metrics', requireInternalSecret, async (req, res) => {
  const queueStats = await getQueueStats();
  const schedulerSummary = await getSchedulerSummary();
  const pool = typeof db.getPool === 'function' ? db.getPool() : db;
  const dbStats = {
    total: pool?._allConnections?.length || 0,
    free: pool?._freeConnections?.length || 0,
    waiting: pool?._connectionQueue?.length || 0,
  };
  res.type('text/plain; version=0.0.4').send(renderPrometheusMetrics({
    queueStats,
    dbStats,
    redisReady: cache.redis?.status === 'ready',
    schedulerSummary,
  }));
});

router.get('/api/health', async (req, res) => {
  const queue = await getQueueStats();
  const upstreams = await getSchedulerSummary();
  const metricsSnapshot = getSnapshot();
  let mysql = { ok: false };
  let redis = { ok: false };

  try {
    await db.query('SELECT 1');
    mysql = { ok: true };
  } catch (error) {
    mysql = { ok: false, error: error.message };
  }

  try {
    if (cache.redis && cache.redis.status === 'ready') {
      await cache.redis.ping();
      redis = { ok: true };
    } else {
      redis = { ok: false, error: 'redis_not_ready' };
    }
  } catch (error) {
    redis = { ok: false, error: error.message };
  }

  const ok = mysql.ok && (redis.ok || !process.env.REDIS_URL);
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    time: new Date().toISOString(),
    mysql,
    redis,
    queue,
    upstreams,
    latency: metricsSnapshot.latencyStages,
  });
});

// 日志清理 cron（每天凌晨3点清理30天前日志）
function scheduleCleanup() {
  if (process.env.NODE_APP_INSTANCE && process.env.NODE_APP_INSTANCE !== '0') return;
  const now = new Date();
  const next = new Date();
  next.setHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(async function run() {
    try {
      const [result] = await db.query(
        'DELETE FROM openclaw_request_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)'
      );
      if (result.affectedRows > 0) console.log(`[AI-GW] 已清理 ${result.affectedRows} 条旧日志`);
    } catch (e) { console.error('[AI-GW] 清理失败:', e.message); }
    setTimeout(run, 24 * 60 * 60 * 1000);
  }, next - now);
}
scheduleCleanup();

module.exports = router;
