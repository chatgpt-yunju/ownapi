const router = require('express').Router();
const axios = require('axios');
const http = require('http');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const db = require('../../../config/db');
const PROVIDERS = require('../config/models');
const {
  calculateCost,
  getModelBillingMeta,
  reserveModelCharge,
  settleModelCharge,
  refundModelCharge,
  roundAmount,
} = require('../utils/billing');
const cache = require('../utils/cache');
const { noteCcClubRateLimit } = require('../utils/ccClubKeyGuard');
const { createDebugRecorder } = require('../utils/requestDebug');
const { extractUpstreamErrorMessage } = require('../utils/upstreamError');

// ── HTTP Keep-Alive：复用 TCP 连接，降低上游请求延迟 ──────────────────────
const axiosInstance = axios.create({
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 100, maxFreeSockets: 20 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 100, maxFreeSockets: 20 }),
});

const MODEL_CACHE_TTL = 10 * 60 * 1000;          // 模型配置缓存 10 分钟
const UPSTREAM_CACHE_TTL = 10 * 60 * 1000;       // 上游配置缓存 10 分钟
const MONTHLY_QUOTA_CACHE_TTL = 5 * 60 * 1000;  // 月度限额缓存 5 分钟
const PRE_RESERVE = 0.01;

function hasQuotaCoverageAfterMonthlyLimit(billingContext) {
  const balanceAfter = Number(billingContext?.balanceAfter || 0);
  const reservedAmount = Number(billingContext?.reservedAmount || 0);
  return roundAmount(balanceAfter + reservedAmount) > 0;
}

// ========== 模型 & 上游缓存查询 ==========
async function getModelConfig(modelId) {
  const cacheKey = `model:${modelId}`;
  const cached = await cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const [[row]] = await db.query('SELECT * FROM openclaw_models WHERE model_id = ? AND status = "active"', [modelId]);
  const result = row || null;
  await cache.set(cacheKey, result, MODEL_CACHE_TTL);
  return result;
}

async function getModelUpstreams(modelDbId) {
  const cacheKey = `upstreams:${modelDbId}`;
  const cached = await cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const [rows] = await db.query(
    `SELECT id, provider_name, base_url, api_key, upstream_model_id, weight
     FROM openclaw_model_upstreams WHERE model_id = ? AND status = 'active'
     ORDER BY sort_order, id`,
    [modelDbId]
  );
  await cache.set(cacheKey, rows, UPSTREAM_CACHE_TTL);
  return rows;
}

async function getProviderEndpoints(modelConfig) {
  const cacheKey = `provider-endpoints:${modelConfig.id}`;
  const cached = await cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const [endpoints] = await db.query(
    `SELECT pe.id, p.name AS provider_name, pe.base_url, pe.api_key, mp.upstream_model_id, pe.weight
     FROM openclaw_model_providers mp
     JOIN openclaw_providers p ON mp.provider_id = p.id
     JOIN openclaw_provider_endpoints pe ON pe.provider_id = p.id
     WHERE mp.model_id = ? AND mp.status = 'active' AND p.status = 'active' AND pe.status = 'active'
     ORDER BY pe.id`,
    [modelConfig.id]
  );
  if (endpoints.length > 0) {
    await cache.set(cacheKey, endpoints, UPSTREAM_CACHE_TTL);
    return endpoints;
  }

  const [legacy] = await db.query(
    `SELECT p.id, p.name AS provider_name, p.base_url, p.api_key, mp.upstream_model_id, COALESCE(p.weight, 1) AS weight
     FROM openclaw_model_providers mp
     JOIN openclaw_providers p ON mp.provider_id = p.id
     WHERE mp.model_id = ? AND mp.status = 'active' AND p.status = 'active'
       AND p.base_url IS NOT NULL AND p.api_key IS NOT NULL
     ORDER BY p.id`,
    [modelConfig.id]
  );
  await cache.set(cacheKey, legacy, UPSTREAM_CACHE_TTL);
  return legacy;
}

async function getAvailableUpstreams(modelConfig) {
  const providerEndpoints = await getProviderEndpoints(modelConfig);
  if (providerEndpoints.length > 0) return providerEndpoints;
  return getModelUpstreams(modelConfig.id);
}

// ========== Upstream 失败计数器（内存） ==========
// key: "upstream_id" → { fails: number, lastFail: timestamp }
// 每10分钟衰减一半，避免永久惩罚
const upstreamFailures = new Map();
const DECAY_INTERVAL = 10 * 60 * 1000; // 10分钟

function getFailCount(upstreamId) {
  const rec = upstreamFailures.get(upstreamId);
  if (!rec) return 0;
  const elapsed = Date.now() - rec.lastFail;
  const decayFactor = Math.pow(0.5, elapsed / DECAY_INTERVAL);
  return rec.fails * decayFactor;
}

function recordFail(upstreamId) {
  const rec = upstreamFailures.get(upstreamId) || { fails: 0, lastFail: Date.now() };
  rec.fails = getFailCount(upstreamId) + 1;
  rec.lastFail = Date.now();
  upstreamFailures.set(upstreamId, rec);
}

function recordSuccess(upstreamId) {
  const rec = upstreamFailures.get(upstreamId);
  if (rec) {
    rec.fails = Math.max(0, getFailCount(upstreamId) - 0.5);
    rec.lastFail = Date.now();
  }
}

// ========== Relay 重试工具 ==========
// cc club 等 relay 服务账号池不稳定，遇到 500/503 自动重试。
// Claude 账号池经常需要更长的等待窗口，浏览器/API 调试链路需要贴近 Claude CLI 的重试节奏。
const DEFAULT_RELAY_RETRY_CONFIG = Object.freeze({
  maxRetries: 3,
  baseDelayMs: 1500,
  backoffFactor: 1,
  maxDelayMs: 1500,
});

const CLAUDE_RELAY_RETRY_CONFIG = Object.freeze({
  maxRetries: 8,
  baseDelayMs: 1500,
  backoffFactor: 2,
  maxDelayMs: 8000,
});

function getRelayRetryConfig({ model } = {}) {
  const normalizedModel = String(model || '').toLowerCase();
  if (normalizedModel.includes('claude')) {
    return CLAUDE_RELAY_RETRY_CONFIG;
  }
  return DEFAULT_RELAY_RETRY_CONFIG;
}

function getRelayRetryDelayMs(attempt, retryConfig) {
  const baseDelayMs = retryConfig?.baseDelayMs ?? DEFAULT_RELAY_RETRY_CONFIG.baseDelayMs;
  const backoffFactor = retryConfig?.backoffFactor ?? DEFAULT_RELAY_RETRY_CONFIG.backoffFactor;
  const maxDelayMs = retryConfig?.maxDelayMs ?? DEFAULT_RELAY_RETRY_CONFIG.maxDelayMs;
  const delay = baseDelayMs * Math.pow(backoffFactor, Math.max(0, attempt - 1));
  return Math.min(maxDelayMs, delay);
}

async function getRelayRetryDecision(err) {
  const status = err.response?.status;
  const message = await extractUpstreamErrorMessage(err, err.message || 'Upstream request failed');

  if (err?.response && message) {
    err.response.data = { error: { message } };
  }

  if (status !== 500 && status !== 503) {
    return { retryable: false, message, status };
  }

  const retryable = message.includes('No available')
    || message.includes('service_unavailable')
    || message.includes('Service temporarily');

  return { retryable, message, status };
}

async function withRelayRetry(fn, { model, debug, logger, retryConfig } = {}) {
  let lastErr;
  const effectiveRetryConfig = retryConfig || getRelayRetryConfig({ model });
  const maxRetries = effectiveRetryConfig.maxRetries || DEFAULT_RELAY_RETRY_CONFIG.maxRetries;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryDecision = await getRelayRetryDecision(err);
      if (!retryDecision.retryable || attempt === maxRetries) throw err;
      const msg = retryDecision.message || err.message;
      const delayMs = getRelayRetryDelayMs(attempt, effectiveRetryConfig);
      console.log(`[Relay Retry] model=${model} attempt=${attempt}/${maxRetries} delay=${delayMs}ms status=${retryDecision.status} reason=${msg.slice(0, 100)}`);
      if (debug) await debug.step(6, 'info', { retry_attempt: attempt, next_delay_ms: delayMs, reason: msg.slice(0, 200) });
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

function setHeaderIfPresent(headers, name, value) {
  if (value === undefined || value === null || value === '') return;
  headers[name] = Array.isArray(value) ? value.join(',') : String(value);
}

function buildAnthropicUpstreamHeaders(req, apiKey, betas) {
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
    'Content-Type': 'application/json',
  };

  const betaHeader = req.headers['anthropic-beta']
    || (betas ? (Array.isArray(betas) ? betas.join(',') : betas) : null);
  if (betaHeader) headers['anthropic-beta'] = betaHeader;

  // Claude Code CLI adds extra Anthropic/Stainless headers that some relays
  // use for routing or account-pool selection. Keep a tight whitelist.
  const passthroughHeaders = [
    'x-anthropic-billing-header',
    'anthropic-client-sha',
    'anthropic-dangerous-direct-browser-access',
    'user-agent',
  ];
  for (const name of passthroughHeaders) {
    setHeaderIfPresent(headers, name, req.headers[name]);
  }
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.startsWith('x-stainless-')) {
      setHeaderIfPresent(headers, name, value);
    }
  }

  return headers;
}

// 熔断器：连续失败 5 次后熔断 60 秒，防止请求堆积在故障上游
const CIRCUIT_OPEN_THRESHOLD = 5;
const CIRCUIT_RESET_MS = 60 * 1000;

function isCircuitOpen(upstreamId) {
  const rec = upstreamFailures.get(upstreamId);
  if (!rec) return false;
  const decayedFails = getFailCount(upstreamId);
  if (decayedFails >= CIRCUIT_OPEN_THRESHOLD) {
    if (Date.now() - rec.lastFail < CIRCUIT_RESET_MS) return true;
    rec.fails = 0; // 超时后半开：允许一次探测
  }
  return false;
}

// 智能选择：过滤熔断上游 → 失败少的优先 → 同分组内权重随机
function selectUpstream(upstreams) {
  if (upstreams.length === 1) return upstreams[0];

  // 过滤掉熔断中的上游（全部熔断时降级使用全部，避免 503）
  const available = upstreams.filter(u => !isCircuitOpen(u.id));
  const pool = available.length > 0 ? available : upstreams;

  // 按失败次数排序（少→多）
  const scored = pool.map(u => ({ ...u, failScore: getFailCount(u.id) }));
  scored.sort((a, b) => a.failScore - b.failScore);
  // 取失败最少的一组（failScore 差距 < 0.5 视为同组）
  const minFail = scored[0].failScore;
  const best = scored.filter(u => u.failScore - minFail < 0.5);
  // 在最优组内按权重随机
  const totalW = best.reduce((s, u) => s + (u.weight || 1), 0);
  let r = Math.random() * totalW;
  for (const u of best) {
    r -= (u.weight || 1);
    if (r <= 0) return u;
  }
  return best[0];
}

function normalizeUpstreamProviderName(providerName) {
  return String(providerName || '').trim().toLowerCase();
}

function isGoogleNativeBaseUrl(baseUrl) {
  const value = String(baseUrl || '');
  return value.includes('generativelanguage.googleapis.com') || /:(generateContent|streamGenerateContent)(\?|$)/.test(value);
}

function detectUpstreamApiFormat(model, providerName, baseUrl) {
  const normalizedProvider = normalizeUpstreamProviderName(providerName);
  const normalizedBaseUrl = String(baseUrl || '');
  if (normalizedProvider === 'google' || isGoogleNativeBaseUrl(normalizedBaseUrl)) return 'google_native';
  if (
    model.includes('claude') && (
      normalizedProvider.includes('ccclub') || normalizedProvider === 'anthropic' ||
      normalizedBaseUrl.includes('claude-code.club') || normalizedBaseUrl.includes('anthropic.com')
    )
  ) {
    return 'anthropic';
  }
  return 'openai_compatible';
}

function updateUpstreamUrlQueryParam(url, key, value) {
  try {
    const parsed = new URL(url);
    if (value === null || value === undefined || value === '') {
      parsed.searchParams.delete(key);
    } else {
      parsed.searchParams.set(key, value);
    }
    return parsed.toString();
  } catch {
    if (value === null || value === undefined || value === '') return url;
    return url.includes('?') ? `${url}&${key}=${encodeURIComponent(value)}` : `${url}?${key}=${encodeURIComponent(value)}`;
  }
}

function resolveGoogleGenerateContentUrl(baseUrl, upstreamModel, isStream) {
  const trimmed = String(baseUrl || '').replace(/\/+$/, '');
  if (/:(generateContent|streamGenerateContent)(\?|$)/.test(trimmed)) {
    let directUrl = trimmed;
    if (isStream) {
      directUrl = directUrl.replace(/:generateContent(?=(\?|$))/, ':streamGenerateContent');
      return updateUpstreamUrlQueryParam(directUrl, 'alt', 'sse');
    }
    directUrl = directUrl.replace(/:streamGenerateContent(?=(\?|$))/, ':generateContent');
    return updateUpstreamUrlQueryParam(directUrl, 'alt', null);
  }

  let cleanBaseUrl = trimmed
    .replace(/\/models\/[^/?]+:(?:generateContent|streamGenerateContent)(?:\?.*)?$/, '')
    .replace(/\/+$/, '');
  if (!/\/v1(?:beta)?$/.test(cleanBaseUrl)) cleanBaseUrl = `${cleanBaseUrl}/v1beta`;

  const endpoint = `${cleanBaseUrl}/models/${encodeURIComponent(upstreamModel)}:${isStream ? 'streamGenerateContent' : 'generateContent'}`;
  return isStream ? updateUpstreamUrlQueryParam(endpoint, 'alt', 'sse') : endpoint;
}

function messageContentToPlainText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text') return part.text || '';
    return '';
  }).join('');
}

function mapOpenAIToolsToGemini(tools) {
  const functionDeclarations = (Array.isArray(tools) ? tools : [])
    .filter((tool) => tool?.type === 'function' && tool.function?.name)
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description || undefined,
      parameters: tool.function.parameters || { type: 'object', properties: {} }
    }));
  return functionDeclarations.length ? [{ functionDeclarations }] : undefined;
}

function mapOpenAIToolChoiceToGemini(toolChoice) {
  if (!toolChoice || toolChoice === 'auto') return undefined;
  if (toolChoice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (toolChoice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
  if (typeof toolChoice === 'object' && toolChoice.type === 'function' && toolChoice.function?.name) {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [toolChoice.function.name]
      }
    };
  }
  return undefined;
}

function buildGeminiGenerateContentRequest(messages, { temperature, max_tokens, top_p, tools, tool_choice } = {}) {
  const systemTexts = [];
  const contents = [];

  for (const message of messages || []) {
    const text = messageContentToPlainText(message?.content);
    if (!text) continue;
    if (message.role === 'system') {
      systemTexts.push(text);
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text }]
    });
  }

  const body = {
    contents: contents.length ? contents : [{ role: 'user', parts: [{ text: '' }] }]
  };
  if (systemTexts.length) body.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };

  const generationConfig = {};
  if (temperature !== undefined) generationConfig.temperature = temperature;
  if (max_tokens !== undefined) generationConfig.maxOutputTokens = max_tokens;
  if (top_p !== undefined) generationConfig.topP = top_p;
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

  const geminiTools = mapOpenAIToolsToGemini(tools);
  if (geminiTools) body.tools = geminiTools;
  const geminiToolConfig = mapOpenAIToolChoiceToGemini(tool_choice);
  if (geminiToolConfig) body.toolConfig = geminiToolConfig;

  return body;
}

function extractGeminiCandidateText(candidate) {
  return (candidate?.content?.parts || []).map((part) => part?.text || '').join('');
}

// 运行时迁移：model_id官方化（去除provider前缀）+ 按provider binding设置upstream_model_id
(async () => {
  try {
    await db.query('ALTER TABLE openclaw_model_providers ADD COLUMN upstream_model_id VARCHAR(200) DEFAULT NULL').catch(() => {});
    const [[{ cnt }]] = await db.query("SELECT COUNT(*) as cnt FROM openclaw_models WHERE model_id LIKE '%/%'");
    if (cnt > 0) {
      // Step1: 备份完整路径到 upstream_model_id（兜底）
      await db.query("UPDATE openclaw_models SET upstream_model_id = model_id WHERE model_id LIKE '%/%' AND (upstream_model_id IS NULL OR upstream_model_id = model_id)");
      // Step2: 去掉 model_id 中的 provider 前缀
      await db.query("UPDATE openclaw_models SET model_id = SUBSTRING(model_id, INSTR(model_id, '/') + 1) WHERE model_id LIKE '%/%'");
      // Step3: 对 nvidia provider 的 binding，写入 upstream_model_id（带前缀的完整路径）
      await db.query("UPDATE openclaw_model_providers mp JOIN openclaw_models m ON mp.model_id = m.id JOIN openclaw_providers p ON mp.provider_id = p.id SET mp.upstream_model_id = m.upstream_model_id WHERE p.name = 'nvidia' AND m.upstream_model_id IS NOT NULL AND mp.upstream_model_id IS NULL");
      console.log('[AI Gateway] Model ID migration completed: stripped provider prefix from model_ids');
    }
  } catch (e) {
    console.error('[AI Gateway] Migration error:', e.message);
  }
})();

function createRouteRecorder(req, requestId, model) {
  return createDebugRecorder({
    requestId,
    traceType: req.aiGatewayTraceType || 'live',
    routeName: req.aiGatewayRouteName || 'chat.completions',
    requestPath: req.originalUrl,
    model,
    userId: req.apiUserId || null,
    apiKeyId: req.apiKeyId || null,
  });
}

function describeUpstreams(upstreams) {
  return (upstreams || []).slice(0, 10).map((item) => ({
    id: item.id,
    provider: item.provider_name || null,
    base_url: item.base_url,
    weight: item.weight || 1,
    fail_score: Number(getFailCount(item.id).toFixed(2)),
    circuit_open: isCircuitOpen(item.id),
    upstream_model_id: item.upstream_model_id || null,
  }));
}

function getChargedAmountForLog(modelConfig, tokenCost = 0) {
  const billing = getModelBillingMeta(modelConfig);
  return billing.billingMode === 'per_call' ? billing.perCallPrice : roundAmount(tokenCost);
}

function getLogExtra(modelConfig, chargedAmount = 0, tokenSource = 'upstream') {
  const billing = getModelBillingMeta(modelConfig);
  return {
    tokenSource,
    billingMode: billing.billingMode,
    chargedBalanceType: billing.balanceType,
    chargedAmount: roundAmount(chargedAmount),
  };
}

async function reserveRequestCharge(req, modelConfig, requestId, debug, model, errorFactory) {
  const billing = getModelBillingMeta(modelConfig);
  const billingContext = await reserveModelCharge(req.apiUserId, modelConfig, PRE_RESERVE, {
    route: req.aiGatewayRouteName || 'chat.completions',
    request_id: requestId,
    model,
  });

  if (!billingContext.success) {
    await debug.step(3, 'error', {
      reason: 'pre_reserve_insufficient_balance',
      billing_mode: billing.billingMode,
      balance_type: billing.balanceType,
      required_amount: billing.billingMode === 'per_call' ? billing.perCallPrice : PRE_RESERVE,
      current_balance: billingContext.balance || 0,
    }, { errorMessage: '余额不足' });
    await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'insufficient_balance', '余额不足', requestId, getLogExtra(modelConfig, 0));
    return {
      ok: false,
      response: errorFactory(billing),
    };
  }

  billingContext.finalized = false;
  req.preReserved = billingContext.reservedAmount || 0;
  req.userBalance = billingContext.balanceAfter;

  await debug.step(3, 'success', {
    billing_mode: billing.billingMode,
    balance_type: billing.balanceType,
    reserved_amount: billingContext.reservedAmount || 0,
    balance_before: billingContext.balanceBefore,
    balance_after: billingContext.balanceAfter,
  });

  return {
    ok: true,
    billing,
    billingContext,
  };
}

async function releasePendingCharge(req, modelConfig, billingContext, requestId, model, reason) {
  if (!billingContext || billingContext.finalized) return;
  await refundModelCharge(req.apiUserId, modelConfig, billingContext, reason, {
    route: req.aiGatewayRouteName || 'chat.completions',
    request_id: requestId,
    model,
  }).catch((error) => console.error('[Billing] refund failed:', error.message));
  billingContext.finalized = true;
}

function buildOpenAIUpstreamUrl(baseUrl, suffix) {
  const trimmedBase = String(baseUrl || '').replace(/\/+$/, '');
  if (trimmedBase.endsWith(`/${suffix}`)) return trimmedBase;
  const cleanBaseUrl = trimmedBase
    .replace(/\/v1\/messages\/?$/, '')
    .replace(/\/v1\/chat\/completions\/?$/, '')
    .replace(/\/v1\/responses\/?$/, '')
    .replace(/\/v1\/embeddings\/?$/, '')
    .replace(/\/v1\/?$/, '')
    .replace(/\/+$/, '');
  return `${cleanBaseUrl}/v1/${suffix}`;
}

// POST /v1/embeddings — OpenAI Embeddings API 兼容端点
router.post('/embeddings', async (req, res) => {
  const requestId = req.aiGatewayRequestId || `embd_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
  const { model, input, encoding_format, dimensions, input_type, truncate, modality } = req.body;
  const debug = createRouteRecorder(req, requestId, model);
  res.setHeader('X-Request-Id', requestId);

  if (!model || input === undefined || input === null) {
    await debug.step(1, 'error', {
      has_model: Boolean(model),
      has_input: input !== undefined && input !== null,
    }, {
      errorMessage: 'model and input are required'
    });
    return res.status(400).json({ error: { message: 'model and input are required', type: 'invalid_request_error' } });
  }

  let modelConfig;
  try {
    modelConfig = await getModelConfig(model);
    if (!modelConfig) {
      await debug.step(5, 'error', { reason: 'model_not_found' }, { errorMessage: `Model '${model}' not found or disabled` });
      return res.status(400).json({ error: { message: `Model '${model}' not found or disabled`, type: 'invalid_request_error' } });
    }
  } catch (err) {
    console.error('Model lookup error:', err);
    await debug.step(5, 'error', { reason: 'model_lookup_failed' }, { errorMessage: err.message });
    return res.status(500).json({ error: { message: 'Internal server error', type: 'server_error' } });
  }

  if (req.userModelsAllowed) {
    const allowedProviders = req.userModelsAllowed.split(',').map(s => s.trim());
    const modelProvider = modelConfig.provider;
    const modelId = modelConfig.model_id;
    const isClaude = modelId.includes('claude') || modelProvider === 'anthropic' || modelProvider === 'ccclub';
    const isOpenAI = modelId.startsWith('openai/') || modelProvider === 'openai' || modelId.includes('gpt-');
    const isGoogle = modelId.startsWith('google/') || modelProvider === 'google' || modelId.includes('gemma') || modelId.includes('gemini');
    if (isClaude || isOpenAI || isGoogle) {
      await debug.step(2, 'error', {
        reason: 'model_forbidden_by_package',
        package_models_allowed: allowedProviders,
        provider: modelProvider,
      }, { errorMessage: '当前套餐不支持使用此模型' });
      await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'model_forbidden', '模型不在套餐允许范围内', requestId, getLogExtra(modelConfig, 0));
      return res.status(403).json({ error: { message: '当前套餐不支持使用此模型，请升级套餐', type: 'permission_error' } });
    }
  }

  const reservation = await reserveRequestCharge(req, modelConfig, requestId, debug, model, (billing) => ({
    status: 402,
    body: {
      error: {
        message: billing.balanceType === 'wallet'
          ? '钱包余额不足，请先充值后再调用按次计费模型。'
          : '余额不足，当前额度已用尽。请购买加油包或升级套餐以继续使用。',
        type: 'billing_error',
      }
    }
  }));
  if (!reservation.ok) {
    return res.status(reservation.response.status).json(reservation.response.body);
  }
  const billingMeta = reservation.billing;
  const billingContext = reservation.billingContext;

  try {
    const [[userPkg]] = await db.query(
      `SELECT p.daily_limit, p.monthly_quota, up.started_at, up.expires_at
       FROM openclaw_user_packages up
       JOIN openclaw_packages p ON up.package_id = p.id
       WHERE up.user_id = ? AND up.status = 'active' AND (up.expires_at IS NULL OR up.expires_at > NOW())
       ORDER BY up.started_at DESC LIMIT 1`,
      [req.apiUserId]
    );
    if (userPkg) {
      const monthStart = userPkg.started_at || new Date(Date.now() - 30 * 24 * 3600000);
      if (userPkg.daily_limit) {
        const monthlyCallLimit = userPkg.daily_limit * 30;
        const [[callCount]] = await db.query(
          'SELECT COUNT(*) as cnt FROM openclaw_call_logs WHERE user_id = ? AND created_at >= ? AND status = "success"',
          [req.apiUserId, monthStart]
        );
        if (callCount.cnt >= monthlyCallLimit) {
          await debug.step(3, 'error', { reason: 'monthly_call_limit_exceeded', used_calls: callCount.cnt, limit: monthlyCallLimit }, { errorMessage: '月度调用次数已达上限' });
          await releasePendingCharge(req, modelConfig, billingContext, requestId, model, 'embeddings 调用次数超限，释放预留余额');
          await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'call_limit_exceeded', `月度调用次数已达上限 ${monthlyCallLimit}`, requestId, getLogExtra(modelConfig, 0));
          return res.status(429).json({ error: { message: `月度调用次数已达上限（${callCount.cnt}/${monthlyCallLimit} 次）。请购买加油包或升级套餐以继续使用。`, type: 'rate_limit_error' } });
        }
      }
      if (userPkg.monthly_quota && billingMeta.billingMode === 'token') {
        const [[monthCost]] = await db.query(
          'SELECT COALESCE(SUM(total_cost), 0) as cost FROM openclaw_call_logs WHERE user_id = ? AND created_at >= ? AND status = "success"',
          [req.apiUserId, monthStart]
        );
        const quota = Number(userPkg.monthly_quota);
        const used = Number(monthCost.cost);
        if (used >= quota && !hasQuotaCoverageAfterMonthlyLimit(billingContext)) {
          await debug.step(3, 'error', { reason: 'monthly_quota_exceeded', used_cost: used, quota }, { errorMessage: '月度配额已用尽' });
          await releasePendingCharge(req, modelConfig, billingContext, requestId, model, 'embeddings 月度配额超限，释放预留余额');
          await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'quota_exceeded', `月度配额已用尽 $${used.toFixed(4)}/$${quota.toFixed(2)}`, requestId, getLogExtra(modelConfig, 0));
          return res.status(429).json({ error: { message: `月度配额已用尽（$${used.toFixed(4)}/$${quota.toFixed(2)}）。请购买加油包或升级套餐以增加配额。`, type: 'rate_limit_error' } });
        }
      }
    }
  } catch (err) {
    console.error('[Embeddings Limit Check Error]:', err);
  }

  let baseUrl;
  let apiKey;
  let allProviders = [];
  let selectedProviderName = null;

  const upstreams = await getAvailableUpstreams(modelConfig);
  let selectedBindingUpstreamModelId = null;
  let selectedUpstreamId = null;
  if (upstreams.length > 0) {
    allProviders = [...upstreams];
    const selected = selectUpstream(upstreams);
    baseUrl = selected.base_url;
    apiKey = selected.api_key;
    selectedProviderName = selected.provider_name || null;
    selectedBindingUpstreamModelId = selected.upstream_model_id || null;
    selectedUpstreamId = selected.id;
  } else {
    const provider = PROVIDERS.getProviderConfig
      ? PROVIDERS.getProviderConfig(modelConfig.provider)
      : (PROVIDERS[modelConfig.provider] || {});
    baseUrl = modelConfig.upstream_endpoint || provider.baseUrl;
    apiKey = modelConfig.upstream_key || provider.apiKey;
  }

  if (!baseUrl || !apiKey) {
    await debug.step(5, 'error', { reason: 'provider_not_configured' }, { errorMessage: 'Model provider not configured' });
    await releasePendingCharge(req, modelConfig, billingContext, requestId, model, 'embeddings 未配置上游，释放预留余额');
    return res.status(503).json({ error: { message: 'Model provider not configured', type: 'server_error' } });
  }

  const upstreamModel = selectedBindingUpstreamModelId || modelConfig.upstream_model_id || model;
  const upstreamUrl = buildOpenAIUpstreamUrl(baseUrl, 'embeddings');
  const upstreamBody = { model: upstreamModel, input };
  if (encoding_format !== undefined) upstreamBody.encoding_format = encoding_format;
  if (dimensions !== undefined) upstreamBody.dimensions = dimensions;
  if (input_type !== undefined) upstreamBody.input_type = input_type;
  if (truncate !== undefined) upstreamBody.truncate = truncate;
  if (modality !== undefined) upstreamBody.modality = modality;

  await debug.step(5, 'success', {
    selected_upstream_id: selectedUpstreamId,
    selected_provider: selectedProviderName,
    selected_base_url: baseUrl,
    selected_upstream_model_id: upstreamModel,
    upstream_count: upstreams.length,
    upstream_candidates: describeUpstreams(allProviders.length ? allProviders : upstreams),
    api_format: 'openai_compatible',
    upstream_url: upstreamUrl,
  });

  try {
    await debug.step(6, 'pending', {
      stream: false,
      upstream_id: selectedUpstreamId,
      upstream_url: upstreamUrl,
      provider: selectedProviderName,
    });

    const upstreamRes = await axiosInstance.post(upstreamUrl, upstreamBody, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 120000
    });

    if (selectedUpstreamId) recordSuccess(selectedUpstreamId);

    const usage = upstreamRes.data?.usage || {};
    const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? usage.total_tokens ?? 0;
    const completionTokens = 0;
    const tokenCost = await calculateCost(
      promptTokens,
      completionTokens,
      modelConfig.input_price_per_1k,
      modelConfig.output_price_per_1k,
      modelConfig.price_currency
    );
    const settleResult = await settleModelCharge(
      req.apiUserId,
      modelConfig,
      billingContext,
      tokenCost,
      `Embeddings ${model}`,
      {
        route: req.aiGatewayRouteName || 'embeddings',
        request_id: requestId,
        model,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
      }
    );
    billingContext.finalized = true;
    const chargedAmount = settleResult?.chargedAmount ?? getChargedAmountForLog(modelConfig, tokenCost);

    await debug.step(7, 'success', {
      stream: false,
      status_code: upstreamRes.status,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      charged_amount: chargedAmount,
    });
    await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, tokenCost, req.ip, 'success', null, requestId, getLogExtra(modelConfig, chargedAmount));
    return res.json(upstreamRes.data);
  } catch (err) {
    if (selectedUpstreamId) recordFail(selectedUpstreamId);
    const errMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message || 'Upstream request failed';
    const isTimeout = err.code === 'ECONNABORTED' || String(errMsg).toLowerCase().includes('timeout');
    console.error(`Upstream error [embeddings model=${model}, upstream=${baseUrl}]:`, errMsg);
    await debug.step(6, 'error', {
      stream: false,
      upstream_id: selectedUpstreamId,
      upstream_url: upstreamUrl,
      provider: selectedProviderName,
      status_code: err.response?.status || null,
    }, { errorMessage: errMsg });
    await debug.step(7, 'error', {
      stream: false,
      status_code: err.response?.status || null,
    }, { errorMessage: errMsg });
    await releasePendingCharge(req, modelConfig, billingContext, requestId, model, 'embeddings 请求失败，释放预留余额');
    await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'error', errMsg, requestId, getLogExtra(modelConfig, 0));
    const statusCode = isTimeout ? 503 : (err.response?.status || 502);
    return res.status(statusCode).json({
      error: { message: errMsg, type: isTimeout ? 'overloaded_error' : 'upstream_error' }
    });
  }
});

// POST /v1/chat/completions — 核心转发
router.post('/chat/completions', async (req, res) => {
  const requestId = req.aiGatewayRequestId || `chatcmpl-${uuidv4().replace(/-/g, '').slice(0, 24)}`;
  const { model, messages, stream = false, temperature, max_tokens, top_p, tools, tool_choice } = req.body;
  const debug = createRouteRecorder(req, requestId, model);
  res.setHeader('X-Request-Id', requestId);

  if (!model || !messages) {
    await debug.step(1, 'error', {
      has_model: Boolean(model),
      has_messages: Boolean(messages),
    }, {
      errorMessage: 'model and messages are required'
    });
    return res.status(400).json({ error: { message: 'model and messages are required', type: 'invalid_request_error' } });
  }

  // 查模型配置（缓存）
  let modelConfig;
  try {
    modelConfig = await getModelConfig(model);
    if (!modelConfig) {
      await debug.step(5, 'error', { reason: 'model_not_found' }, { errorMessage: `Model '${model}' not found or disabled` });
      return res.status(400).json({ error: { message: `Model '${model}' not found or disabled`, type: 'invalid_request_error' } });
    }
  } catch (err) {
    console.error('Model lookup error:', err);
    await debug.step(5, 'error', { reason: 'model_lookup_failed' }, { errorMessage: err.message });
    return res.status(500).json({ error: { message: 'Internal server error', type: 'server_error' } });
  }

 // 检查模型权限（Free套餐限制）
 if (req.userModelsAllowed) {
   const allowedProviders = req.userModelsAllowed.split(",").map(s => s.trim());
   const modelProvider = modelConfig.provider;
   const modelId = modelConfig.model_id;
   // 检查模型ID是否以禁止的provider开头
   const isClaude = modelId.includes("claude") || modelProvider === "anthropic" || modelProvider === "ccclub";
   const isOpenAI = modelId.startsWith("openai/") || modelProvider === "openai" || modelId.includes("gpt-");
   const isGoogle = modelId.startsWith("google/") || modelProvider === "google" || modelId.includes("gemma") || modelId.includes("gemini");
   if (isClaude || isOpenAI || isGoogle) {
     await debug.step(2, 'error', {
       reason: 'model_forbidden_by_package',
       package_models_allowed: allowedProviders,
       provider: modelProvider,
     }, { errorMessage: '当前套餐不支持使用此模型' });
     await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, "model_forbidden", "模型不在套餐允许范围内", requestId, getLogExtra(modelConfig, 0));
     return res.status(403).json({ error: { message: `当前套餐不支持使用此模型，请升级套餐`, type: "permission_error" } });
   }
 }

  const reservation = await reserveRequestCharge(req, modelConfig, requestId, debug, model, (billing) => ({
    status: 402,
    body: {
      error: {
        message: billing.balanceType === 'wallet'
          ? '钱包余额不足，请先充值后再调用按次计费模型。'
          : '余额不足，当前额度已用尽。请购买加油包或升级套餐以继续使用。',
        type: 'billing_error',
      }
    }
  }));
  if (!reservation.ok) {
    return res.status(reservation.response.status).json(reservation.response.body);
  }
  const billingMeta = reservation.billing;
  const billingContext = reservation.billingContext;

  // 检查月度调用次数限制（聚合查询缓存 5 分钟，减少全表扫描）
  try {
    const [[userPkg]] = await db.query(
      `SELECT p.daily_limit, p.monthly_quota, up.started_at, up.expires_at
       FROM openclaw_user_packages up
       JOIN openclaw_packages p ON up.package_id = p.id
       WHERE up.user_id = ? AND up.status = 'active' AND (up.expires_at IS NULL OR up.expires_at > NOW())
       ORDER BY up.started_at DESC LIMIT 1`,
      [req.apiUserId]
    );
    if (userPkg) {
      const monthStart = userPkg.started_at || new Date(Date.now() - 30 * 24 * 3600000);
      const needCallLimit = !!userPkg.daily_limit;
      const needCostLimit = !!(userPkg.monthly_quota && billingMeta.billingMode === 'token');

      if (needCallLimit || needCostLimit) {
        // 单次查询同时取 COUNT 和 SUM，并用 Redis 缓存 5 分钟
        const yearMonth = new Date(monthStart).toISOString().slice(0, 7);
        const monthCacheKey = `monthly:${req.apiUserId}:${yearMonth}`;
        let monthlyStats = await cache.get(monthCacheKey);
        if (monthlyStats === undefined) {
          const [[row]] = await db.query(
            `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_cost), 0) AS cost
             FROM openclaw_call_logs
             WHERE user_id = ? AND created_at >= ? AND status = 'success'`,
            [req.apiUserId, monthStart]
          );
          monthlyStats = { cnt: Number(row.cnt), cost: Number(row.cost) };
          await cache.set(monthCacheKey, monthlyStats, MONTHLY_QUOTA_CACHE_TTL);
        }

        if (needCallLimit) {
          const monthlyCallLimit = userPkg.daily_limit * 30;
          if (monthlyStats.cnt >= monthlyCallLimit) {
            await debug.step(3, 'error', { reason: 'monthly_call_limit_exceeded', used_calls: monthlyStats.cnt, limit: monthlyCallLimit }, { errorMessage: '月度调用次数已达上限' });
            await releasePendingCharge(req, modelConfig, billingContext, requestId, model, 'chat.completions 调用次数超限，释放预留余额');
            await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'call_limit_exceeded', `月度调用次数已达上限 ${monthlyCallLimit}`, requestId, getLogExtra(modelConfig, 0));
            return res.status(429).json({ error: { message: `月度调用次数已达上限（${monthlyStats.cnt}/${monthlyCallLimit} 次）。请购买加油包或升级套餐以提升限额。`, type: 'rate_limit_error' } });
          }
        }

        if (needCostLimit) {
          const quota = Number(userPkg.monthly_quota);
          const used = monthlyStats.cost;
          if (used >= quota && !hasQuotaCoverageAfterMonthlyLimit(billingContext)) {
            await debug.step(3, 'error', { reason: 'monthly_quota_exceeded', used_cost: used, quota }, { errorMessage: '月度配额已用尽' });
            await releasePendingCharge(req, modelConfig, billingContext, requestId, model, 'chat.completions 月度配额超限，释放预留余额');
            await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'quota_exceeded', `月度配额已用尽 $${used.toFixed(4)}/$${quota.toFixed(2)}`, requestId, getLogExtra(modelConfig, 0));
            return res.status(429).json({ error: { message: `月度配额已用尽（$${used.toFixed(4)}/$${quota.toFixed(2)}）。请购买加油包或升级套餐以增加配额。`, type: 'rate_limit_error' } });
          }
        }
      }
    }
  } catch (err) {
    console.error('Limit check error:', err);
    // 限额检查失败不阻断请求，继续处理
  }

  // 确定上游地址（从 model_upstreams 直接读取，429 自动轮询）
  let baseUrl, apiKey;
  let allProviders = [];
  let selectedProviderName = null;

  const upstreams = await getAvailableUpstreams(modelConfig);

  let selectedBindingUpstreamModelId = null;
  let selectedUpstreamId = null;
  if (upstreams.length > 0) {
    allProviders = [...upstreams];
    const selected = selectUpstream(upstreams);
    baseUrl = selected.base_url;
    apiKey = selected.api_key;
    selectedProviderName = selected.provider_name || null;
    selectedBindingUpstreamModelId = selected.upstream_model_id || null;
    selectedUpstreamId = selected.id;
  } else {
    const provider = PROVIDERS.getProviderConfig
      ? PROVIDERS.getProviderConfig(modelConfig.provider)
      : (PROVIDERS[modelConfig.provider] || {});
    baseUrl = modelConfig.upstream_endpoint || provider.baseUrl;
    apiKey = modelConfig.upstream_key || provider.apiKey;
  }

  if (!baseUrl || !apiKey) {
    await debug.step(5, 'error', { reason: 'provider_not_configured' }, { errorMessage: 'Model provider not configured' });
    await releasePendingCharge(req, modelConfig, billingContext, requestId, model, 'chat.completions 未配置上游，释放预留余额');
    return res.status(503).json({ error: { message: 'Model provider not configured', type: 'server_error' } });
  }

  // 识别上游协议：Anthropic / Google Gemini 原生 / OpenAI 兼容
  const upstreamModel = selectedBindingUpstreamModelId || modelConfig.upstream_model_id || model;
  const upstreamApiFormat = detectUpstreamApiFormat(model, selectedProviderName || modelConfig.provider, baseUrl);
  const isAnthropicAPI = upstreamApiFormat === 'anthropic';
  const isGoogleNativeAPI = upstreamApiFormat === 'google_native';

  // 根据 API 类型确定 URL
  let upstreamUrl;
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  if (isGoogleNativeAPI) {
    upstreamUrl = resolveGoogleGenerateContentUrl(baseUrl, upstreamModel, stream);
  } else if (trimmedBase.match(/\/chat\/completions$/)) {
    // upstream_endpoint 已含完整路径（如火山引擎 /api/v3/chat/completions）
    upstreamUrl = trimmedBase;
  } else if (isAnthropicAPI && trimmedBase.match(/\/messages$/)) {
    upstreamUrl = trimmedBase;
  } else {
    const cleanBaseUrl = trimmedBase
      .replace(/\/v1\/messages\/?$/, '')
      .replace(/\/v1\/chat\/completions\/?$/, '')
      .replace(/\/v1\/?$/, '')
      .replace(/\/+$/, '');
    if (isAnthropicAPI) {
      upstreamUrl = `${cleanBaseUrl}/v1/messages`;
    } else {
      upstreamUrl = `${cleanBaseUrl}/v1/chat/completions`;
    }
  }

  try {
    // 构建转发请求
    // upstream_model_id 优先级：binding级（按baseurl对应）> 模型级（兜底）> 请求中的model
    let upstreamBody, headers;

    if (isAnthropicAPI) {
      // Anthropic API 格式
      upstreamBody = {
        model: upstreamModel,
        messages,
        max_tokens: max_tokens || 4096
      };
      if (temperature !== undefined) upstreamBody.temperature = temperature;
      if (top_p !== undefined) upstreamBody.top_p = top_p;
      if (stream) upstreamBody.stream = true;

      headers = {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      };
    } else if (isGoogleNativeAPI) {
      upstreamBody = buildGeminiGenerateContentRequest(messages, { temperature, max_tokens, top_p, tools, tool_choice });
      headers = {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json'
      };
    } else {
      // OpenAI 兼容格式
      upstreamBody = { model: upstreamModel, messages, stream };
      if (stream) {
        upstreamBody.stream_options = { include_usage: true };
      }
      if (temperature !== undefined) upstreamBody.temperature = temperature;
      if (max_tokens !== undefined) upstreamBody.max_tokens = max_tokens;
      if (top_p !== undefined) upstreamBody.top_p = top_p;
      if (tools) upstreamBody.tools = tools;
      if (tool_choice) upstreamBody.tool_choice = tool_choice;

      // NVIDIA API: 不再自动添加 upstream_provider，大多数模型不接受此参数

      headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      };
    }

    await debug.step(5, 'success', {
      selected_upstream_id: selectedUpstreamId,
      selected_provider: selectedProviderName,
      selected_base_url: baseUrl,
      selected_upstream_model_id: selectedBindingUpstreamModelId || modelConfig.upstream_model_id || model,
      upstream_count: upstreams.length,
      upstream_candidates: describeUpstreams(allProviders.length ? allProviders : upstreams),
      api_format: upstreamApiFormat,
      upstream_url: upstreamUrl,
    });

    if (stream) {
      await debug.step(6, 'pending', {
        stream: true,
        upstream_id: selectedUpstreamId,
        upstream_url: upstreamUrl,
        provider: selectedProviderName,
      });
      // 流式响应（带 relay 重试）
      const upstreamRes = await withRelayRetry(
        () => axiosInstance.post(upstreamUrl, upstreamBody, { headers, responseType: 'stream', timeout: 120000 }),
        { model, debug }
      );

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Request-Id', requestId);

      let fullContent = '';
      let promptTokens = 0;
      let completionTokens = 0;
      let cacheWriteTokens = 0;
      let cacheReadTokens = 0;
      let cachedTokens = 0;
      let streamUsageAnth = {}; // 完整 usage 对象，供 end 回调使用
      let tokenCountIsEstimated = false;
      let anthropicBuffer = ''; // 缓存 Anthropic SSE 数据
      let googleBuffer = '';
      let googleFinishReason = 'stop';
      let openAICompatibleBuffer = '';
      let sawGeminiNativeOpenAIStream = false;
      let geminiOverOpenAIFinishReason = 'stop';

      upstreamRes.data.on('data', (chunk) => {
        const text = chunk.toString();

        if (isAnthropicAPI) {
          // 转换 Anthropic SSE 为 OpenAI 格式
          anthropicBuffer += text;
          const lines = anthropicBuffer.split('\n');

          // 保留最后一行（可能不完整）
          anthropicBuffer = lines.pop() || '';

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (!data) continue;

              try {
                const parsed = JSON.parse(data);

                if (parsed.type === 'message_start') {
                  streamUsageAnth = parsed.message?.usage || {};
                  promptTokens    = streamUsageAnth.input_tokens || 0;
                  cacheWriteTokens = streamUsageAnth.cache_creation_input_tokens || 0;
                  cacheReadTokens  = streamUsageAnth.cache_read_input_tokens || 0;
                  console.log(`[Anthropic Stream] message_start: input=${promptTokens} cache_write=${cacheWriteTokens} cache_read=${cacheReadTokens}`);
                } else if (parsed.type === 'content_block_delta') {
                  // 只转发 text_delta，跳过 thinking_delta
                  const delta = parsed.delta?.type === 'text_delta' ? (parsed.delta?.text || '') : '';
                  if (delta) {
                    fullContent += delta;
                    // 发送 OpenAI 格式的 chunk
                    const openaiChunk = {
                      id: requestId,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model,
                      choices: [{
                        index: 0,
                        delta: { content: delta },
                        finish_reason: null
                      }]
                    };
                    res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
                  }
                } else if (parsed.type === 'message_delta') {
                  completionTokens = parsed.usage?.output_tokens || 0;
                  console.log(`[Anthropic Stream] message_delta: output_tokens=${completionTokens}`);
                } else if (parsed.type === 'message_stop') {
                  // 发送结束标记
                  const finalChunk = {
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                      index: 0,
                      delta: {},
                      finish_reason: 'stop'
                    }]
                  };
                  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                  res.write('data: [DONE]\n\n');
                }
              } catch (e) { /* ignore parse errors */ }
            }
          }
        } else if (isGoogleNativeAPI) {
          googleBuffer += text;
          const lines = googleBuffer.split('\n');
          googleBuffer = lines.pop() || '';

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data) continue;

            try {
              const parsed = JSON.parse(data);
              const candidate = parsed.candidates?.[0];
              const delta = extractGeminiCandidateText(candidate);
              if (delta) {
                fullContent += delta;
                const openaiChunk = {
                  id: requestId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{
                    index: 0,
                    delta: { content: delta },
                    finish_reason: null
                  }]
                };
                res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
              }
              const usage = parsed.usageMetadata || {};
              promptTokens = usage.promptTokenCount || promptTokens;
              completionTokens = usage.candidatesTokenCount || completionTokens;
              if (candidate?.finishReason) {
                googleFinishReason = candidate.finishReason === 'MAX_TOKENS' ? 'length' : 'stop';
              }
            } catch (e) { /* ignore parse errors */ }
          }
        } else {
          openAICompatibleBuffer += text;
          const lines = openAICompatibleBuffer.split('\n');
          openAICompatibleBuffer = lines.pop() || '';

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              if (!sawGeminiNativeOpenAIStream) res.write('data: [DONE]\n\n');
              continue;
            }
            try {
              const parsed = JSON.parse(data);
              if (parsed.candidates) {
                sawGeminiNativeOpenAIStream = true;
                const candidate = parsed.candidates?.[0];
                const delta = extractGeminiCandidateText(candidate);
                if (delta) {
                  fullContent += delta;
                  const openaiChunk = {
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                      index: 0,
                      delta: { content: delta },
                      finish_reason: null
                    }]
                  };
                  res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
                }
                const usage = parsed.usageMetadata || {};
                promptTokens = usage.promptTokenCount || promptTokens;
                completionTokens = usage.candidatesTokenCount || completionTokens;
                if (candidate?.finishReason) {
                  geminiOverOpenAIFinishReason = candidate.finishReason === 'MAX_TOKENS' ? 'length' : 'stop';
                }
                continue;
              }

              const ok = res.write(`data: ${data}\n\n`);
              if (!ok) {
                upstreamRes.data.pause();
                res.once('drain', () => upstreamRes.data.resume());
              }
              if (parsed.usage) {
                promptTokens     = parsed.usage.prompt_tokens || promptTokens;
                completionTokens = parsed.usage.completion_tokens || completionTokens;
                cachedTokens     = parsed.usage.prompt_tokens_details?.cached_tokens || cachedTokens;
              }
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) fullContent += delta;
            } catch (e) {
              const ok = res.write(`${rawLine}\n`);
              if (!ok) {
                upstreamRes.data.pause();
                res.once('drain', () => upstreamRes.data.resume());
              }
            }
          }
        }
      });

      upstreamRes.data.on('end', async () => {
        if (isGoogleNativeAPI) {
          const finalChunk = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: googleFinishReason
            }]
          };
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
        } else if (sawGeminiNativeOpenAIStream) {
          const finalChunk = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: geminiOverOpenAIFinishReason
            }]
          };
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
        }
        res.end();
        if (selectedUpstreamId) recordSuccess(selectedUpstreamId);
        // 估算 token（如果上游未返回 usage）
        if (!promptTokens) {
          promptTokens = estimateTokens(messages);
          tokenCountIsEstimated = true;
        }
        if (!completionTokens) {
          completionTokens = estimateTokens(fullContent);
          tokenCountIsEstimated = true;
        }

        const tokenSource = tokenCountIsEstimated ? 'estimated' : 'upstream';
        const effectivePrompt = tokenCountIsEstimated ? promptTokens
          : isAnthropicAPI ? calcEffectiveInputTokens(streamUsageAnth, true)
          : isGoogleNativeAPI ? promptTokens
          : calcEffectiveInputTokens({ prompt_tokens: promptTokens, prompt_tokens_details: { cached_tokens: cachedTokens } }, false);
        console.log(`[Stream End] Model: ${model}, Prompt: ${promptTokens}, Effective: ${effectivePrompt.toFixed(1)}, Completion: ${completionTokens}, Source: ${tokenSource}`);

        const cost = await calculateCost(effectivePrompt, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
        const result = await settleModelCharge(
          req.apiUserId,
          modelConfig,
          cost,
          `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`,
          billingContext,
          { route: 'chat.completions', request_id: requestId, model }
        );
        billingContext.finalized = true;
        const logExtra = getLogExtra(modelConfig, getChargedAmountForLog(modelConfig, cost), tokenSource);
        await debug.step(6, 'success', {
          stream: true,
          upstream_id: selectedUpstreamId,
          provider: selectedProviderName,
          upstream_url: upstreamUrl,
        });
        if (result.success) {
          await debug.step(7, 'success', {
            stream: true,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            token_source: tokenSource,
            total_cost: cost,
          });
          await debug.step(8, 'skipped', { reason: 'no_recovery_needed' });
          await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId, logExtra);
          await saveRequestDetail(requestId, req.apiUserId, model, messages, null, fullContent);
        } else {
          await debug.step(7, 'error', {
            stream: true,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_cost: cost,
          }, { errorMessage: '余额不足（流式响应后扣款失败）' });
          await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'insufficient_balance', '余额不足（流式响应后扣款失败）', requestId, getLogExtra(modelConfig, billingContext.reservedAmount || 0, tokenSource));
          await saveRequestDetail(requestId, req.apiUserId, model, messages, null, fullContent);
          console.error(`[Billing] Stream billing failed for user ${req.apiUserId}, cost: ${cost}, balance: ${result.balance}`);
        }
      });

      upstreamRes.data.on('error', async (err) => {
        console.error('Stream error:', err);
        res.end();
        await debug.step(6, 'error', { stream: true, upstream_id: selectedUpstreamId, upstream_url: upstreamUrl }, { errorMessage: err.message });
        await debug.step(8, 'error', {
          reason: 'stream_upstream_error',
          fallback_candidates: Math.max(0, allProviders.length - 1),
        }, { errorMessage: err.message });
        await releasePendingCharge(req, modelConfig, billingContext, requestId, model, 'chat.completions 流式上游错误，释放预留余额');
        await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'error', err.message, requestId, getLogExtra(modelConfig, 0));
        await saveRequestDetail(requestId, req.apiUserId, model, messages, null, null);
      });

    } else {
      await debug.step(6, 'pending', {
        stream: false,
        upstream_id: selectedUpstreamId,
        upstream_url: upstreamUrl,
        provider: selectedProviderName,
      });
      // 非流式响应（带 relay 重试）
      const upstreamRes = await withRelayRetry(
        () => axiosInstance.post(upstreamUrl, upstreamBody, { headers, timeout: 120000 }),
        { model, debug }
      );

      const data = upstreamRes.data;
      let promptTokens, completionTokens, responseContent;

      if (isAnthropicAPI) {
        // Anthropic API 响应格式
        console.log(`[Upstream Usage] Model: ${model}, Raw usage:`, JSON.stringify(data.usage));
        promptTokens = data.usage?.input_tokens || estimateTokens(messages);
        completionTokens = data.usage?.output_tokens || 0;
        responseContent = extractTextFromContent(data.content);
        const effectivePrompt1 = calcEffectiveInputTokens(data.usage, true);
        console.log(`[Token Stats] Model: ${model}, Prompt: ${promptTokens}, Effective: ${effectivePrompt1.toFixed(1)}, Completion: ${completionTokens}`);

        // 转换为 OpenAI 格式返回
        const cost = await calculateCost(effectivePrompt1, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
        const result = await settleModelCharge(
          req.apiUserId,
          modelConfig,
          cost,
          `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`,
          billingContext,
          { route: 'chat.completions', request_id: requestId, model }
        );
        billingContext.finalized = true;
        const logExtra = getLogExtra(modelConfig, getChargedAmountForLog(modelConfig, cost));
        await debug.step(6, 'success', {
          stream: false,
          upstream_id: selectedUpstreamId,
          upstream_url: upstreamUrl,
          status_code: upstreamRes.status,
        });

        if (!result.success) {
          await debug.step(7, 'error', {
            stream: false,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_cost: cost,
          }, { errorMessage: '额度已用尽' });
          await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'insufficient_balance', '余额不足', requestId, getLogExtra(modelConfig, billingContext.reservedAmount || 0));
          return res.status(402).json({ error: { message: '额度已用尽', type: 'billing_error' } });
        }

        await debug.step(7, 'success', {
          stream: false,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_cost: cost,
        });
        await debug.step(8, 'skipped', { reason: 'no_recovery_needed' });
        await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId, logExtra);
        await saveRequestDetail(requestId, req.apiUserId, model, messages, null, responseContent);

        res.json({
          id: requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: responseContent },
            finish_reason: data.stop_reason || 'stop'
          }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
        });
      } else {
        // OpenAI 兼容格式（或 Gemini 原生格式）
        console.log(`[Upstream Usage] Model: ${model}, Raw usage:`, JSON.stringify(data.usage || data.usageMetadata));

        // 检测是否为 Gemini 原生响应格式（candidates 结构）
        if (data.candidates) {
          // Gemini 原生格式转换
          const candidate = data.candidates[0];
          const geminiText = candidate?.content?.parts?.map(p => p.text || '').join('') || '';
          const usage = data.usageMetadata || {};
          promptTokens = usage.promptTokenCount || estimateTokens(messages);
          completionTokens = usage.candidatesTokenCount || estimateTokens(geminiText);

          const cost = await calculateCost(promptTokens, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
          const result = await settleModelCharge(
            req.apiUserId,
            modelConfig,
            cost,
            `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`,
            billingContext,
            { route: 'chat.completions', request_id: requestId, model }
          );
          billingContext.finalized = true;
          const logExtra = getLogExtra(modelConfig, getChargedAmountForLog(modelConfig, cost));
          if (!result.success) {
            await debug.step(7, 'error', {
              stream: false,
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_cost: cost,
            }, { errorMessage: 'Insufficient balance for this request' });
            await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'insufficient_balance', '余额不足', requestId, getLogExtra(modelConfig, billingContext.reservedAmount || 0));
            return res.status(402).json({ error: { message: 'Insufficient balance for this request', type: 'billing_error' } });
          }
          await debug.step(6, 'success', {
            stream: false,
            upstream_id: selectedUpstreamId,
            upstream_url: upstreamUrl,
            status_code: upstreamRes.status,
            response_format: 'gemini_native',
          });
          await debug.step(7, 'success', {
            stream: false,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_cost: cost,
            response_format: 'gemini_native',
          });
          await debug.step(8, 'skipped', { reason: 'no_recovery_needed' });
          await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId, logExtra);
          await saveRequestDetail(requestId, req.apiUserId, model, messages, null, geminiText);

          const geminiFinish = candidate?.finishReason === 'MAX_TOKENS' ? 'length' : 'stop';
          res.json({
            id: requestId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, message: { role: 'assistant', content: geminiText }, finish_reason: geminiFinish }],
            usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
          });
        } else {
        // 标准 OpenAI 兼容格式
        promptTokens = data.usage?.prompt_tokens || estimateTokens(messages);
        completionTokens = data.usage?.completion_tokens || estimateTokens(data.choices?.[0]?.message?.content || '');
        const effectivePrompt2 = calcEffectiveInputTokens(data.usage, false);
        console.log(`[Token Stats] Model: ${model}, Prompt: ${promptTokens}, Effective: ${effectivePrompt2.toFixed(1)}, Completion: ${completionTokens}`);

        const cost = await calculateCost(effectivePrompt2, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);

        // 扣费
        const result = await settleModelCharge(
          req.apiUserId,
          modelConfig,
          cost,
          `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`,
          billingContext,
          { route: 'chat.completions', request_id: requestId, model }
        );
        billingContext.finalized = true;
        const logExtra = getLogExtra(modelConfig, getChargedAmountForLog(modelConfig, cost));
        if (!result.success) {
          await debug.step(7, 'error', {
            stream: false,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_cost: cost,
          }, { errorMessage: 'Insufficient balance for this request' });
          await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'insufficient_balance', '余额不足', requestId, getLogExtra(modelConfig, billingContext.reservedAmount || 0));
          return res.status(402).json({ error: { message: 'Insufficient balance for this request', type: 'billing_error' } });
        }

        await debug.step(6, 'success', {
          stream: false,
          upstream_id: selectedUpstreamId,
          upstream_url: upstreamUrl,
          status_code: upstreamRes.status,
          response_format: 'openai_compatible',
        });
        await debug.step(7, 'success', {
          stream: false,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_cost: cost,
          response_format: 'openai_compatible',
        });
        await debug.step(8, 'skipped', { reason: 'no_recovery_needed' });
        await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId, logExtra);
        await saveRequestDetail(requestId, req.apiUserId, model, messages, null, data.choices?.[0]?.message?.content || '');

        // 统一返回格式
        res.json({
          id: requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: data.choices,
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
        });
        }
      }
    }
  } catch (err) {
    if (selectedUpstreamId) recordFail(selectedUpstreamId);
    const errMsg = await extractUpstreamErrorMessage(err);
    const is429 = err.response?.status === 429 || errMsg.includes('429') || errMsg.toLowerCase().includes('rate limit');
    if (is429) {
      await noteCcClubRateLimit({
        providerName: selectedProviderName,
        baseUrl,
        apiKey,
        errorMessage: errMsg,
        statusCode: err.response?.status || 429,
        source: 'chat.completions'
      });
    }

    if (is429 && allProviders.length > 1) {
      console.log(`[429 Retry] upstream ${selectedUpstreamId} 失败(score=${getFailCount(selectedUpstreamId).toFixed(1)})，${allProviders.length - 1} 个备选`);
      await debug.step(8, 'error', {
        reason: 'upstream_rate_limited',
        fallback_candidates: allProviders.length - 1,
        selected_upstream_id: selectedUpstreamId,
        provider: selectedProviderName,
      }, { errorMessage: errMsg });
      await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'rate_limit_error', `429: upstream ${selectedUpstreamId}`, requestId, getLogExtra(modelConfig, 0));
    } else {
      await debug.step(8, 'error', {
        reason: is429 ? 'upstream_rate_limited_without_backup' : 'upstream_failed',
        fallback_candidates: Math.max(0, allProviders.length - 1),
        selected_upstream_id: selectedUpstreamId,
        provider: selectedProviderName,
      }, { errorMessage: errMsg });
    }

    const isTimeout = err.code === 'ECONNABORTED' || errMsg.toLowerCase().includes('timeout');
    console.error(`Upstream error [model=${model}, upstream=${baseUrl}]:`, errMsg);
    await debug.step(6, 'error', {
      stream,
      upstream_id: selectedUpstreamId,
      upstream_url: upstreamUrl,
      provider: selectedProviderName,
      status_code: err.response?.status || null,
    }, { errorMessage: errMsg });
    await debug.step(7, 'error', {
      stream,
      status_code: err.response?.status || null,
    }, { errorMessage: errMsg });
    await releasePendingCharge(req, modelConfig, billingContext, requestId, model, 'chat.completions 请求失败，释放预留余额');
    await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'error', errMsg, requestId, getLogExtra(modelConfig, 0));
    const statusCode = isTimeout ? 503 : (err.response?.status || 502);
    res.status(statusCode).json({
      error: { message: errMsg, type: isTimeout ? 'overloaded_error' : 'upstream_error' }
    });
  }
});

// ==========================================
// POST /v1/messages — Anthropic Messages API 兼容端点
// 支持 Claude Code CLI 等 Anthropic 原生客户端
// ==========================================
router.post('/messages', async (req, res) => {
  const requestId = req.aiGatewayRequestId || `msg_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
  const { model, messages, system, max_tokens, stream = false, temperature, top_p, top_k, tools, tool_choice, stop_sequences, thinking, metadata, betas } = req.body;
  const debug = createRouteRecorder(req, requestId, model);
  res.setHeader('X-Request-Id', requestId);

  if (!model || !messages) {
    await debug.step(1, 'error', {
      has_model: Boolean(model),
      has_messages: Boolean(messages),
    }, { errorMessage: 'model and messages are required' });
    return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'model and messages are required' } });
  }

  // 查模型配置（缓存）
  let modelConfig;
  try {
    modelConfig = await getModelConfig(model);
    if (!modelConfig) {
      await debug.step(5, 'error', { reason: 'model_not_found' }, { errorMessage: `Model '${model}' not found or disabled` });
      return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: `Model '${model}' not found or disabled` } });
    }
  } catch (err) {
    console.error('Model lookup error:', err);
    await debug.step(5, 'error', { reason: 'model_lookup_failed' }, { errorMessage: err.message });
    return res.status(500).json({ type: 'error', error: { type: 'server_error', message: 'Internal server error' } });
  }

  const reservation = await reserveRequestCharge(req, modelConfig, requestId, debug, model, (billing) => ({
    status: 402,
    body: {
      type: 'error',
      error: {
        type: 'billing_error',
        message: billing.balanceType === 'wallet'
          ? '钱包余额不足，请先充值后再调用按次计费模型。'
          : '余额不足，当前额度已用尽。请购买加油包或升级套餐以继续使用。',
      }
    }
  }));
  if (!reservation.ok) {
    return res.status(reservation.response.status).json(reservation.response.body);
  }
  const billingMeta2 = reservation.billing;
  const billingContext2 = reservation.billingContext;

 // 检查月度配额限制
 try {
 const [[userPkg]] = await db.query(
 `SELECT p.daily_limit, p.monthly_quota, up.started_at, up.expires_at
 FROM openclaw_user_packages up
 JOIN openclaw_packages p ON up.package_id = p.id
 WHERE up.user_id = ? AND up.status = 'active' AND (up.expires_at IS NULL OR up.expires_at > NOW())
 ORDER BY up.started_at DESC LIMIT 1`,
 [req.apiUserId]
 );
 if (userPkg) {
 const monthStart = userPkg.started_at || new Date(Date.now() - 30 * 24 * 3600000);
 if (userPkg.monthly_quota && billingMeta2.billingMode === 'token') {
 const [[monthCost]] = await db.query(
 'SELECT COALESCE(SUM(total_cost), 0) as cost FROM openclaw_call_logs WHERE user_id = ? AND created_at >= ? AND status = "success"',
 [req.apiUserId, monthStart]
 );
 const quota = Number(userPkg.monthly_quota);
 const used = Number(monthCost.cost);
 console.log(`[Messages Limit] User ${req.apiUserId}: quota $${used.toFixed(4)}/$${quota.toFixed(2)}`);
 if (used >= quota && !hasQuotaCoverageAfterMonthlyLimit(billingContext2)) {
 await debug.step(3, 'error', { reason: 'monthly_quota_exceeded', used_cost: used, quota }, { errorMessage: '月度配额已用尽' });
 await releasePendingCharge(req, modelConfig, billingContext2, requestId, model, 'messages 月度配额超限，释放预留余额');
 await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'quota_exceeded', `月度配额已用尽 $${used.toFixed(4)}/$${quota.toFixed(2)}`, requestId, getLogExtra(modelConfig, 0));
 return res.status(429).json({ type: 'error', error: { type: 'rate_limit_error', message: `月度配额已用尽（$${used.toFixed(4)}/$${quota.toFixed(2)}）。请购买加油包或升级套餐以增加配额。` } });
 }
 }
 }
 } catch (err) {
 console.error('[Messages Limit Check Error]:', err);
 }

  // 确定上游地址（从 model_upstreams 直接读取，429 自动轮询）
  let baseUrl, apiKey;
  let allProviders = [];
  let selectedProviderName2 = null;

  const upstreams2 = await getAvailableUpstreams(modelConfig);

  let selectedBindingUpstreamModelId2 = null;
  let selectedUpstreamId2 = null;
  if (upstreams2.length > 0) {
    allProviders = [...upstreams2];
    const selected = selectUpstream(upstreams2);
    baseUrl = selected.base_url;
    apiKey = selected.api_key;
    selectedProviderName2 = selected.provider_name || null;
    selectedBindingUpstreamModelId2 = selected.upstream_model_id || null;
    selectedUpstreamId2 = selected.id;
  } else {
    const provider = PROVIDERS.getProviderConfig
      ? PROVIDERS.getProviderConfig(modelConfig.provider)
      : (PROVIDERS[modelConfig.provider] || {});
    baseUrl = modelConfig.upstream_endpoint || provider.baseUrl;
    apiKey = modelConfig.upstream_key || provider.apiKey;
  }

  if (!baseUrl || !apiKey) {
    await debug.step(5, 'error', { reason: 'provider_not_configured' }, { errorMessage: 'Model provider not configured' });
    await releasePendingCharge(req, modelConfig, billingContext2, requestId, model, 'messages 未配置上游，释放预留余额');
    return res.status(503).json({ type: 'error', error: { type: 'server_error', message: 'Model provider not configured' } });
  }

  const upstreamModel = selectedBindingUpstreamModelId2 || modelConfig.upstream_model_id || model;
  const isClaudeModel2 = model.includes('claude');
  const isUpstreamAnthropic = isClaudeModel2 && (modelConfig.provider === 'ccclub' || modelConfig.provider === 'anthropic' || baseUrl.includes('claude-code.club') || baseUrl.includes('anthropic.com'));
  await debug.step(5, 'success', {
    selected_upstream_id: selectedUpstreamId2,
    selected_provider: selectedProviderName2,
    selected_base_url: baseUrl,
    selected_upstream_model_id: upstreamModel,
    upstream_count: upstreams2.length,
    upstream_candidates: describeUpstreams(allProviders.length ? allProviders : upstreams2),
    api_format: isUpstreamAnthropic ? 'anthropic' : 'openai_compatible',
  });

  try {
    if (isUpstreamAnthropic) {
      // ===== Anthropic 上游：直接透传 =====
      const upstreamUrl = baseUrl.includes('/messages') ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
      const upstreamBody = { model: upstreamModel, messages, max_tokens: max_tokens || 4096 };
      if (system) upstreamBody.system = system;
      if (temperature !== undefined) upstreamBody.temperature = temperature;
      if (top_p !== undefined) upstreamBody.top_p = top_p;
      if (top_k !== undefined) upstreamBody.top_k = top_k;
      if (tools) upstreamBody.tools = tools;
      if (tool_choice) upstreamBody.tool_choice = tool_choice;
      if (stop_sequences) upstreamBody.stop_sequences = stop_sequences;
      if (thinking) upstreamBody.thinking = thinking;
      if (metadata) upstreamBody.metadata = metadata;
      if (stream) upstreamBody.stream = true;

      const headers = buildAnthropicUpstreamHeaders(req, apiKey, betas);

      if (stream) {
        await debug.step(6, 'pending', {
          stream: true,
          upstream_id: selectedUpstreamId2,
          upstream_url: upstreamUrl,
          provider: selectedProviderName2,
        });
        const upstreamRes = await withRelayRetry(
          () => axiosInstance.post(upstreamUrl, upstreamBody, { headers, responseType: 'stream', timeout: 120000 }),
          { model, debug }
        );

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Request-Id', requestId);

        let promptTokens = 0, completionTokens = 0;
        let cacheWriteTokens5 = 0, cacheReadTokens5 = 0;
        let streamUsage5 = {};
        let sseBuffer = '';
        let fullContent = '';

        upstreamRes.data.on('data', (chunk) => {
          const text = chunk.toString();
          // 直接转发 SSE 给客户端（带背压控制）
          const ok = res.write(text);
          if (!ok) {
            upstreamRes.data.pause();
            res.once('drain', () => upstreamRes.data.resume());
          }

          // 解析 token usage 和内容
          sseBuffer += text;
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.type === 'message_start') {
                streamUsage5      = parsed.message?.usage || {};
                promptTokens      = streamUsage5.input_tokens || 0;
                cacheWriteTokens5 = streamUsage5.cache_creation_input_tokens || 0;
                cacheReadTokens5  = streamUsage5.cache_read_input_tokens || 0;
              } else if (parsed.type === 'message_delta') {
                completionTokens = parsed.usage?.output_tokens || 0;
              } else if (parsed.type === 'content_block_delta') {
                // 只累积文本内容，跳过 thinking_delta
                if (parsed.delta?.type === 'text_delta') fullContent += parsed.delta?.text || '';
              }
            } catch (e) { /* ignore */ }
          }
        });

        upstreamRes.data.on('end', async () => {
          res.end();
          if (selectedUpstreamId2) recordSuccess(selectedUpstreamId2);
          if (!promptTokens) promptTokens = estimateTokens(messages);
          if (!completionTokens) completionTokens = estimateTokens(fullContent);
          const effectivePrompt5 = promptTokens
            ? calcEffectiveInputTokens(streamUsage5, true)
            : promptTokens;
          const cost = await calculateCost(effectivePrompt5, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
          const result = await settleModelCharge(
            req.apiUserId,
            modelConfig,
            cost,
            `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`,
            billingContext2,
            { route: 'messages', request_id: requestId, model }
          );
          billingContext2.finalized = true;
          const logExtra = getLogExtra(modelConfig, getChargedAmountForLog(modelConfig, cost));
          await debug.step(6, 'success', {
            stream: true,
            upstream_id: selectedUpstreamId2,
            upstream_url: upstreamUrl,
          });
          if (!result.success) {
            await debug.step(7, 'error', {
              stream: true,
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_cost: cost,
            }, { errorMessage: '余额不足（流式响应后扣款失败）' });
            await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'insufficient_balance', '余额不足（流式响应后扣款失败）', requestId, getLogExtra(modelConfig, billingContext2.reservedAmount || 0));
            await saveRequestDetail(requestId, req.apiUserId, model, messages, system, fullContent);
            return;
          }
          await debug.step(7, 'success', {
            stream: true,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_cost: cost,
          });
          await debug.step(8, 'skipped', { reason: 'no_recovery_needed' });
          await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId, logExtra);
          await saveRequestDetail(requestId, req.apiUserId, model, messages, system, fullContent);
        });

        upstreamRes.data.on('error', async (err) => {
          if (selectedUpstreamId2) recordFail(selectedUpstreamId2);
          const errMsg = await extractUpstreamErrorMessage(err);
          console.error('Anthropic stream error:', errMsg);
          res.end();
          await debug.step(6, 'error', { stream: true, upstream_id: selectedUpstreamId2, upstream_url: upstreamUrl }, { errorMessage: errMsg });
          await debug.step(8, 'error', { reason: 'stream_upstream_error', fallback_candidates: Math.max(0, allProviders.length - 1) }, { errorMessage: errMsg });
          await releasePendingCharge(req, modelConfig, billingContext2, requestId, model, 'messages Anthropic stream error，释放预留余额');
          await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'error', errMsg, requestId, getLogExtra(modelConfig, 0));
          await saveRequestDetail(requestId, req.apiUserId, model, messages, system, null);
        });

      } else {
        await debug.step(6, 'pending', {
          stream: false,
          upstream_id: selectedUpstreamId2,
          upstream_url: upstreamUrl,
          provider: selectedProviderName2,
        });
        // 非流式 Anthropic 透传（带 relay 重试）
        const upstreamRes = await withRelayRetry(
          () => axiosInstance.post(upstreamUrl, upstreamBody, { headers, timeout: 120000 }),
          { model, debug }
        );
        const data = upstreamRes.data;

        const promptTokens = data.usage?.input_tokens || estimateTokens(messages);
        const completionTokens = data.usage?.output_tokens || 0;
        const effectivePrompt6 = calcEffectiveInputTokens(data.usage, true);

        const cost = await calculateCost(effectivePrompt6, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
        const result = await settleModelCharge(
          req.apiUserId,
          modelConfig,
          cost,
          `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`,
          billingContext2,
          { route: 'messages', request_id: requestId, model }
        );
        billingContext2.finalized = true;
        const logExtra = getLogExtra(modelConfig, getChargedAmountForLog(modelConfig, cost));

        if (!result.success) {
          await debug.step(7, 'error', { stream: false, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_cost: cost }, { errorMessage: '额度已用尽' });
          await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'insufficient_balance', '余额不足', requestId, getLogExtra(modelConfig, billingContext2.reservedAmount || 0));
          return res.status(402).json({ type: 'error', error: { type: 'billing_error', message: '额度已用尽' } });
        }

        await debug.step(6, 'success', { stream: false, upstream_id: selectedUpstreamId2, upstream_url: upstreamUrl, status_code: upstreamRes.status });
        await debug.step(7, 'success', { stream: false, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_cost: cost });
        await debug.step(8, 'skipped', { reason: 'no_recovery_needed' });
        await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId, logExtra);
        await saveRequestDetail(requestId, req.apiUserId, model, messages, system, extractTextFromContent(data.content));

        if (selectedUpstreamId2) recordSuccess(selectedUpstreamId2);
        data.id = requestId;
        data.model = model;
        res.json(data);
      }

    } else {
      // ===== OpenAI 兼容上游：格式转换 =====
      const cleanBase2 = baseUrl
        .replace(/\/v1\/messages\/?$/, '')
        .replace(/\/v1\/chat\/completions\/?$/, '')
        .replace(/\/v1\/?$/, '')
        .replace(/\/+$/, '');
      const upstreamUrl = `${cleanBase2}/v1/chat/completions`;

      // 转换 Anthropic messages → OpenAI messages
      const openaiMessages = convertAnthropicToOpenAIMessages(system, messages);
      const openaiBody = { model: upstreamModel, messages: openaiMessages, stream };
      if (stream) openaiBody.stream_options = { include_usage: true };
      if (temperature !== undefined) openaiBody.temperature = temperature;
      if (max_tokens !== undefined) openaiBody.max_tokens = max_tokens;
      if (top_p !== undefined) openaiBody.top_p = top_p;
      if (stop_sequences) openaiBody.stop = stop_sequences;

      // 转换 tools
      if (tools && tools.length > 0) {
        openaiBody.tools = tools.map(t => ({
          type: 'function',
          function: { name: t.name, description: t.description || '', parameters: t.input_schema || {} }
        }));
      }

      const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

      if (stream) {
        await debug.step(6, 'pending', {
          stream: true,
          upstream_id: selectedUpstreamId2,
          upstream_url: upstreamUrl,
          provider: selectedProviderName2,
        });
        const upstreamRes = await axiosInstance.post(upstreamUrl, openaiBody, { headers, responseType: 'stream', timeout: 120000 });

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Request-Id', requestId);

        let promptTokens = 0, completionTokens = 0;
        let cachedTokens7 = 0;
        let fullContent = '';
        let sseBuffer = '';
        let contentBlockStarted = false;
        let toolCallBuffers = {}; // tool_call_id -> { name, arguments }

        // 发送 Anthropic message_start 事件
        const messageStart = {
          type: 'message_start',
          message: {
            id: requestId, type: 'message', role: 'assistant', model,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        };
        res.write(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`);

        upstreamRes.data.on('data', (chunk) => {
          sseBuffer += chunk.toString();
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              if (parsed.usage) {
                promptTokens     = parsed.usage.prompt_tokens || promptTokens;
                completionTokens = parsed.usage.completion_tokens || completionTokens;
                cachedTokens7    = parsed.usage.prompt_tokens_details?.cached_tokens || cachedTokens7;
              }

              const choice = parsed.choices?.[0];
              if (!choice) continue;

              // 处理文本内容
              const deltaContent = choice.delta?.content;
              if (deltaContent) {
                if (!contentBlockStarted) {
                  contentBlockStarted = true;
                  res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
                }
                fullContent += deltaContent;
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: deltaContent } })}\n\n`);
              }

              // 处理 tool_calls
              const toolCalls = choice.delta?.tool_calls;
              if (toolCalls) {
                for (const tc of toolCalls) {
                  const idx = tc.index;
                  if (!toolCallBuffers[idx]) {
                    toolCallBuffers[idx] = { id: tc.id || '', name: tc.function?.name || '', arguments: '' };
                  }
                  if (tc.function?.name) toolCallBuffers[idx].name = tc.function.name;
                  if (tc.function?.arguments) toolCallBuffers[idx].arguments += tc.function.arguments;
                }
              }

              // 流结束
              if (choice.finish_reason) {
                if (contentBlockStarted) {
                  res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
                }

                // 输出 tool_use 块
                const toolEntries = Object.entries(toolCallBuffers);
                for (let i = 0; i < toolEntries.length; i++) {
                  const [, tc] = toolEntries[i];
                  const blockIdx = contentBlockStarted ? i + 1 : i;
                  let inputObj = {};
                  try { inputObj = JSON.parse(tc.arguments); } catch (e) { /* ignore */ }
                  res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIdx, content_block: { type: 'tool_use', id: tc.id || `toolu_${uuidv4().slice(0, 8)}`, name: tc.name, input: {} } })}\n\n`);
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(inputObj) } })}\n\n`);
                  res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIdx })}\n\n`);
                }

                const stopReason = convertFinishReason(choice.finish_reason);
                res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: completionTokens || estimateTokens(fullContent) } })}\n\n`);
                res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
              }
            } catch (e) { /* ignore parse errors */ }
          }
        });

        upstreamRes.data.on('end', async () => {
          res.end();
          if (selectedUpstreamId2) recordSuccess(selectedUpstreamId2);
          if (!promptTokens) promptTokens = estimateTokens(messages);
          if (!completionTokens) completionTokens = estimateTokens(fullContent);
          const effectivePrompt7 = promptTokens
            ? calcEffectiveInputTokens({ prompt_tokens: promptTokens, prompt_tokens_details: { cached_tokens: cachedTokens7 } }, false)
            : promptTokens;
          const cost = await calculateCost(effectivePrompt7, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
          const result = await settleModelCharge(
            req.apiUserId,
            modelConfig,
            cost,
            `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`,
            billingContext2,
            { route: 'messages', request_id: requestId, model }
          );
          billingContext2.finalized = true;
          const logExtra = getLogExtra(modelConfig, getChargedAmountForLog(modelConfig, cost));
          await debug.step(6, 'success', { stream: true, upstream_id: selectedUpstreamId2, upstream_url: upstreamUrl });
          if (!result.success) {
            await debug.step(7, 'error', { stream: true, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_cost: cost }, { errorMessage: '余额不足（流式响应后扣款失败）' });
            await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'insufficient_balance', '余额不足（流式响应后扣款失败）', requestId, getLogExtra(modelConfig, billingContext2.reservedAmount || 0));
            await saveRequestDetail(requestId, req.apiUserId, model, messages, system, fullContent);
            return;
          }
          await debug.step(7, 'success', { stream: true, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_cost: cost });
          await debug.step(8, 'skipped', { reason: 'no_recovery_needed' });
          await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId, logExtra);
          await saveRequestDetail(requestId, req.apiUserId, model, messages, system, fullContent);
        });

        upstreamRes.data.on('error', async (err) => {
          if (selectedUpstreamId2) recordFail(selectedUpstreamId2);
          const errMsg = await extractUpstreamErrorMessage(err);
          console.error('OpenAI→Anthropic stream error:', errMsg);
          res.end();
          await debug.step(6, 'error', { stream: true, upstream_id: selectedUpstreamId2, upstream_url: upstreamUrl }, { errorMessage: errMsg });
          await debug.step(8, 'error', { reason: 'stream_upstream_error', fallback_candidates: Math.max(0, allProviders.length - 1) }, { errorMessage: errMsg });
          await releasePendingCharge(req, modelConfig, billingContext2, requestId, model, 'messages OpenAI stream error，释放预留余额');
          await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'error', errMsg, requestId, getLogExtra(modelConfig, 0));
          await saveRequestDetail(requestId, req.apiUserId, model, messages, system, null);
        });

      } else {
        await debug.step(6, 'pending', {
          stream: false,
          upstream_id: selectedUpstreamId2,
          upstream_url: upstreamUrl,
          provider: selectedProviderName2,
        });
        // 非流式 OpenAI → Anthropic 格式转换
        const upstreamRes = await axiosInstance.post(upstreamUrl, openaiBody, { headers, timeout: 120000 });
        const data = upstreamRes.data;

        const promptTokens = data.usage?.prompt_tokens || estimateTokens(messages);
        const completionTokens = data.usage?.completion_tokens || 0;
        const effectivePrompt8 = calcEffectiveInputTokens(data.usage, false);

        const cost = await calculateCost(effectivePrompt8, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
        const result = await settleModelCharge(
          req.apiUserId,
          modelConfig,
          cost,
          `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`,
          billingContext2,
          { route: 'messages', request_id: requestId, model }
        );
        billingContext2.finalized = true;
        const logExtra = getLogExtra(modelConfig, getChargedAmountForLog(modelConfig, cost));

        if (!result.success) {
          await debug.step(7, 'error', { stream: false, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_cost: cost }, { errorMessage: '额度已用尽' });
          await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'insufficient_balance', '余额不足', requestId, getLogExtra(modelConfig, billingContext2.reservedAmount || 0));
          return res.status(402).json({ type: 'error', error: { type: 'billing_error', message: '额度已用尽' } });
        }

        // 构建 Anthropic Messages API 响应
        const choice = data.choices?.[0];
        const content = [];

        await debug.step(6, 'success', { stream: false, upstream_id: selectedUpstreamId2, upstream_url: upstreamUrl, status_code: upstreamRes.status });
        await debug.step(7, 'success', { stream: false, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_cost: cost });
        await debug.step(8, 'skipped', { reason: 'no_recovery_needed' });
        await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId, logExtra);
        await saveRequestDetail(requestId, req.apiUserId, model, messages, system, choice?.message?.content || '');

        if (choice?.message?.content) {
          content.push({ type: 'text', text: choice.message.content });
        }
        if (choice?.message?.tool_calls) {
          for (const tc of choice.message.tool_calls) {
            let inputObj = {};
            try { inputObj = JSON.parse(tc.function.arguments); } catch (e) { /* ignore */ }
            content.push({ type: 'tool_use', id: tc.id || `toolu_${uuidv4().slice(0, 8)}`, name: tc.function.name, input: inputObj });
          }
        }

        res.json({
          id: requestId,
          type: 'message',
          role: 'assistant',
          model,
          content,
          stop_reason: convertFinishReason(choice?.finish_reason),
          stop_sequence: null,
          usage: { input_tokens: promptTokens, output_tokens: completionTokens }
        });
      }
    }
  } catch (err) {
    if (selectedUpstreamId2) recordFail(selectedUpstreamId2);
    const errMsg = await extractUpstreamErrorMessage(err);
    const is429 = err.response?.status === 429 || errMsg.includes('429') || errMsg.toLowerCase().includes('rate limit');
    if (is429) {
      await noteCcClubRateLimit({
        providerName: selectedProviderName2,
        baseUrl,
        apiKey,
        errorMessage: errMsg,
        statusCode: err.response?.status || 429,
        source: 'messages'
      });
    }
    const isTimeout = err.code === 'ECONNABORTED' || errMsg.toLowerCase().includes('timeout');

    console.error(`Messages API upstream error [model=${model}, upstream=${baseUrl}]:`, errMsg);

    if (is429 && allProviders && allProviders.length > 1) {
      console.log(`[429] upstream ${selectedUpstreamId2} 失败(score=${getFailCount(selectedUpstreamId2).toFixed(1)})，${allProviders.length - 1} 个备选`);
      await debug.step(8, 'error', {
        reason: 'upstream_rate_limited',
        fallback_candidates: allProviders.length - 1,
        selected_upstream_id: selectedUpstreamId2,
        provider: selectedProviderName2,
      }, { errorMessage: errMsg });
      await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'rate_limit', `429: upstream ${selectedUpstreamId2}`, requestId, getLogExtra(modelConfig, 0));
    } else {
      await debug.step(8, 'error', {
        reason: is429 ? 'upstream_rate_limited_without_backup' : 'upstream_failed',
        fallback_candidates: Math.max(0, allProviders.length - 1),
        selected_upstream_id: selectedUpstreamId2,
        provider: selectedProviderName2,
      }, { errorMessage: errMsg });
    }

    await releasePendingCharge(req, modelConfig, billingContext2, requestId, model, 'messages 请求失败，释放预留余额');
    await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'error', errMsg, requestId, getLogExtra(modelConfig, 0));
    await debug.step(6, 'error', {
      stream,
      upstream_id: selectedUpstreamId2,
      upstream_url: baseUrl,
      provider: selectedProviderName2,
      status_code: err.response?.status || null,
    }, { errorMessage: errMsg });
    await debug.step(7, 'error', { stream, status_code: err.response?.status || null }, { errorMessage: errMsg });
    const statusCode = isTimeout ? 503 : (err.response?.status || 502);
    res.status(statusCode).json({
      type: 'error', error: { type: isTimeout ? 'overloaded_error' : 'upstream_error', message: errMsg }
    });
  }
});

// Anthropic messages → OpenAI messages 格式转换
function convertAnthropicToOpenAIMessages(system, messages) {
  const result = [];

  // system prompt
  if (system) {
    if (typeof system === 'string') {
      result.push({ role: 'system', content: system });
    } else if (Array.isArray(system)) {
      result.push({ role: 'system', content: system.map(b => b.text || '').join('\n') });
    }
  }

  for (const msg of messages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // 处理 content blocks
        const textParts = [];
        const toolResults = [];
        const toolUseCalls = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_result') {
            // tool_result → OpenAI tool role message
            let toolContent = '';
            if (typeof block.content === 'string') {
              toolContent = block.content;
            } else if (Array.isArray(block.content)) {
              toolContent = block.content.map(c => c.text || '').join('\n');
            }
            toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content: toolContent });
          } else if (block.type === 'tool_use') {
            // assistant tool_use → OpenAI tool_calls
            toolUseCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
            });
          }
        }

        if (msg.role === 'assistant' && toolUseCalls.length > 0) {
          result.push({
            role: 'assistant',
            content: textParts.join('\n') || null,
            tool_calls: toolUseCalls
          });
        } else if (textParts.length > 0) {
          result.push({ role: msg.role, content: textParts.join('\n') });
        }

        // tool_result messages 跟在 assistant message 后面
        for (const tr of toolResults) {
          result.push(tr);
        }
      }
    }
  }

  return result;
}

// OpenAI finish_reason → Anthropic stop_reason
function convertFinishReason(reason) {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

// 获取模型列表（公开）
router.get('/models', async (req, res) => {
  try {
    const [models] = await db.query('SELECT model_id, display_name, provider FROM openclaw_models WHERE status = "active" ORDER BY sort_order');
    res.json({
      object: 'list',
      data: models.map(m => ({ id: m.model_id, object: 'model', owned_by: m.provider }))
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to fetch models', type: 'server_error' } });
  }
});

// 写调用日志
async function logCall(userId, apiKeyId, model, promptTokens, completionTokens, cost, ip, status, errorMsg, requestId, extra = {}) {
  const normalizedExtra = typeof extra === 'string'
    ? { tokenSource: extra }
    : (extra || {});
  try {
    await db.query(
      `INSERT INTO openclaw_call_logs
        (user_id, api_key_id, model, prompt_tokens, completion_tokens, total_cost, ip, status, error_message, request_id,
         token_source, billing_mode, charged_balance_type, charged_amount)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        userId,
        apiKeyId,
        model,
        promptTokens,
        completionTokens,
        cost,
        ip,
        status,
        errorMsg,
        requestId,
        normalizedExtra.tokenSource || 'upstream',
        normalizedExtra.billingMode || 'token',
        normalizedExtra.chargedBalanceType || null,
        roundAmount(normalizedExtra.chargedAmount || 0),
      ]
    );
  } catch (e) {
    console.error('Log write error:', e);
  }
}

// 从 messages 数组中提取最后一条用户文本输入
function extractUserPrompt(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content.slice(0, 5000);
    if (Array.isArray(msg.content)) {
      const text = msg.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
      if (text) return text.slice(0, 5000);
    }
  }
  return null;
}

// 保存请求/响应内容（仅管理员可查）
// 只保留最后 3 条消息，避免 Claude Code 长上下文撑爆数据库
async function saveRequestDetail(requestId, userId, model, messages, systemPrompt, responseContent) {
  try {
    const msgs = Array.isArray(messages) ? messages : [];
    const recentMsgs = msgs.slice(-3);
    const msgStr = JSON.stringify(recentMsgs).slice(0, 50000);
    const userPrompt = extractUserPrompt(msgs);
    const sysStr = (typeof systemPrompt === 'string' ? systemPrompt : JSON.stringify(systemPrompt || '')).slice(0, 10000);
    const respStr = (responseContent || '').slice(0, 20000);
    await db.query(
      'INSERT IGNORE INTO openclaw_request_logs (request_id, user_id, model, messages, user_prompt, system_prompt, response_content) VALUES (?,?,?,?,?,?,?)',
      [requestId, userId, model, msgStr, userPrompt, sysStr || null, respStr || null]
    );
  } catch (e) {
    console.error('saveRequestDetail error:', e.message);
  }
}

// 计算有效输入 token 数（与 new-api / one-api 保持一致）
// Anthropic:
//   input_tokens                  → 1x   普通输入
//   cache_creation_input_tokens   → 1.25x 5分钟缓存写入
//   cache_creation_tokens_1hour   → 2x   1小时缓存写入（beta）
//   cache_read_input_tokens       → 0.1x 缓存读取
// OpenAI:
//   prompt_tokens（含 cached）    → cached 部分 0.5x
function calcEffectiveInputTokens(usage, isAnthropicApi) {
  if (isAnthropicApi) {
    const normal      = usage?.input_tokens || 0;
    const cacheWrite5m = usage?.cache_creation_input_tokens || 0;          // 5分钟缓存
    const cacheWrite1h = usage?.cache_creation_tokens_1hour || 0;          // 1小时缓存
    const cacheRead    = usage?.cache_read_input_tokens || 0;
    return normal + cacheWrite5m * 1.25 + cacheWrite1h * 2.0 + cacheRead * 0.1;
  } else {
    const total  = usage?.prompt_tokens || 0;
    const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
    return total - cached * 0.5;
  }
}

// 从 Anthropic content 数组中提取纯文本（跳过 thinking 块）
function extractTextFromContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
  }
  return '';
}

// Token 估算：区分 CJK 和非 CJK 字符
function estimateTokens(input) {
  if (!input) return 0;
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  const nonCjkCount = text.length - cjkCount;
  // CJK ~1.5 chars/token, non-CJK ~4 chars/token, +10% safety buffer
  const estimated = Math.ceil((cjkCount / 1.5 + nonCjkCount / 4) * 1.1);
  return Math.max(estimated, 1);
}

module.exports = router;
