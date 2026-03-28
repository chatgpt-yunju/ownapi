/**
 * Gemini API 兼容端点 — 支持 Gemini CLI
 * POST /models/<model>:generateContent
 * POST /models/<model>:streamGenerateContent
 *
 * 将 Gemini 格式 ↔ OpenAI/Anthropic 格式互转，复用 provider_endpoints 路由
 * 支持 429 自动重试其他端点
 */
const router = require('express').Router();
const axios = require('axios');
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
const { createDebugRecorder } = require('../utils/requestDebug');

const MAX_RETRIES = 2;
const PRE_RESERVE = 0.01;

// ── 格式转换：Gemini → OpenAI messages ──────────────────────────────────────
function geminiToOpenAIMessages(contents, systemInstruction) {
  const messages = [];
  if (systemInstruction) {
    const text = (systemInstruction.parts || []).map(p => p.text || '').join('\n');
    if (text) messages.push({ role: 'system', content: text });
  }
  for (const c of (contents || [])) {
    const role = c.role === 'model' ? 'assistant' : 'user';
    const text = (c.parts || []).map(p => p.text || '').join('');
    if (text) messages.push({ role, content: text });
  }
  return messages;
}

// ── 格式转换：OpenAI response → Gemini response ─────────────────────────────
function openAIToGeminiResponse(data, model) {
  const choice = data.choices?.[0];
  const text = choice?.message?.content || '';
  const finishMap = { stop: 'STOP', length: 'MAX_TOKENS', content_filter: 'SAFETY' };
  return {
    candidates: [{
      content: { parts: [{ text }], role: 'model' },
      finishReason: finishMap[choice?.finish_reason] || 'STOP',
      index: 0
    }],
    usageMetadata: {
      promptTokenCount: data.usage?.prompt_tokens || 0,
      candidatesTokenCount: data.usage?.completion_tokens || 0,
      totalTokenCount: data.usage?.total_tokens || 0
    },
    modelVersion: model
  };
}

// ── 格式转换：Anthropic response → Gemini response ──────────────────────────
function anthropicToGeminiResponse(data, model) {
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const finishMap = { end_turn: 'STOP', max_tokens: 'MAX_TOKENS', stop_sequence: 'STOP' };
  return {
    candidates: [{
      content: { parts: [{ text }], role: 'model' },
      finishReason: finishMap[data.stop_reason] || 'STOP',
      index: 0
    }],
    usageMetadata: {
      promptTokenCount: data.usage?.input_tokens || 0,
      candidatesTokenCount: data.usage?.output_tokens || 0,
      totalTokenCount: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
    },
    modelVersion: model
  };
}

// ── 查询全部可用端点 ─────────────────────────────────────────────────────────
async function getAllEndpoints(modelConfig) {
  const [endpoints] = await db.query(
    `SELECT pe.id, p.name AS provider_name, pe.base_url, pe.api_key, pe.weight
     FROM openclaw_model_providers mp
     JOIN openclaw_providers p ON mp.provider_id = p.id
     JOIN openclaw_provider_endpoints pe ON pe.provider_id = p.id
     WHERE mp.model_id = ? AND mp.status = 'active' AND p.status = 'active' AND pe.status = 'active'`,
    [modelConfig.id]
  );
  if (endpoints.length > 0) return [...endpoints];

  const [legacy] = await db.query(
    `SELECT p.id, p.name AS provider_name, p.base_url, p.api_key, COALESCE(p.weight,1) as weight
     FROM openclaw_model_providers mp JOIN openclaw_providers p ON mp.provider_id = p.id
     WHERE mp.model_id = ? AND mp.status = 'active' AND p.status = 'active' AND p.base_url IS NOT NULL AND p.api_key IS NOT NULL`,
    [modelConfig.id]
  );
  if (legacy.length > 0) return [...legacy];

  const provider = PROVIDERS.getProviderConfig
    ? PROVIDERS.getProviderConfig(modelConfig.provider)
    : (PROVIDERS[modelConfig.provider] || {});
  const baseUrl = modelConfig.upstream_endpoint || provider.baseUrl;
  const apiKey = modelConfig.upstream_key || provider.apiKey;
  if (baseUrl && apiKey) return [{ id: 0, provider_name: modelConfig.provider || '', base_url: baseUrl, api_key: apiKey, weight: 1 }];
  return [];
}

// ── 加权随机选择端点 ─────────────────────────────────────────────────────────
function pickEndpoint(endpoints) {
  const total = endpoints.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of endpoints) { r -= p.weight; if (r <= 0) return p; }
  return endpoints[0];
}

// ── 日志 ─────────────────────────────────────────────────────────────────────
async function logCall(userId, apiKeyId, model, pt, ct, cost, ip, status, errMsg, reqId) {
  try {
    await db.query(
      'INSERT INTO openclaw_call_logs (user_id, api_key_id, model, prompt_tokens, completion_tokens, total_cost, ip, status, error_message, request_id, token_source) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [userId, apiKeyId, model, pt, ct, cost, ip, status, errMsg, reqId, 'upstream']
    );
  } catch (e) { console.error('Log write error:', e); }
}

function getChargedAmountForLog(modelConfig, tokenCost = 0) {
  const billing = getModelBillingMeta(modelConfig);
  return billing.billingMode === 'per_call' ? billing.perCallPrice : roundAmount(tokenCost);
}

async function reserveGeminiCharge(req, modelConfig, requestId, debug, model) {
  const billing = getModelBillingMeta(modelConfig);
  const billingContext = await reserveModelCharge(req.apiUserId, modelConfig, PRE_RESERVE, {
    route: req.aiGatewayRouteName || 'gemini.generateContent',
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
    return {
      ok: false,
      response: {
        status: 402,
        body: {
          error: {
            code: 402,
            message: billing.balanceType === 'wallet'
              ? '钱包余额不足，请先充值后再调用按次计费模型。'
              : '余额不足，当前额度已用尽。请购买加油包或升级套餐以继续使用。',
            status: 'FAILED_PRECONDITION'
          }
        }
      }
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

  return { ok: true, billingContext };
}

async function releasePendingGeminiCharge(req, modelConfig, billingContext, requestId, model, reason) {
  if (!billingContext || billingContext.finalized) return;
  await refundModelCharge(req.apiUserId, modelConfig, billingContext, reason, {
    route: req.aiGatewayRouteName || 'gemini.generateContent',
    request_id: requestId,
    model,
  }).catch((error) => console.error('[Gemini Billing] refund failed:', error.message));
  billingContext.finalized = true;
}

function normalizeProviderName(providerName) {
  return String(providerName || '').trim().toLowerCase();
}

function isGoogleNativeBaseUrl(baseUrl) {
  const value = String(baseUrl || '');
  return value.includes('generativelanguage.googleapis.com') || /:(generateContent|streamGenerateContent)(\?|$)/.test(value);
}

function updateUrlQueryParam(url, key, value) {
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

function detectApiFormat(model, providerName, baseUrl) {
  const normalizedProvider = normalizeProviderName(providerName);
  const normalizedBaseUrl = String(baseUrl || '');
  if (normalizedProvider === 'google' || isGoogleNativeBaseUrl(normalizedBaseUrl)) return 'google_native';
  const isClaudeModel = model.includes('claude');
  if (
    isClaudeModel && (
      normalizedProvider.includes('ccclub') || normalizedProvider === 'anthropic' ||
      normalizedBaseUrl.includes('claude-code.club') || normalizedBaseUrl.includes('anthropic.com')
    )
  ) {
    return 'anthropic';
  }
  return 'openai_compatible';
}

function resolveGoogleUpstream(baseUrl, upstreamModel, isStream) {
  const trimmed = String(baseUrl || '').replace(/\/+$/, '');
  if (/:(generateContent|streamGenerateContent)(\?|$)/.test(trimmed)) {
    let directUrl = trimmed;
    if (isStream) {
      directUrl = directUrl.replace(/:generateContent(?=(\?|$))/, ':streamGenerateContent');
      return updateUrlQueryParam(directUrl, 'alt', 'sse');
    }
    directUrl = directUrl.replace(/:streamGenerateContent(?=(\?|$))/, ':generateContent');
    return updateUrlQueryParam(directUrl, 'alt', null);
  }

  let cleanBaseUrl = trimmed
    .replace(/\/models\/[^/?]+:(?:generateContent|streamGenerateContent)(?:\?.*)?$/, '')
    .replace(/\/+$/, '');

  if (!/\/v1(?:beta)?$/.test(cleanBaseUrl)) cleanBaseUrl = `${cleanBaseUrl}/v1beta`;

  const endpoint = `${cleanBaseUrl}/models/${encodeURIComponent(upstreamModel)}:${isStream ? 'streamGenerateContent' : 'generateContent'}`;
  return isStream ? updateUrlQueryParam(endpoint, 'alt', 'sse') : endpoint;
}

function normalizeGeminiGenerationConfig(generationConfig = {}) {
  const normalized = { ...generationConfig };
  if (normalized.maxOutputTokens === undefined && normalized.max_output_tokens !== undefined) {
    normalized.maxOutputTokens = normalized.max_output_tokens;
  }
  if (normalized.topP === undefined && normalized.top_p !== undefined) {
    normalized.topP = normalized.top_p;
  }
  return normalized;
}

function extractGeminiText(parsed) {
  return (parsed?.candidates?.[0]?.content?.parts || []).map(part => part?.text || '').join('');
}

function extractGeminiUsage(parsed) {
  const usage = parsed?.usageMetadata || {};
  return {
    promptTokens: usage.promptTokenCount || 0,
    completionTokens: usage.candidatesTokenCount || 0,
  };
}

// ── 判断上游格式 ─────────────────────────────────────────────────────────────
function resolveUpstream(model, modelConfig, baseUrl, providerName, isStream, upstreamModel) {
  const apiFormat = detectApiFormat(model, providerName || modelConfig.provider, baseUrl);
  if (apiFormat === 'google_native') {
    return { apiFormat, upstreamUrl: resolveGoogleUpstream(baseUrl, upstreamModel, isStream) };
  }

  const trimmed = String(baseUrl || '').replace(/\/+$/, '');
  let upstreamUrl;
  if (trimmed.match(/\/chat\/completions$/)) upstreamUrl = trimmed;
  else if (apiFormat === 'anthropic' && trimmed.match(/\/messages$/)) upstreamUrl = trimmed;
  else {
    const clean = trimmed.replace(/\/v1\/messages\/?$/, '').replace(/\/v1\/chat\/completions\/?$/, '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    upstreamUrl = apiFormat === 'anthropic' ? `${clean}/v1/messages` : `${clean}/v1/chat/completions`;
  }
  return { apiFormat, upstreamUrl };
}

// ── 构建上游请求体和头 ──────────────────────────────────────────────────────
function buildUpstreamRequest(apiFormat, upstreamModel, contents, systemInstruction, messages, generationConfig, isStream, apiKey) {
  const normalizedGenerationConfig = normalizeGeminiGenerationConfig(generationConfig);
  const temperature = normalizedGenerationConfig.temperature;
  const maxTokens = normalizedGenerationConfig.maxOutputTokens || 4096;
  const topP = normalizedGenerationConfig.topP;

  if (apiFormat === 'google_native') {
    const body = { contents: Array.isArray(contents) ? contents : [] };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (Object.keys(normalizedGenerationConfig).length > 0) body.generationConfig = normalizedGenerationConfig;
    const headers = { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' };
    return { body, headers };
  }

  if (apiFormat === 'anthropic') {
    const systemText = systemInstruction ? (systemInstruction.parts || []).map(p => p.text).join('\n') : undefined;
    const anthMsgs = (contents || []).map(c => ({
      role: c.role === 'model' ? 'assistant' : 'user',
      content: (c.parts || []).map(p => ({ type: 'text', text: p.text || '' }))
    }));
    const body = { model: upstreamModel, messages: anthMsgs, max_tokens: maxTokens };
    if (systemText) body.system = systemText;
    if (temperature !== undefined) body.temperature = temperature;
    if (topP !== undefined) body.top_p = topP;
    if (isStream) body.stream = true;
    const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
    return { body, headers };
  }

  const body = { model: upstreamModel, messages, max_tokens: maxTokens };
  if (temperature !== undefined) body.temperature = temperature;
  if (topP !== undefined) body.top_p = topP;
  if (isStream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  return { body, headers };
}

// ── 判断是否 429 ─────────────────────────────────────────────────────────────
function is429Error(err) {
  const status = err.response?.status;
  const msg = (err.response?.data?.error?.message || err.message || '').toLowerCase();
  return status === 429 || msg.includes('429') || msg.includes('rate limit');
}

// ── 通配路由：支持含 / 的模型 ID ────────────────────────────────────────────
// 匹配 /models/claude-sonnet-4-6:generateContent
// 匹配 /models/nvidia/llama-3.3-nemotron-super-49b-v1.5:generateContent
router.post(/^\/models\/(.+)$/, async (req, res) => {
  const fullPath = req.params[0]; // e.g. "claude-sonnet-4-6:generateContent"
  const colonIdx = fullPath.lastIndexOf(':');
  if (colonIdx <= 0) {
    return res.status(400).json({ error: { code: 400, message: 'Invalid format. Expected: model:generateContent', status: 'INVALID_ARGUMENT' } });
  }
  const model = fullPath.slice(0, colonIdx);
  const action = fullPath.slice(colonIdx + 1);
  const isStream = action === 'streamGenerateContent';

  if (action !== 'generateContent' && action !== 'streamGenerateContent') {
    return res.status(400).json({ error: { code: 400, message: `Unsupported action: ${action}`, status: 'INVALID_ARGUMENT' } });
  }

  const requestId = req.aiGatewayRequestId || `gem_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
  const { contents, systemInstruction, generationConfig = {} } = req.body;
  const debug = createDebugRecorder({
    requestId,
    traceType: req.aiGatewayTraceType || 'live',
    routeName: req.aiGatewayRouteName || 'gemini.generateContent',
    requestPath: req.originalUrl,
    model,
    userId: req.apiUserId || null,
    apiKeyId: req.apiKeyId || null,
  });
  res.setHeader('X-Request-Id', requestId);

  if (!contents || !Array.isArray(contents)) {
    await debug.step(1, 'error', { has_contents: false }, { errorMessage: 'contents array is required' });
    return res.status(400).json({ error: { code: 400, message: 'contents array is required', status: 'INVALID_ARGUMENT' } });
  }

  // 查模型
  let modelConfig;
  try {
    const [[row]] = await db.query('SELECT * FROM openclaw_models WHERE model_id = ? AND status = "active"', [model]);
    if (!row) {
      await debug.step(5, 'error', { reason: 'model_not_found' }, { errorMessage: `Model not found: ${model}` });
      return res.status(404).json({ error: { code: 404, message: `Model not found: ${model}`, status: 'NOT_FOUND' } });
    }
    modelConfig = row;
  } catch (err) {
    await debug.step(5, 'error', { reason: 'model_lookup_failed' }, { errorMessage: err.message });
    return res.status(500).json({ error: { code: 500, message: 'Internal error', status: 'INTERNAL' } });
  }

  // 获取全部端点
  const allEndpoints = await getAllEndpoints(modelConfig);
  if (allEndpoints.length === 0) {
    await debug.step(5, 'error', { reason: 'provider_not_configured' }, { errorMessage: 'Model provider not configured' });
    return res.status(503).json({ error: { code: 503, message: 'Model provider not configured', status: 'UNAVAILABLE' } });
  }

  const reservation = await reserveGeminiCharge(req, modelConfig, requestId, debug, model);
  if (!reservation.ok) {
    return res.status(reservation.response.status).json(reservation.response.body);
  }
  const billingContext = reservation.billingContext;

  const upstreamModel = modelConfig.upstream_model_id || model;
  const messages = geminiToOpenAIMessages(contents, systemInstruction);
  let remaining = [...allEndpoints];
  let lastErr = null;

  // 重试循环：429 时切换端点
  for (let attempt = 0; attempt <= MAX_RETRIES && remaining.length > 0; attempt++) {
    const selected = pickEndpoint(remaining);
    const { apiFormat, upstreamUrl } = resolveUpstream(
      model,
      modelConfig,
      selected.base_url,
      selected.provider_name || modelConfig.provider,
      isStream,
      upstreamModel
    );
    const { body, headers } = buildUpstreamRequest(
      apiFormat, upstreamModel, contents, systemInstruction, messages, generationConfig, isStream, selected.api_key
    );
    await debug.step(5, 'success', {
      attempt: attempt + 1,
      selected_upstream_id: selected.id,
      selected_provider: selected.provider_name || modelConfig.provider || null,
      selected_base_url: selected.base_url,
      upstream_url: upstreamUrl,
      upstream_count: remaining.length,
      api_format: apiFormat,
      stream: isStream,
    });

    try {
      if (attempt > 0) {
        console.log(`[Gemini 429 Retry] attempt ${attempt + 1}, endpoint ${selected.id}`);
        await debug.step(8, 'success', {
          reason: 'retry_switch_endpoint',
          attempt: attempt + 1,
          selected_upstream_id: selected.id,
        });
        await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'rate_limit_error', `429重试: 端点 ${selected.id}`, requestId);
      }

      await debug.step(6, 'pending', {
        attempt: attempt + 1,
        selected_upstream_id: selected.id,
        upstream_url: upstreamUrl,
        stream: isStream,
      });

      if (isStream) {
        return await handleStream(req, res, upstreamUrl, body, headers, apiFormat, model, modelConfig, requestId, debug, selected, billingContext);
      }
      return await handleNonStream(req, res, upstreamUrl, body, headers, apiFormat, model, modelConfig, requestId, debug, selected, billingContext);
    } catch (err) {
      await debug.step(6, 'error', {
        attempt: attempt + 1,
        selected_upstream_id: selected.id,
        upstream_url: upstreamUrl,
        status_code: err.response?.status || null,
      }, { errorMessage: err.response?.data?.error?.message || err.message });
      lastErr = err;
      if (is429Error(err) && remaining.length > 1) {
        remaining = remaining.filter(p => p.api_key !== selected.api_key);
        console.log(`[Gemini 429] 端点 ${selected.id} 限流, 剩余 ${remaining.length} 个可用`);
        await debug.step(8, 'success', {
          reason: 'rate_limit_retry_available',
          failed_upstream_id: selected.id,
          remaining_candidates: remaining.length,
        });
        continue;
      }
      await debug.step(8, 'error', {
        reason: is429Error(err) ? 'rate_limit_no_backup' : 'upstream_failed',
        failed_upstream_id: selected.id,
        remaining_candidates: Math.max(0, remaining.length - 1),
      }, { errorMessage: err.response?.data?.error?.message || err.message });
      break;
    }
  }

  // 全部重试失败
  const errMsg = lastErr?.response?.data?.error?.message || lastErr?.message || 'Unknown error';
  console.error('[Gemini] Upstream error:', errMsg);
  await releasePendingGeminiCharge(req, modelConfig, billingContext, requestId, model, 'Gemini 请求失败，释放预留余额');
  await debug.step(7, 'error', { stream: isStream }, { errorMessage: errMsg });
  await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'error', errMsg, requestId);
  res.status(lastErr?.response?.status || 502).json({
    error: { code: lastErr?.response?.status || 502, message: errMsg, status: 'INTERNAL' }
  });
});

// ── 非流式处理 ──────────────────────────────────────────────────────────────
async function handleNonStream(req, res, upstreamUrl, body, headers, apiFormat, model, modelConfig, requestId, debug, selected, billingContext) {
  const upstream = await axios.post(upstreamUrl, body, { headers, timeout: 120000 });
  const data = upstream.data;

  let geminiResp, promptTokens, completionTokens;
  if (data?.candidates) {
    geminiResp = data;
    ({ promptTokens, completionTokens } = extractGeminiUsage(data));
  } else if (apiFormat === 'anthropic') {
    geminiResp = anthropicToGeminiResponse(data, model);
    promptTokens = data.usage?.input_tokens || 0;
    completionTokens = data.usage?.output_tokens || 0;
  } else if (apiFormat === 'google_native') {
    geminiResp = data;
    ({ promptTokens, completionTokens } = extractGeminiUsage(data));
  } else {
    geminiResp = openAIToGeminiResponse(data, model);
    promptTokens = data.usage?.prompt_tokens || 0;
    completionTokens = data.usage?.completion_tokens || 0;
  }

  const cost = await calculateCost(promptTokens, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
  const settleResult = await settleModelCharge(
    req.apiUserId,
    modelConfig,
    cost,
    `Gemini API: ${model} (${promptTokens}+${completionTokens} tokens)`,
    billingContext,
    { route: 'gemini.generateContent', request_id: requestId, model }
  );
  billingContext.finalized = true;
  if (!settleResult.success) {
    await debug.step(7, 'error', {
      stream: false,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_cost: cost,
    }, { errorMessage: 'Insufficient balance for this request' });
    await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, billingContext.reservedAmount || 0, req.ip, 'insufficient_balance', '余额不足', requestId);
    return res.status(402).json({
      error: {
        code: 402,
        message: 'Insufficient balance for this request',
        status: 'FAILED_PRECONDITION'
      }
    });
  }
  const chargedAmount = getChargedAmountForLog(modelConfig, cost);
  await debug.step(6, 'success', {
    stream: false,
    selected_upstream_id: selected?.id || null,
    upstream_url: upstreamUrl,
    status_code: upstream.status,
  });
  await debug.step(7, 'success', {
    stream: false,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_cost: chargedAmount,
  });
  await debug.step(8, 'skipped', { reason: 'no_recovery_needed' });
  await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, chargedAmount, req.ip, 'success', null, requestId);
  res.json(geminiResp);
}

// ── 流式处理 ─────────────────────────────────────────────────────────────────
async function handleStream(req, res, upstreamUrl, body, headers, apiFormat, model, modelConfig, requestId, debug, selected, billingContext) {
  const upstream = await axios.post(upstreamUrl, body, { headers, responseType: 'stream', timeout: 120000 });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let promptTokens = 0, completionTokens = 0;
  let fullContent = '';
  let buffer = '';
  let sawGeminiNativeStream = false;

  upstream.data.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;

      try {
        const parsed = JSON.parse(payload);
        if (parsed?.candidates) {
          sawGeminiNativeStream = true;
          const chunkText = extractGeminiText(parsed);
          if (chunkText) fullContent += chunkText;
          const usage = extractGeminiUsage(parsed);
          if (usage.promptTokens || usage.completionTokens) {
            promptTokens = usage.promptTokens || promptTokens;
            completionTokens = usage.completionTokens || completionTokens;
          }
          res.write(`data: ${JSON.stringify(parsed)}\n\n`);
        } else if (apiFormat === 'anthropic') {
          handleAnthropicChunk(parsed, res, model, fullContent, (fc) => { fullContent = fc; }, (pt, ct) => { promptTokens = pt; completionTokens = ct; });
        } else if (apiFormat === 'google_native') {
          const chunkText = extractGeminiText(parsed);
          if (chunkText) {
            fullContent += chunkText;
          }
          const usage = extractGeminiUsage(parsed);
          if (usage.promptTokens || usage.completionTokens) {
            promptTokens = usage.promptTokens || promptTokens;
            completionTokens = usage.completionTokens || completionTokens;
          }
          res.write(`data: ${JSON.stringify(parsed)}\n\n`);
        } else {
          handleOpenAIChunk(parsed, res, model, fullContent, (fc) => { fullContent = fc; }, (pt, ct) => { promptTokens = pt; completionTokens = ct; });
        }
      } catch {}
    }
  });

  upstream.data.on('end', async () => {
    if (!sawGeminiNativeStream && apiFormat !== 'google_native') {
      const finalChunk = {
        candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: completionTokens, totalTokenCount: promptTokens + completionTokens },
        modelVersion: model
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    }
    res.end();

    const cost = await calculateCost(promptTokens, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
    const settleResult = await settleModelCharge(
      req.apiUserId,
      modelConfig,
      cost,
      `Gemini API: ${model} (${promptTokens}+${completionTokens} tokens)`,
      billingContext,
      { route: 'gemini.generateContent', request_id: requestId, model }
    );
    billingContext.finalized = true;
    const chargedAmount = getChargedAmountForLog(modelConfig, cost);
    if (!settleResult.success) {
      await debug.step(7, 'error', {
        stream: true,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_cost: cost,
      }, { errorMessage: 'Insufficient balance for this request' });
      await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, billingContext.reservedAmount || 0, req.ip, 'insufficient_balance', '余额不足（流式响应后扣款失败）', requestId);
      return;
    }
    await debug.step(6, 'success', {
      stream: true,
      selected_upstream_id: selected?.id || null,
      upstream_url: upstreamUrl,
    });
    await debug.step(7, 'success', {
      stream: true,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_cost: chargedAmount,
    });
    await debug.step(8, 'skipped', { reason: 'no_recovery_needed' });
    await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, chargedAmount, req.ip, 'success', null, requestId);
  });

  upstream.data.on('error', async (err) => {
    await releasePendingGeminiCharge(req, modelConfig, billingContext, requestId, model, 'Gemini 流式上游错误，释放预留余额');
    await debug.step(6, 'error', {
      stream: true,
      selected_upstream_id: selected?.id || null,
      upstream_url: upstreamUrl,
    }, { errorMessage: err.message });
    await debug.step(8, 'error', {
      reason: 'stream_upstream_error',
      selected_upstream_id: selected?.id || null,
    }, { errorMessage: err.message });
    await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'error', err.message, requestId);
    res.end();
  });
}

// ── OpenAI chunk → Gemini 格式 ──────────────────────────────────────────────
function handleOpenAIChunk(parsed, res, model, fullContent, setContent, setTokens) {
  const delta = parsed.choices?.[0]?.delta;
  if (delta?.content) {
    fullContent += delta.content;
    setContent(fullContent);
    res.write(`data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: delta.content }], role: 'model' }, index: 0 }],
      modelVersion: model
    })}\n\n`);
  }
  if (parsed.usage) {
    setTokens(parsed.usage.prompt_tokens || 0, parsed.usage.completion_tokens || 0);
  }
}

// ── Anthropic chunk → Gemini 格式 ───────────────────────────────────────────
function handleAnthropicChunk(parsed, res, model, fullContent, setContent, setTokens) {
  const evType = parsed.type;
  if (evType === 'content_block_delta' && parsed.delta?.text) {
    fullContent += parsed.delta.text;
    setContent(fullContent);
    res.write(`data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: parsed.delta.text }], role: 'model' }, index: 0 }],
      modelVersion: model
    })}\n\n`);
  }
  if (evType === 'message_start' && parsed.message?.usage) {
    setTokens(parsed.message.usage.input_tokens || 0, 0);
  }
  if (evType === 'message_delta' && parsed.usage) {
    setTokens(parsed.usage?.input_tokens || 0, parsed.usage?.output_tokens || 0);
  }
}

module.exports = router;
