/**
 * OpenAI Responses API 兼容端点 — 支持 Codex CLI
 * POST /responses
 *
 * 将 Responses API 格式 ↔ Chat Completions / Anthropic Messages 格式互转
 * 支持 429 自动重试其他端点
 */
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../../../config/db');
const PROVIDERS = require('../config/models');
const { getModelConfig, getAllUpstreamEndpoints } = require('./chat');
const {
  calculateCost,
  getModelBillingMeta,
  reserveModelCharge,
  settleModelCharge,
  refundModelCharge,
  roundAmount,
} = require('../utils/billing');
const { noteCcClubRateLimit } = require('../utils/ccClubKeyGuard');
const { noteHuoshanRateLimit } = require('../utils/huoshanKeyGuard');
const { createDebugRecorder } = require('../utils/requestDebug');
const { extractUpstreamErrorMessage } = require('../utils/upstreamError');
const { applyStreamIdleTimeout, axiosInstance, getUpstreamTimeouts } = require('../utils/upstreamHttp');
const { resolveAnthropicCompatibleUpstreamUrl, resolveOpenAICompatibleUpstreamUrl } = require('../utils/upstreamUrl');
const {
  acquireBestEndpoint,
  getEndpointIdentity,
  isRetryableUpstreamError,
  recordUpstreamFailure,
  recordUpstreamSuccess,
  releaseEndpointLease,
} = require('../utils/upstreamScheduler');
const { enqueueDebugStepRecord } = require('../utils/requestDebug');

const MAX_RETRIES = 2;
const PRE_RESERVE = 0.01;
const DEFAULT_NVIDIA_MINIMAX_M25_FAST_CONFIG = Object.freeze({
  maxTokens: 128,
  connectTimeoutMs: 6500,
  idleTimeoutMs: 20000,
  requestTimeoutMs: 15000,
});
const DEFAULT_NVIDIA_MINIMAX_M27_FAST_CONFIG = DEFAULT_NVIDIA_MINIMAX_M25_FAST_CONFIG;
const FORWARDED_CLIENT_HEADERS = [
  'openai-beta',
  'anthropic-beta',
  'user-agent',
  'x-openai-client-user-agent',
  'x-openai-meta-client-version',
  'x-openai-meta-language',
  'x-openai-meta-platform',
  'x-openai-meta-runtime',
  'x-openai-meta-runtime-version',
  'x-openai-meta-os',
  'x-openai-meta-arch',
  'x-stainless-lang',
  'x-stainless-package-version',
  'x-stainless-os',
  'x-stainless-arch',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-async',
  'x-stainless-retry-count',
  'x-stainless-timeout',
  'x-client-version',
  'x-codex-cli-version',
  'x-codex-client-user-agent',
];

const FORWARDED_CLIENT_HEADER_PREFIXES = [
  'x-codex-',
  'x-stainless-',
  'x-openai-',
];

function normalizeHeaderValue(value) {
  if (value === undefined || value === null || value === '') return null;
  return Array.isArray(value) ? value.join(',') : String(value);
}

function normalizeModelIdForLatency(model) {
  return String(model || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isNvidiaMinimaxM27Model(model) {
  const normalized = normalizeModelIdForLatency(model);
  return normalized.includes('minimaxm27') || normalized.includes('minimax27');
}

function resolveMinimaxUpstreamModelId(model, fallbackModel) {
  const normalized = normalizeModelIdForLatency(model);
  if (normalized.includes('minimaxm27') || normalized.includes('minimax27')) {
    return 'minimaxai/minimax-m2.7';
  }
  return fallbackModel;
}

function withForwardedClientHeaders(req, headers) {
  const merged = { ...headers };
  for (const headerName of FORWARDED_CLIENT_HEADERS) {
    const value = normalizeHeaderValue(req.headers[headerName]);
    if (value) merged[headerName] = value;
  }
  for (const [headerName, rawValue] of Object.entries(req.headers || {})) {
    if (FORWARDED_CLIENT_HEADERS.includes(headerName)) continue;
    if (!FORWARDED_CLIENT_HEADER_PREFIXES.some((prefix) => headerName.startsWith(prefix))) continue;
    const value = normalizeHeaderValue(rawValue);
    if (value) merged[headerName] = value;
  }
  return merged;
}

function getResponsesTimeoutConfig({ stream = false, isMinimaxM27Model = false } = {}) {
  if (isMinimaxM27Model) {
    return getUpstreamTimeouts({
      stream,
      connectTimeoutMs: DEFAULT_NVIDIA_MINIMAX_M25_FAST_CONFIG.connectTimeoutMs,
      idleTimeoutMs: DEFAULT_NVIDIA_MINIMAX_M25_FAST_CONFIG.idleTimeoutMs,
      requestTimeoutMs: DEFAULT_NVIDIA_MINIMAX_M25_FAST_CONFIG.requestTimeoutMs,
    });
  }
  return getUpstreamTimeouts({ stream });
}

function createResponsesTimingTracker(req, model, requestId) {
  return {
    requestId,
    model,
    routeName: 'responses',
    requestPath: req.originalUrl || req.path || '/v1/responses',
    traceType: req.aiGatewayTraceType || 'live',
    userId: req.apiUserId || null,
    apiKeyId: req.apiKeyId || null,
    routeStartedAt: Date.now(),
    queueWaitMs: Math.max(0, Number(req.aiGatewayQueueWaitMs) || 0),
    modelLoadedAt: 0,
    endpointsLoadedAt: 0,
    billingReservedAt: 0,
    endpointSelectedAt: 0,
    requestPreparedAt: 0,
    upstreamDispatchedAt: 0,
    dispatchFinishedAt: 0,
    upstreamStartedAt: 0,
    upstreamConnectedAt: 0,
    firstOutputAt: 0,
    responseCompletedAt: 0,
    settleFinishedAt: 0,
    leaseReleasedAt: 0,
    attempts: 0,
    finalAttempt: 0,
    stream: false,
    selectedUpstreamId: null,
    selectedProvider: null,
    selectedBaseUrl: null,
    selectedUpstreamModelId: null,
    finalized: false,
  };
}

function markResponsesDispatchComplete(tracker) {
  if (tracker && !tracker.dispatchFinishedAt) tracker.dispatchFinishedAt = Date.now();
}

function markResponsesModelLoaded(tracker) {
  if (tracker && !tracker.modelLoadedAt) tracker.modelLoadedAt = Date.now();
}

function markResponsesEndpointsLoaded(tracker) {
  if (tracker && !tracker.endpointsLoadedAt) tracker.endpointsLoadedAt = Date.now();
}

function markResponsesBillingReserved(tracker) {
  if (tracker && !tracker.billingReservedAt) tracker.billingReservedAt = Date.now();
}

function markResponsesEndpointSelected(tracker) {
  if (tracker && !tracker.endpointSelectedAt) tracker.endpointSelectedAt = Date.now();
}

function markResponsesRequestPrepared(tracker) {
  if (tracker && !tracker.requestPreparedAt) tracker.requestPreparedAt = Date.now();
}

function markResponsesUpstreamDispatched(tracker) {
  if (tracker && !tracker.upstreamDispatchedAt) tracker.upstreamDispatchedAt = Date.now();
}

function markResponsesUpstreamStart(tracker) {
  if (!tracker) return;
  tracker.upstreamStartedAt = Date.now();
  tracker.upstreamConnectedAt = 0;
  tracker.firstOutputAt = 0;
}

function markResponsesUpstreamConnected(tracker) {
  if (tracker && !tracker.upstreamConnectedAt) tracker.upstreamConnectedAt = Date.now();
}

function markResponsesFirstOutput(tracker) {
  if (tracker && !tracker.firstOutputAt) tracker.firstOutputAt = Date.now();
}

function markResponsesResponseCompleted(tracker) {
  if (tracker && !tracker.responseCompletedAt) tracker.responseCompletedAt = Date.now();
}

function markResponsesSettleFinished(tracker) {
  if (tracker && !tracker.settleFinishedAt) tracker.settleFinishedAt = Date.now();
}

function markResponsesLeaseReleased(tracker) {
  if (tracker && !tracker.leaseReleasedAt) tracker.leaseReleasedAt = Date.now();
}

function buildResponsesStepTimings(tracker, endedAt = Date.now()) {
  if (!tracker) return [];
  const points = [
    { key: 'entry', name: '入口接入', start: tracker.routeStartedAt, end: tracker.modelLoadedAt || tracker.endpointsLoadedAt || tracker.billingReservedAt || endedAt },
    { key: 'model_lookup', name: '模型加载', start: tracker.modelLoadedAt || tracker.routeStartedAt, end: tracker.endpointsLoadedAt || tracker.billingReservedAt || endedAt },
    { key: 'endpoints_load', name: '端点加载', start: tracker.endpointsLoadedAt || tracker.modelLoadedAt || tracker.routeStartedAt, end: tracker.billingReservedAt || endedAt },
    { key: 'billing_reserve', name: '预扣费', start: tracker.billingReservedAt || tracker.endpointsLoadedAt || tracker.routeStartedAt, end: tracker.endpointSelectedAt || endedAt },
    { key: 'endpoint_select', name: '端点调度', start: tracker.endpointSelectedAt || tracker.billingReservedAt || tracker.routeStartedAt, end: tracker.requestPreparedAt || endedAt },
    { key: 'request_prepare', name: '请求组装', start: tracker.requestPreparedAt || tracker.endpointSelectedAt || tracker.routeStartedAt, end: tracker.upstreamDispatchedAt || endedAt },
    { key: 'upstream_dispatch', name: '上游发起', start: tracker.upstreamDispatchedAt || tracker.requestPreparedAt || tracker.routeStartedAt, end: tracker.upstreamStartedAt || endedAt },
    { key: 'upstream_connect', name: '上游连接', start: tracker.upstreamStartedAt || tracker.upstreamDispatchedAt || tracker.routeStartedAt, end: tracker.upstreamConnectedAt || endedAt },
    { key: 'first_output', name: '首个输出', start: tracker.upstreamConnectedAt || tracker.upstreamStartedAt || tracker.routeStartedAt, end: tracker.firstOutputAt || endedAt },
    { key: 'response_complete', name: '响应处理', start: tracker.firstOutputAt || tracker.upstreamConnectedAt || tracker.routeStartedAt, end: tracker.responseCompletedAt || endedAt },
    { key: 'settle_release', name: '结算释放', start: tracker.responseCompletedAt || tracker.firstOutputAt || tracker.routeStartedAt, end: tracker.leaseReleasedAt || endedAt },
    { key: 'async_log', name: '异步日志', start: tracker.leaseReleasedAt || tracker.responseCompletedAt || tracker.routeStartedAt, end: endedAt },
  ];

  return points.map((item) => ({
    key: item.key,
    name: item.name,
    durationMs: Math.max(0, Number(item.end || endedAt) - Number(item.start || endedAt)),
  }));
}

function buildResponsesTimingPayload(tracker, endedAt = Date.now()) {
  if (!tracker) {
    return {
      queueWaitMs: 0,
      dispatchMs: 0,
      upstreamConnectMs: 0,
      firstOutputMs: 0,
      totalMs: 0,
      stepTimings: [],
    };
  }

  return {
    queueWaitMs: Math.max(0, Number(tracker.queueWaitMs) || 0),
    dispatchMs: tracker.dispatchFinishedAt ? Math.max(0, tracker.dispatchFinishedAt - tracker.routeStartedAt) : 0,
    upstreamConnectMs: (tracker.upstreamStartedAt && tracker.upstreamConnectedAt)
      ? Math.max(0, tracker.upstreamConnectedAt - tracker.upstreamStartedAt)
      : 0,
    firstOutputMs: tracker.firstOutputAt ? Math.max(0, tracker.firstOutputAt - tracker.routeStartedAt) : 0,
    totalMs: Math.max(0, endedAt - tracker.routeStartedAt),
    stepTimings: buildResponsesStepTimings(tracker, endedAt),
  };
}

function resolveResponsesMaxOutputTokens(maxOutputTokens, isMinimaxM27Model) {
  const cap = isMinimaxM27Model ? DEFAULT_NVIDIA_MINIMAX_M25_FAST_CONFIG.maxTokens : 4096;
  if (maxOutputTokens === undefined || maxOutputTokens === null || maxOutputTokens === '') return cap;
  const parsed = Number(maxOutputTokens);
  if (!Number.isFinite(parsed) || parsed <= 0) return cap;
  return isMinimaxM27Model ? Math.max(1, Math.min(Math.floor(parsed), cap)) : Math.floor(parsed);
}

function scheduleResponsesTimingLog(tracker, res, extra = {}) {
  if (!tracker || tracker.finalized) return;
  tracker.finalized = true;
  const endedAt = Date.now();
  const payload = buildResponsesTimingPayload(tracker, endedAt);
  setImmediate(() => {
    enqueueDebugStepRecord({
      requestId: tracker.requestId,
      traceType: tracker.traceType,
      routeName: tracker.routeName,
      requestPath: tracker.requestPath,
      model: tracker.model,
      userId: tracker.userId,
      apiKeyId: tracker.apiKeyId,
      stepNo: 9,
      stepKey: 'timing',
      stepName: '耗时统计',
      status: res.statusCode >= 400 ? 'error' : 'info',
      durationMs: payload.totalMs,
      attemptNo: Math.max(1, Number(tracker.finalAttempt || tracker.attempts || 1)),
      upstreamId: tracker.selectedUpstreamId,
      upstreamProvider: tracker.selectedProvider,
      upstreamBaseUrl: tracker.selectedBaseUrl,
      errorMessage: extra.errorMessage || null,
      detailJson: {
        ...payload,
        stream: Boolean(tracker.stream),
        attempts: tracker.attempts || 0,
        final_attempt: tracker.finalAttempt || tracker.attempts || 0,
        selected_upstream_id: tracker.selectedUpstreamId,
        selected_provider: tracker.selectedProvider,
        selected_base_url: tracker.selectedBaseUrl,
        selected_upstream_model_id: tracker.selectedUpstreamModelId,
        status_code: res.statusCode,
      },
    });
  });
}

// ── 输入转换：Responses API input → Chat Completions messages ───────────────
function responsesInputToMessages(input, instructions) {
  const messages = [];
  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  if (!Array.isArray(input)) return messages;

  // 用于收集连续的 function_call，合并到一个 assistant 消息中
  let pendingToolCalls = [];

  for (const item of input) {
    if (item.type === 'message') {
      // 先 flush pending tool calls
      if (pendingToolCalls.length > 0) {
        messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls });
        pendingToolCalls = [];
      }
      const role = item.role === 'developer' ? 'system' : item.role;
      const content = extractTextContent(item.content);
      messages.push({ role, content });
    } else if (item.type === 'function_call') {
      pendingToolCalls.push({
        id: item.call_id || `call_${uuidv4().slice(0, 8)}`,
        type: 'function',
        function: { name: item.name, arguments: item.arguments || '{}' }
      });
    } else if (item.type === 'function_call_output') {
      // flush pending tool calls before tool response
      if (pendingToolCalls.length > 0) {
        messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls });
        pendingToolCalls = [];
      }
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output || '' });
    }
  }

  // flush remaining
  if (pendingToolCalls.length > 0) {
    messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls });
  }

  return messages;
}

// ── 提取文本内容 ─────────────────────────────────────────────────────────────
function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(p => p.type === 'input_text' || p.type === 'output_text' || p.type === 'text')
    .map(p => p.text || '')
    .join('');
}

// ── 工具转换：Responses API tools → Chat Completions tools ──────────────────
const OPENAI_BUILTIN_TOOL_TYPES = new Set(['web_search', 'file_search', 'computer_use', 'code_interpreter']);

function convertTools(tools) {
  if (!tools || !Array.isArray(tools)) return undefined;
  const converted = tools
    .filter(t => !OPENAI_BUILTIN_TOOL_TYPES.has(t.type))
    .map(t => {
      if (t.type === 'function' && !t.function) {
        return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
      }
      return t;
    });
  return converted.length > 0 ? converted : undefined;
}

// ── 响应转换：Chat Completions → Responses API ──────────────────────────────
function chatCompletionToResponse(data, model, responseId) {
  const choice = data.choices?.[0];
  const msg = choice?.message || {};
  const output = [];

  // 文本输出
  if (msg.content) {
    output.push({
      type: 'message', id: `msg_${uuidv4().slice(0, 12)}`,
      status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: msg.content }]
    });
  }

  // 工具调用
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: 'function_call', id: `fc_${uuidv4().slice(0, 12)}`,
        call_id: tc.id, name: tc.function?.name,
        arguments: tc.function?.arguments || '{}', status: 'completed'
      });
    }
  }

  return {
    id: responseId, object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed', model,
    output,
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
      total_tokens: data.usage?.total_tokens || 0
    }
  };
}

// ── 响应转换：Anthropic Messages → Responses API ────────────────────────────
function anthropicToResponse(data, model, responseId) {
  const output = [];
  const contentParts = [];

  for (const block of (data.content || [])) {
    if (block.type === 'text') {
      contentParts.push({ type: 'output_text', text: block.text });
    } else if (block.type === 'tool_use') {
      output.push({
        type: 'function_call', id: `fc_${uuidv4().slice(0, 12)}`,
        call_id: block.id, name: block.name,
        arguments: JSON.stringify(block.input || {}), status: 'completed'
      });
    }
  }

  if (contentParts.length > 0) {
    output.unshift({
      type: 'message', id: `msg_${uuidv4().slice(0, 12)}`,
      status: 'completed', role: 'assistant', content: contentParts
    });
  }

  return {
    id: responseId, object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed', model, output,
    usage: {
      input_tokens: data.usage?.input_tokens || 0,
      output_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
    }
  };
}

// ── 查询全部可用端点 ─────────────────────────────────────────────────────────
async function getAllEndpoints(modelConfig) {
  const [endpoints] = await db.query(
    `SELECT pe.id, p.name AS provider_name, p.base_url AS provider_base_url, pe.base_url, pe.api_key, pe.weight
     FROM openclaw_model_providers mp
     JOIN openclaw_providers p ON mp.provider_id = p.id
     JOIN openclaw_provider_endpoints pe ON pe.provider_id = p.id
     WHERE mp.model_id = ? AND mp.status = 'active' AND p.status = 'active' AND pe.status = 'active'`,
    [modelConfig.id]
  );
  if (endpoints.length > 0) {
    const compatibleEndpoints = endpoints.filter((endpoint) => isCompatibleProviderEndpoint(endpoint.provider_base_url, endpoint.base_url));
    if (compatibleEndpoints.length > 0) return compatibleEndpoints;
    return [...endpoints];
  }

  const [legacyUpstreams] = await db.query(
    `SELECT id, provider_name, base_url, api_key, upstream_model_id, weight
     FROM openclaw_model_upstreams
     WHERE model_id = ? AND status = 'active'
     ORDER BY sort_order, id`,
    [modelConfig.id]
  );
  if (legacyUpstreams.length > 0) return [...legacyUpstreams];

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

function pickEndpoint(endpoints) {
  const total = endpoints.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of endpoints) { r -= p.weight; if (r <= 0) return p; }
  return endpoints[0];
}

function getChargedAmountForLog(modelConfig, tokenCost = 0) {
  const billing = getModelBillingMeta(modelConfig);
  return billing.billingMode === 'per_call' ? billing.perCallPrice : roundAmount(tokenCost);
}

async function logCall(userId, apiKeyId, model, pt, ct, cost, ip, status, errMsg, reqId, extra = {}) {
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
        pt,
        ct,
        cost,
        ip,
        status,
        errMsg,
        reqId,
        extra.tokenSource || 'upstream',
        extra.billingMode || 'token',
        extra.chargedBalanceType || null,
        roundAmount(extra.chargedAmount || 0),
      ]
    );
  } catch (e) { console.error('Log write error:', e); }
}

function resolveUpstream(model, modelConfig, baseUrl) {
  const isClaudeModel = model.includes('claude');
  const isAnthropicAPI = isClaudeModel && (
    modelConfig.provider === 'ccclub' || modelConfig.provider === 'anthropic' ||
    baseUrl.includes('claude-code.club') || baseUrl.includes('anthropic.com')
  );
  const trimmed = baseUrl.replace(/\/+$/, '');
  const upstreamUrl = trimmed.match(/\/chat\/completions$/)
    ? trimmed
    : trimmed.match(/\/messages$/)
      ? trimmed
      : isAnthropicAPI
        ? resolveAnthropicCompatibleUpstreamUrl(baseUrl)
        : resolveOpenAICompatibleUpstreamUrl(baseUrl, 'chat/completions');
  return { isAnthropicAPI, upstreamUrl };
}

function endpointFlavor(baseUrl) {
  const normalized = String(baseUrl || '').replace(/\/+$/, '').toLowerCase();
  if (normalized.includes('/openai')) return 'openai';
  if (normalized.includes('/api')) return 'api';
  return 'generic';
}

function isCompatibleProviderEndpoint(providerBaseUrl, endpointBaseUrl) {
  const providerFlavor = endpointFlavor(providerBaseUrl);
  const endpointFlavorValue = endpointFlavor(endpointBaseUrl);
  if (providerFlavor === 'generic' || endpointFlavorValue === 'generic') return true;
  return providerFlavor === endpointFlavorValue;
}

function shouldUseNativeResponsesUpstream(baseUrl, isAnthropicAPI) {
  if (isAnthropicAPI) return false;
  return String(baseUrl || '').includes('claude-code.club/openai');
}

function resolveNativeResponsesUpstream(baseUrl) {
  const trimmed = String(baseUrl || '').replace(/\/+$/, '');
  if (trimmed.match(/\/responses$/)) return trimmed;
  const clean = trimmed
    .replace(/\/v1\/responses\/?$/, '')
    .replace(/\/v1\/chat\/completions\/?$/, '')
    .replace(/\/v1\/?$/, '')
    .replace(/\/+$/, '');
  return `${clean}/v1/responses`;
}

function normalizeResponsesInput(input) {
  if (Array.isArray(input)) return input;
  const text = typeof input === 'string' ? input : String(input || '');
  return [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }]
  }];
}

function buildNativeResponsesBody({ upstreamModel, input, instructions, temperature, max_output_tokens, top_p, tools, tool_choice }) {
  const body = {
    model: upstreamModel,
    input: normalizeResponsesInput(input),
    // CC Club /openai Responses upstream requires stream=true.
    stream: true,
    max_output_tokens: max_output_tokens !== undefined && max_output_tokens !== null ? max_output_tokens : 4096,
  };
  if (instructions) body.instructions = instructions;
  if (temperature !== undefined) body.temperature = temperature;
  if (top_p !== undefined) body.top_p = top_p;
  if (tools) body.tools = tools;
  if (tool_choice) body.tool_choice = tool_choice;
  return body;
}

function processSseBlock(block, onEvent) {
  if (!block) return;
  let eventName = '';
  const dataLines = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (!dataLines.length) return;
  const payloadText = dataLines.join('\n');
  if (payloadText === '[DONE]') {
    onEvent(eventName, '[DONE]');
    return;
  }
  try {
    onEvent(eventName, JSON.parse(payloadText));
  } catch {
    // Ignore malformed SSE fragments and wait for the next chunk.
  }
}

function createSseParser(onEvent) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString().replace(/\r\n/g, '\n');
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    for (const block of blocks) processSseBlock(block, onEvent);
  };
}

function captureNativeResponsesEvent(_eventName, parsed, state) {
  if (!parsed || parsed === '[DONE]') return;
  if (parsed.type === 'response.output_text.delta' && parsed.delta) {
    state.fullText += parsed.delta;
  }
  const usage = parsed.response?.usage || parsed.usage;
  if (usage) {
    if (usage.input_tokens !== undefined) state.promptTokens = usage.input_tokens;
    if (usage.output_tokens !== undefined) state.completionTokens = usage.output_tokens;
  }
  if (parsed.type === 'response.completed' && parsed.response) {
    state.response = parsed.response;
    const usageFromResponse = parsed.response.usage || {};
    state.promptTokens = usageFromResponse.input_tokens || state.promptTokens;
    state.completionTokens = usageFromResponse.output_tokens || state.completionTokens;
    if (!state.fullText && Array.isArray(parsed.response.output)) {
      state.fullText = parsed.response.output
        .flatMap(item => Array.isArray(item.content) ? item.content : [])
        .filter(part => part.type === 'output_text')
        .map(part => part.text || '')
        .join('');
    }
  }
}

function is429Error(err) {
  const status = err.response?.status;
  const msg = (err.response?.data?.error?.message || err.message || '').toLowerCase();
  return status === 429 || msg.includes('429') || msg.includes('rate limit');
}

function getEndpointRetryDecision({ err, is429, remaining, selected, attempt }) {
  if (attempt >= MAX_RETRIES || !isRetryableUpstreamError(err)) {
    return { action: 'break' };
  }

  if (is429) {
    if (remaining.length > 1) {
      return { action: 'rotate', remaining: remaining.filter((item) => getEndpointIdentity(item) !== getEndpointIdentity(selected)) };
    }
    return { action: 'break' };
  }

  return { action: 'retry_same', remaining: [selected] };
}

// ── Messages → Anthropic 格式 ───────────────────────────────────────────────
function messagesToAnthropic(messages) {
  let system;
  const anthMsgs = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system = (system ? system + '\n' : '') + m.content;
    } else if (m.role === 'tool') {
      anthMsgs.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }]
      });
    } else if (m.role === 'assistant' && m.tool_calls) {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: JSON.parse(tc.function?.arguments || '{}') });
      }
      anthMsgs.push({ role: 'assistant', content: blocks });
    } else {
      anthMsgs.push({ role: m.role === 'model' ? 'assistant' : m.role, content: m.content });
    }
  }
  return { system, messages: anthMsgs };
}

// ── POST /responses ─────────────────────────────────────────────────────────
router.post('/responses', async (req, res) => {
  const requestId = req.aiGatewayRequestId || `resp_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
  const { model, input, instructions, stream = false, temperature, max_output_tokens, top_p, tools, tool_choice } = req.body;
  const isMinimaxM27Model = isNvidiaMinimaxM27Model(model);
  const responsesTimeoutConfig = getResponsesTimeoutConfig({ stream, isMinimaxM27Model });
  const effectiveMaxOutputTokens = resolveResponsesMaxOutputTokens(max_output_tokens, isMinimaxM27Model);
  const timingTracker = createResponsesTimingTracker(req, model, requestId);
  timingTracker.stream = Boolean(stream);
  const debug = createDebugRecorder({
    requestId,
    traceType: req.aiGatewayTraceType || 'live',
    routeName: req.aiGatewayRouteName || 'responses',
    requestPath: req.originalUrl,
    model,
    userId: req.apiUserId || null,
    apiKeyId: req.apiKeyId || null,
  });
  res.setHeader('X-Request-Id', requestId);
  let timingLogged = false;
  const finalizeTiming = (extra = {}) => {
    if (timingLogged) return;
    timingLogged = true;
    scheduleResponsesTimingLog(timingTracker, res, extra);
  };
  res.once('finish', () => finalizeTiming());
  res.once('close', () => finalizeTiming());

  if (!model) {
    await debug.step(1, 'error', { has_model: false }, { errorMessage: 'model is required' });
    return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error', code: 'missing_required_parameter' } });
  }
  if (input === undefined || input === null) {
    await debug.step(1, 'error', { has_input: false }, { errorMessage: 'input is required' });
    return res.status(400).json({ error: { message: 'input is required', type: 'invalid_request_error', code: 'missing_required_parameter' } });
  }

  // 查模型
  let modelConfig;
  try {
    const [[row]] = await db.query('SELECT * FROM openclaw_models WHERE model_id = ? AND status = "active"', [model]);
    if (!row) {
      await debug.step(5, 'error', { reason: 'model_not_found' }, { errorMessage: `Model '${model}' not found or disabled` });
      return res.status(404).json({ error: { message: `Model '${model}' not found or disabled`, type: 'invalid_request_error' } });
    }
    modelConfig = await getModelConfig(model);
    markResponsesModelLoaded(timingTracker);
  if (!modelConfig) {
    await debug.step(5, 'error', { reason: 'model_not_found' }, { errorMessage: `Model '${model}' not found or disabled` });
    return res.status(404).json({ error: { message: `Model '${model}' not found or disabled`, type: 'invalid_request_error' } });
  }
  } catch (err) {
    await debug.step(5, 'error', { reason: 'model_lookup_failed' }, { errorMessage: err.message });
    return res.status(500).json({ error: { message: 'Internal error', type: 'server_error' } });
  }

  // 获取端点
  const allEndpoints = await getAllUpstreamEndpoints(modelConfig);
  markResponsesEndpointsLoaded(timingTracker);
  if (allEndpoints.length === 0) {
    await debug.step(5, 'error', { reason: 'provider_not_configured' }, { errorMessage: 'Model provider not configured' });
    return res.status(503).json({ error: { message: 'Model provider not configured', type: 'server_error' } });
  }

  const billingMeta = getModelBillingMeta(modelConfig);
  const billingContext = await reserveModelCharge(req.apiUserId, modelConfig, PRE_RESERVE, {
    route: 'responses',
    request_id: requestId,
    model,
  });
  if (!billingContext.success) {
    await debug.step(3, 'error', {
      reason: 'pre_reserve_insufficient_balance',
      balance_type: billingMeta.balanceType,
      required_amount: billingMeta.billingMode === 'per_call' ? billingMeta.perCallPrice : PRE_RESERVE,
      current_balance: billingContext.balance || 0,
    }, { errorMessage: '余额不足' });
    await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'insufficient_balance', '余额不足', requestId, {
      billingMode: billingMeta.billingMode,
      chargedBalanceType: billingMeta.balanceType,
      chargedAmount: 0,
    });
    return res.status(402).json({
      error: { message: billingMeta.balanceType === 'wallet' ? '钱包余额不足' : '余额不足，当前额度已用尽。请购买加油包或升级套餐以继续使用。', type: 'billing_error' }
    });
  }
  markResponsesBillingReserved(timingTracker);
  billingContext.finalized = false;
  await debug.step(3, 'success', {
    billing_mode: billingMeta.billingMode,
    balance_type: billingMeta.balanceType,
    reserved_amount: billingContext.reservedAmount || 0,
    balance_before: billingContext.balanceBefore,
    balance_after: billingContext.balanceAfter,
  });

  const upstreamModel = resolveMinimaxUpstreamModelId(model, modelConfig.upstream_model_id || model);
  const messages = responsesInputToMessages(input, instructions);
  const chatTools = convertTools(tools);
  let remaining = [...allEndpoints];
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES && remaining.length > 0; attempt++) {
    const leaseToken = `${requestId}:${attempt + 1}`;
    const picked = await acquireBestEndpoint(remaining, leaseToken);
    const selected = picked.endpoint;
    if (!selected) {
      lastErr = Object.assign(new Error('当前所有上游端点并发已满，请稍后重试'), {
        code: 'UPSTREAM_SATURATED',
        response: { status: 503, data: { error: { message: '当前所有上游端点并发已满，请稍后重试' } } },
      });
      break;
    }
    const startedAt = Date.now();
    const { isAnthropicAPI, upstreamUrl: resolvedUpstreamUrl } = resolveUpstream(model, modelConfig, selected.base_url);
    const useNativeResponsesUpstream = shouldUseNativeResponsesUpstream(selected.base_url, isAnthropicAPI);
    const upstreamUrl = useNativeResponsesUpstream
      ? resolveNativeResponsesUpstream(selected.base_url)
      : resolvedUpstreamUrl;
    timingTracker.attempts = attempt + 1;
    timingTracker.finalAttempt = attempt + 1;
    timingTracker.selectedUpstreamId = selected.id || null;
    timingTracker.selectedProvider = selected.provider_name || null;
    timingTracker.selectedBaseUrl = selected.base_url || null;
    timingTracker.selectedUpstreamModelId = selected.upstream_model_id || null;
    markResponsesEndpointSelected(timingTracker);
    await debug.step(5, 'success', {
      attempt: attempt + 1,
      selected_upstream_id: selected.id,
      selected_provider: selected.provider_name || null,
      selected_base_url: selected.base_url,
      upstream_url: upstreamUrl,
      upstream_count: remaining.length,
      endpoint_health_score: selected.scheduler?.score ?? null,
      endpoint_inflight: selected.scheduler?.inflight ?? null,
      api_format: isAnthropicAPI ? 'anthropic' : (useNativeResponsesUpstream ? 'openai_responses_native' : 'openai_compatible'),
      stream,
    });

    let body, headers;
    if (useNativeResponsesUpstream) {
      markResponsesRequestPrepared(timingTracker);
      body = buildNativeResponsesBody({
        upstreamModel,
        input,
        instructions,
        temperature,
        max_output_tokens: effectiveMaxOutputTokens,
        top_p,
        tools,
        tool_choice,
      });
      headers = withForwardedClientHeaders(req, { 'Authorization': `Bearer ${selected.api_key}`, 'Content-Type': 'application/json' });
    } else if (isAnthropicAPI) {
      markResponsesRequestPrepared(timingTracker);
      const { system, messages: anthMsgs } = messagesToAnthropic(messages);
      body = { model: upstreamModel, messages: anthMsgs, max_tokens: effectiveMaxOutputTokens };
      if (system) body.system = system;
      if (temperature !== undefined) body.temperature = temperature;
      if (top_p !== undefined) body.top_p = top_p;
      if (chatTools) {
        body.tools = chatTools.map(t => ({ name: t.function?.name, description: t.function?.description, input_schema: t.function?.parameters }));
      }
      if (stream) body.stream = true;
      headers = withForwardedClientHeaders(req, { 'x-api-key': selected.api_key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' });
    } else {
      markResponsesRequestPrepared(timingTracker);
      body = { model: upstreamModel, messages, max_tokens: effectiveMaxOutputTokens };
      if (temperature !== undefined) body.temperature = temperature;
      if (top_p !== undefined) body.top_p = top_p;
      if (chatTools) body.tools = chatTools;
      if (tool_choice) body.tool_choice = tool_choice;
      if (stream) { body.stream = true; body.stream_options = { include_usage: true }; }
      headers = withForwardedClientHeaders(req, { 'Authorization': `Bearer ${selected.api_key}`, 'Content-Type': 'application/json' });
    }

    try {
      if (attempt > 0) {
        console.log(`[Responses Retry] attempt ${attempt + 1}, endpoint ${selected.id}`);
        await debug.step(8, 'success', {
          reason: 'retry_attempt',
          attempt: attempt + 1,
          selected_upstream_id: selected.id,
        });
        await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'upstream_retry', `重试: 端点 ${selected.id}`, requestId, {
          billingMode: billingMeta.billingMode,
          chargedBalanceType: billingMeta.balanceType,
          chargedAmount: 0,
        });
      }

      await debug.step(6, 'pending', {
        attempt: attempt + 1,
        selected_upstream_id: selected.id,
        upstream_url: upstreamUrl,
        stream: stream || useNativeResponsesUpstream,
      });
      markResponsesDispatchComplete(timingTracker);
      markResponsesUpstreamDispatched(timingTracker);

      if (useNativeResponsesUpstream) {
      if (stream) {
        return await handleNativeResponsesStream(req, res, upstreamUrl, body, headers, model, modelConfig, requestId, debug, selected, billingContext, { leaseToken, startedAt }, timingTracker, responsesTimeoutConfig);
      }
      return await handleNativeResponsesNonStream(req, res, upstreamUrl, body, headers, model, modelConfig, requestId, debug, selected, billingContext, { leaseToken, startedAt }, timingTracker, responsesTimeoutConfig);
    }
    if (stream) {
        return await handleStream(req, res, upstreamUrl, body, headers, isAnthropicAPI, model, modelConfig, requestId, debug, selected, billingContext, { leaseToken, startedAt }, timingTracker, responsesTimeoutConfig);
      }
      return await handleNonStream(req, res, upstreamUrl, body, headers, isAnthropicAPI, model, modelConfig, requestId, debug, selected, billingContext, { leaseToken, startedAt }, timingTracker, responsesTimeoutConfig);
    } catch (err) {
      lastErr = err;
      const errMsg = await extractUpstreamErrorMessage(err);
      await recordUpstreamFailure(selected, {
        latencyMs: Date.now() - startedAt,
        statusCode: err.response?.status || 0,
        errorMessage: errMsg,
      });
      await releaseEndpointLease(selected, leaseToken);
      await debug.step(6, 'error', {
        attempt: attempt + 1,
        selected_upstream_id: selected.id,
        upstream_url: upstreamUrl,
        status_code: err.response?.status || null,
      }, { errorMessage: errMsg });
      if (is429Error(err)) {
        await Promise.allSettled([
          noteCcClubRateLimit({
            providerName: selected.provider_name,
            baseUrl: selected.base_url,
            apiKey: selected.api_key,
            errorMessage: errMsg,
            statusCode: err.response?.status || 429,
            source: 'responses'
          }),
          noteHuoshanRateLimit({
            providerName: selected.provider_name,
            baseUrl: selected.base_url,
            apiKey: selected.api_key,
            errorMessage: errMsg,
            statusCode: err.response?.status || 429,
            source: 'responses'
          })
        ]);
      }
      const retryDecision = getEndpointRetryDecision({ err, is429, remaining, selected, attempt });
      if (retryDecision.action === 'rotate') {
        remaining = retryDecision.remaining;
        console.log(`[Responses 429] 端点 ${selected.id} 限流, 剩余 ${remaining.length} 个可用`);
        await debug.step(8, 'success', {
          reason: 'rate_limit_retry_available',
          failed_upstream_id: selected.id,
          remaining_candidates: remaining.length,
        });
        continue;
      }
      if (retryDecision.action === 'retry_same') {
        remaining = retryDecision.remaining;
        await debug.step(8, 'success', {
          reason: 'retry_same_endpoint',
          failed_upstream_id: selected.id,
          remaining_candidates: remaining.length,
        });
        continue;
      }
      await debug.step(8, 'error', {
        reason: is429Error(err) ? 'rate_limit_no_backup' : 'upstream_failed',
        failed_upstream_id: selected.id,
        remaining_candidates: Math.max(0, remaining.length - 1),
      }, { errorMessage: errMsg });
      break;
    }
  }

  const errMsg = await extractUpstreamErrorMessage(lastErr, 'Unknown error');
  console.error('[Responses] Upstream error:', errMsg);
  await debug.step(7, 'error', { stream }, { errorMessage: errMsg });
  if (!billingContext.finalized) {
    await refundModelCharge(req.apiUserId, modelConfig, billingContext, 'Responses 请求失败，释放预留余额', {
      route: 'responses',
      request_id: requestId,
      model,
    }).catch((error) => console.error('[Responses] refund failed:', error.message));
    billingContext.finalized = true;
  markResponsesSettleFinished(timingTracker);
  }
  await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'error', errMsg, requestId, {
    billingMode: billingMeta.billingMode,
    chargedBalanceType: billingMeta.balanceType,
    chargedAmount: 0,
  });
  const statusCode = lastErr?.code === 'UPSTREAM_SATURATED' ? 503 : (lastErr?.response?.status || 502);
  markResponsesResponseCompleted(timingTracker);
  res.status(statusCode).json({
    error: { message: errMsg, type: statusCode === 503 ? 'overloaded_error' : 'upstream_error' }
  });
});

// ── 原生 Responses 非流式（上游强制 stream=true，网关聚合后再返回） ─────────────
async function handleNativeResponsesNonStream(req, res, upstreamUrl, body, headers, model, modelConfig, requestId, debug, selected, billingContext, attemptMeta, timingTracker, upstreamTimeoutConfig) {
  markResponsesUpstreamStart(timingTracker);
  const upstream = await axiosInstance.post(upstreamUrl, { ...body, stream: true }, { headers, responseType: 'stream', timeout: upstreamTimeoutConfig.connectTimeoutMs });
  markResponsesUpstreamConnected(timingTracker);
  applyStreamIdleTimeout(upstream.data, upstreamTimeoutConfig.idleTimeoutMs, () => {
    const error = new Error('Upstream stream idle timeout');
    error.code = 'ECONNABORTED';
    return error;
  });
  const state = { response: null, promptTokens: 0, completionTokens: 0, fullText: '' };
  const parseChunk = createSseParser((eventName, parsed) => captureNativeResponsesEvent(eventName, parsed, state));

  await new Promise((resolve, reject) => {
    upstream.data.on('data', (chunk) => parseChunk(chunk));
    upstream.data.on('end', resolve);
    upstream.data.on('error', reject);
  });

  if (!state.response) {
    throw new Error('Native Responses upstream did not return response.completed');
  }

  const cost = await calculateCost(state.promptTokens, state.completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
  const billingResult = await settleModelCharge(
    req.apiUserId,
    modelConfig,
    cost,
    `Responses API: ${model} (${state.promptTokens}+${state.completionTokens} tokens)`,
    billingContext,
    { route: 'responses', request_id: requestId, model }
  );
  billingContext.finalized = true;
  markResponsesSettleFinished(timingTracker);
  await debug.step(6, 'success', {
    stream: false,
    selected_upstream_id: selected?.id || null,
    upstream_url: upstreamUrl,
    status_code: upstream.status,
  });
  if (!billingResult.success) {
    await debug.step(7, 'error', {
      stream: false,
      prompt_tokens: state.promptTokens,
      completion_tokens: state.completionTokens,
      total_cost: cost,
    }, { errorMessage: '额度已用尽' });
    await recordUpstreamSuccess(selected, {
      latencyMs: Date.now() - attemptMeta.startedAt,
      statusCode: upstream.status,
    });
    await releaseEndpointLease(selected, attemptMeta.leaseToken);
    markResponsesLeaseReleased(timingTracker);
    await logCall(req.apiUserId, req.apiKeyId, model, state.promptTokens, state.completionTokens, cost, req.ip, 'insufficient_balance', '余额不足', requestId, {
      billingMode: getModelBillingMeta(modelConfig).billingMode,
      chargedBalanceType: getModelBillingMeta(modelConfig).balanceType,
      chargedAmount: billingContext?.reservedAmount || 0,
    });
    markResponsesFirstOutput(timingTracker);
    return res.status(402).json({ error: { message: '额度已用尽', type: 'billing_error' } });
  }
  await debug.step(7, 'success', {
    stream: false,
    prompt_tokens: state.promptTokens,
    completion_tokens: state.completionTokens,
    total_cost: cost,
  });
  await debug.step(8, 'skipped', { reason: 'no_recovery_needed' });
  await recordUpstreamSuccess(selected, {
    latencyMs: Date.now() - attemptMeta.startedAt,
    statusCode: upstream.status,
  });
  await releaseEndpointLease(selected, attemptMeta.leaseToken);
  await logCall(req.apiUserId, req.apiKeyId, model, state.promptTokens, state.completionTokens, cost, req.ip, 'success', null, requestId, {
    billingMode: getModelBillingMeta(modelConfig).billingMode,
    chargedBalanceType: getModelBillingMeta(modelConfig).balanceType,
    chargedAmount: getChargedAmountForLog(modelConfig, cost),
  });
  markResponsesResponseCompleted(timingTracker);
  markResponsesFirstOutput(timingTracker);
  res.json(state.response);
}

// ── 原生 Responses 流式（上游 SSE 直接透传） ────────────────────────────────
async function handleNativeResponsesStream(req, res, upstreamUrl, body, headers, model, modelConfig, requestId, debug, selected, billingContext, attemptMeta, timingTracker, upstreamTimeoutConfig) {
  markResponsesUpstreamStart(timingTracker);
  const upstream = await axiosInstance.post(upstreamUrl, { ...body, stream: true }, { headers, responseType: 'stream', timeout: upstreamTimeoutConfig.connectTimeoutMs });
  markResponsesUpstreamConnected(timingTracker);
  applyStreamIdleTimeout(upstream.data, upstreamTimeoutConfig.idleTimeoutMs, () => {
    const error = new Error('Upstream stream idle timeout');
    error.code = 'ECONNABORTED';
    return error;
  });
  const state = { response: null, promptTokens: 0, completionTokens: 0, fullText: '' };
  const parseChunk = createSseParser((eventName, parsed) => captureNativeResponsesEvent(eventName, parsed, state));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  upstream.data.on('data', (chunk) => {
    res.write(chunk);
    parseChunk(chunk);
  });

  upstream.data.on('end', async () => {
    res.end();
    const cost = await calculateCost(state.promptTokens, state.completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
    const billingResult = await settleModelCharge(
      req.apiUserId,
      modelConfig,
      cost,
      `Responses API: ${model} (${state.promptTokens}+${state.completionTokens} tokens)`,
      billingContext,
      { route: 'responses', request_id: requestId, model }
    );
    billingContext.finalized = true;
  markResponsesSettleFinished(timingTracker);
    await debug.step(6, 'success', {
      stream: true,
      selected_upstream_id: selected?.id || null,
      upstream_url: upstreamUrl,
    });
    if (!billingResult.success) {
      await debug.step(7, 'error', {
        stream: true,
        prompt_tokens: state.promptTokens,
        completion_tokens: state.completionTokens,
        total_cost: cost,
      }, { errorMessage: '余额不足（流式响应后扣款失败）' });
      await recordUpstreamSuccess(selected, {
        latencyMs: Date.now() - attemptMeta.startedAt,
        statusCode: upstream.status,
      });
      await releaseEndpointLease(selected, attemptMeta.leaseToken);
    markResponsesLeaseReleased(timingTracker);
      await logCall(req.apiUserId, req.apiKeyId, model, state.promptTokens, state.completionTokens, cost, req.ip, 'insufficient_balance', '余额不足（流式响应后扣款失败）', requestId, {
        billingMode: getModelBillingMeta(modelConfig).billingMode,
        chargedBalanceType: getModelBillingMeta(modelConfig).balanceType,
        chargedAmount: billingContext?.reservedAmount || 0,
      });
      return;
    }
    await debug.step(7, 'success', {
      stream: true,
      prompt_tokens: state.promptTokens,
      completion_tokens: state.completionTokens,
      total_cost: cost,
    });
    await debug.step(8, 'skipped', { reason: 'no_recovery_needed' });
    await recordUpstreamSuccess(selected, {
      latencyMs: Date.now() - attemptMeta.startedAt,
      statusCode: upstream.status,
    });
    await releaseEndpointLease(selected, attemptMeta.leaseToken);
    markResponsesLeaseReleased(timingTracker);
    await logCall(req.apiUserId, req.apiKeyId, model, state.promptTokens, state.completionTokens, cost, req.ip, 'success', null, requestId, {
      billingMode: getModelBillingMeta(modelConfig).billingMode,
      chargedBalanceType: getModelBillingMeta(modelConfig).balanceType,
      chargedAmount: getChargedAmountForLog(modelConfig, cost),
    });
    markResponsesResponseCompleted(timingTracker);
  });

  upstream.data.on('error', async (err) => {
    const errMsg = await extractUpstreamErrorMessage(err);
    await recordUpstreamFailure(selected, {
      latencyMs: Date.now() - attemptMeta.startedAt,
      errorMessage: errMsg,
      statusCode: err.response?.status || 0,
    });
    await releaseEndpointLease(selected, attemptMeta.leaseToken);
    markResponsesLeaseReleased(timingTracker);
    await debug.step(6, 'error', {
      stream: true,
      selected_upstream_id: selected?.id || null,
      upstream_url: upstreamUrl,
    }, { errorMessage: errMsg });
    await debug.step(8, 'error', {
      reason: 'stream_upstream_error',
      selected_upstream_id: selected?.id || null,
    }, { errorMessage: errMsg });
    if (!billingContext.finalized) {
      await refundModelCharge(req.apiUserId, modelConfig, billingContext, 'Responses 流式上游异常，释放预留余额', {
        route: 'responses',
        request_id: requestId,
        model,
      }).catch((error) => console.error('[Responses] refund failed:', error.message));
      billingContext.finalized = true;
  markResponsesSettleFinished(timingTracker);
    }
    await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'error', errMsg, requestId, {
      billingMode: getModelBillingMeta(modelConfig).billingMode,
      chargedBalanceType: getModelBillingMeta(modelConfig).balanceType,
      chargedAmount: 0,
    });
    res.end();
  });
}

// ── 非流式 ──────────────────────────────────────────────────────────────────
async function handleNonStream(req, res, upstreamUrl, body, headers, isAnthropicAPI, model, modelConfig, requestId, debug, selected, billingContext, attemptMeta, timingTracker, upstreamTimeoutConfig) {
  markResponsesUpstreamStart(timingTracker);
  const upstream = await axiosInstance.post(upstreamUrl, body, { headers, timeout: upstreamTimeoutConfig.requestTimeoutMs });
  markResponsesUpstreamConnected(timingTracker);
  const data = upstream.data;

  let resp, promptTokens, completionTokens;
  if (isAnthropicAPI) {
    resp = anthropicToResponse(data, model, requestId);
    promptTokens = data.usage?.input_tokens || 0;
    completionTokens = data.usage?.output_tokens || 0;
  } else {
    resp = chatCompletionToResponse(data, model, requestId);
    promptTokens = data.usage?.prompt_tokens || 0;
    completionTokens = data.usage?.completion_tokens || 0;
  }

  const cost = await calculateCost(promptTokens, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
  const billingResult = await settleModelCharge(
    req.apiUserId,
    modelConfig,
    cost,
    `Responses API: ${model} (${promptTokens}+${completionTokens} tokens)`,
    billingContext,
    { route: 'responses', request_id: requestId, model }
  );
  billingContext.finalized = true;
  markResponsesSettleFinished(timingTracker);
  await debug.step(6, 'success', {
    stream: false,
    selected_upstream_id: selected?.id || null,
    upstream_url: upstreamUrl,
    status_code: upstream.status,
  });
  if (!billingResult.success) {
    await debug.step(7, 'error', {
      stream: false,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_cost: cost,
    }, { errorMessage: '额度已用尽' });
    await recordUpstreamSuccess(selected, {
      latencyMs: Date.now() - attemptMeta.startedAt,
      statusCode: upstream.status,
    });
    await releaseEndpointLease(selected, attemptMeta.leaseToken);
    markResponsesLeaseReleased(timingTracker);
    await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'insufficient_balance', '余额不足', requestId, {
      billingMode: getModelBillingMeta(modelConfig).billingMode,
      chargedBalanceType: getModelBillingMeta(modelConfig).balanceType,
      chargedAmount: billingContext?.reservedAmount || 0,
    });
    return res.status(402).json({ error: { message: '额度已用尽', type: 'billing_error' } });
  }
  await debug.step(7, 'success', {
    stream: false,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_cost: cost,
  });
  await debug.step(8, 'skipped', { reason: 'no_recovery_needed' });
  await recordUpstreamSuccess(selected, {
    latencyMs: Date.now() - attemptMeta.startedAt,
    statusCode: upstream.status,
  });
  await releaseEndpointLease(selected, attemptMeta.leaseToken);
  await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId, {
    billingMode: getModelBillingMeta(modelConfig).billingMode,
    chargedBalanceType: getModelBillingMeta(modelConfig).balanceType,
    chargedAmount: getChargedAmountForLog(modelConfig, cost),
  });
  markResponsesResponseCompleted(timingTracker);
  markResponsesFirstOutput(timingTracker);
  res.json(resp);
}

// ── 流式 ────────────────────────────────────────────────────────────────────
async function handleStream(req, res, upstreamUrl, body, headers, isAnthropicAPI, model, modelConfig, requestId, debug, selected, billingContext, attemptMeta, timingTracker, upstreamTimeoutConfig) {
  markResponsesUpstreamStart(timingTracker);
  const upstream = await axiosInstance.post(upstreamUrl, body, { headers, responseType: 'stream', timeout: upstreamTimeoutConfig.connectTimeoutMs });
  markResponsesUpstreamConnected(timingTracker);
  applyStreamIdleTimeout(upstream.data, upstreamTimeoutConfig.idleTimeoutMs, () => {
    const error = new Error('Upstream stream idle timeout');
    error.code = 'ECONNABORTED';
    return error;
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const msgId = `msg_${uuidv4().slice(0, 12)}`;
  let promptTokens = 0, completionTokens = 0;
  let fullText = '';
  let buffer = '';
  let headersSent = false;
  let currentToolCalls = {}; // id -> {name, arguments}

  function sendEvent(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function ensureHeaders() {
    if (headersSent) return;
    headersSent = true;
    markResponsesFirstOutput(timingTracker);
    // response.created
    sendEvent('response.created', {
      type: 'response.created',
      response: { id: requestId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model, output: [] }
    });
    // output_item.added (message)
    sendEvent('response.output_item.added', {
      type: 'response.output_item.added', output_index: 0,
      item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] }
    });
    // content_part.added
    sendEvent('response.content_part.added', {
      type: 'response.content_part.added', output_index: 0, content_index: 0,
      part: { type: 'output_text', text: '' }
    });
  }

  upstream.data.on('data', (chunk) => {
    markResponsesFirstOutput(timingTracker);
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 处理 Anthropic SSE 格式 (event: xxx\ndata: xxx)
      if (trimmed.startsWith('event:')) continue;
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;

      try {
        const parsed = JSON.parse(payload);
        if (isAnthropicAPI) {
          processAnthropicChunk(parsed, ensureHeaders, sendEvent, (t) => { fullText += t; }, (pt, ct) => { promptTokens = pt; completionTokens = ct; }, currentToolCalls);
        } else {
          processOpenAIChunk(parsed, ensureHeaders, sendEvent, (t) => { fullText += t; }, (pt, ct) => { promptTokens = pt; completionTokens = ct; }, currentToolCalls);
        }
      } catch {}
    }
  });

  upstream.data.on('end', async () => {
    ensureHeaders();
    // content_part.done
    sendEvent('response.output_text.done', { type: 'response.output_text.done', output_index: 0, content_index: 0, text: fullText });
    sendEvent('response.content_part.done', { type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: fullText } });
    // output_item.done
    sendEvent('response.output_item.done', {
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'message', id: msgId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: fullText }] }
    });
    // response.completed
    sendEvent('response.completed', {
      type: 'response.completed',
      response: {
        id: requestId, object: 'response', created_at: Math.floor(Date.now() / 1000),
        status: 'completed', model,
        output: [{ type: 'message', id: msgId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: fullText }] }],
        usage: { input_tokens: promptTokens, output_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
      }
    });
    res.end();

    const cost = await calculateCost(promptTokens, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
    const billingResult = await settleModelCharge(
      req.apiUserId,
      modelConfig,
      cost,
      `Responses API: ${model} (${promptTokens}+${completionTokens} tokens)`,
      billingContext,
      { route: 'responses', request_id: requestId, model }
    );
    billingContext.finalized = true;
  markResponsesSettleFinished(timingTracker);
    await debug.step(6, 'success', {
      stream: true,
      selected_upstream_id: selected?.id || null,
      upstream_url: upstreamUrl,
    });
    if (!billingResult.success) {
      await debug.step(7, 'error', {
        stream: true,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_cost: cost,
      }, { errorMessage: '余额不足（流式响应后扣款失败）' });
      await recordUpstreamSuccess(selected, {
        latencyMs: Date.now() - attemptMeta.startedAt,
        statusCode: upstream.status,
      });
      await releaseEndpointLease(selected, attemptMeta.leaseToken);
    markResponsesLeaseReleased(timingTracker);
      await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'insufficient_balance', '余额不足（流式响应后扣款失败）', requestId, {
        billingMode: getModelBillingMeta(modelConfig).billingMode,
        chargedBalanceType: getModelBillingMeta(modelConfig).balanceType,
        chargedAmount: billingContext?.reservedAmount || 0,
      });
      return;
    }
    await debug.step(7, 'success', {
      stream: true,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_cost: cost,
    });
    await debug.step(8, 'skipped', { reason: 'no_recovery_needed' });
    await recordUpstreamSuccess(selected, {
      latencyMs: Date.now() - attemptMeta.startedAt,
      statusCode: upstream.status,
    });
    await releaseEndpointLease(selected, attemptMeta.leaseToken);
    await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId, {
      billingMode: getModelBillingMeta(modelConfig).billingMode,
      chargedBalanceType: getModelBillingMeta(modelConfig).balanceType,
      chargedAmount: getChargedAmountForLog(modelConfig, cost),
    });
  });

  upstream.data.on('error', async (err) => {
    const errMsg = await extractUpstreamErrorMessage(err);
    await recordUpstreamFailure(selected, {
      latencyMs: Date.now() - attemptMeta.startedAt,
      errorMessage: errMsg,
      statusCode: err.response?.status || 0,
    });
    await releaseEndpointLease(selected, attemptMeta.leaseToken);
    await debug.step(6, 'error', {
      stream: true,
      selected_upstream_id: selected?.id || null,
      upstream_url: upstreamUrl,
    }, { errorMessage: errMsg });
    await debug.step(8, 'error', {
      reason: 'stream_upstream_error',
      selected_upstream_id: selected?.id || null,
    }, { errorMessage: errMsg });
    if (!billingContext.finalized) {
      await refundModelCharge(req.apiUserId, modelConfig, billingContext, 'Responses SSE 上游异常，释放预留余额', {
        route: 'responses',
        request_id: requestId,
        model,
      }).catch((error) => console.error('[Responses] refund failed:', error.message));
      billingContext.finalized = true;
  markResponsesSettleFinished(timingTracker);
    }
    await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'error', errMsg, requestId, {
      billingMode: getModelBillingMeta(modelConfig).billingMode,
      chargedBalanceType: getModelBillingMeta(modelConfig).balanceType,
      chargedAmount: 0,
    });
    res.end();
  });
}

// ── OpenAI chunk 处理 ───────────────────────────────────────────────────────
function processOpenAIChunk(parsed, ensureHeaders, sendEvent, addText, setTokens, toolCalls) {
  const delta = parsed.choices?.[0]?.delta;
  if (!delta) {
    if (parsed.usage) setTokens(parsed.usage.prompt_tokens || 0, parsed.usage.completion_tokens || 0);
    return;
  }

  if (delta.content) {
    ensureHeaders();
    addText(delta.content);
    sendEvent('response.output_text.delta', {
      type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: delta.content
    });
  }

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index || 0;
      if (!toolCalls[idx]) {
        toolCalls[idx] = { id: tc.id || '', name: '', arguments: '' };
      }
      if (tc.function?.name) toolCalls[idx].name += tc.function.name;
      if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
    }
  }

  if (parsed.usage) {
    setTokens(parsed.usage.prompt_tokens || 0, parsed.usage.completion_tokens || 0);
  }
}

// ── Anthropic chunk 处理 ────────────────────────────────────────────────────
function processAnthropicChunk(parsed, ensureHeaders, sendEvent, addText, setTokens, toolCalls) {
  const evType = parsed.type;

  if (evType === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
    ensureHeaders();
    addText(parsed.delta.text);
    sendEvent('response.output_text.delta', {
      type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: parsed.delta.text
    });
  }

  if (evType === 'message_start' && parsed.message?.usage) {
    setTokens(parsed.message.usage.input_tokens || 0, 0);
  }
  if (evType === 'message_delta' && parsed.usage) {
    setTokens(parsed.usage?.input_tokens || 0, parsed.usage?.output_tokens || 0);
  }
}

module.exports = router;
