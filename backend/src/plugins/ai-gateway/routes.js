const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/db');
const { authMiddleware } = require('./middleware/auth');
const { apiKeyAuth } = require('./middleware/apiKeyAuth');
const { internalAuth } = require('./middleware/internalAuth');
const { requestQueueMiddleware } = require('./middleware/requestQueue');
const { createDebugRecorder, detectRequestedModel, detectRouteName } = require('./utils/requestDebug');

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

// 公开：模型列表
router.get('/api/models', async (req, res) => {
  try {
    const [models] = await db.query(
      `SELECT model_id, display_name, provider,
              input_price_per_1k, output_price_per_1k, price_currency,
              billing_mode, per_call_price, model_category
       FROM openclaw_models
       WHERE status = "active"
       ORDER BY sort_order`
    );
    res.json(models);
  } catch { res.status(500).json({ error: '获取模型失败' }); }
});

// 公开：套餐列表
router.get('/api/package/list', async (req, res) => {
  try {
    const [packages] = await db.query('SELECT * FROM openclaw_packages WHERE status = "active" ORDER BY price');
    res.json({ packages });
  } catch { res.status(500).json({ error: '获取套餐失败' }); }
});

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
router.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// 日志清理 cron（每天凌晨3点清理30天前日志）
function scheduleCleanup() {
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
