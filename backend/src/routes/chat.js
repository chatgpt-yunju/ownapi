const router = require('express').Router();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');
const PROVIDERS = require('../config/models');
const { calculateCost, deductBalance } = require('../utils/billing');

// POST /v1/chat/completions — 核心转发
router.post('/chat/completions', async (req, res) => {
  const requestId = `chatcmpl-${uuidv4().replace(/-/g, '').slice(0, 24)}`;
  const { model, messages, stream = false, temperature, max_tokens, top_p } = req.body;

  if (!model || !messages) {
    return res.status(400).json({ error: { message: 'model and messages are required', type: 'invalid_request_error' } });
  }

  // 查模型配置
  let modelConfig;
  try {
    const [[row]] = await db.query('SELECT * FROM openclaw_models WHERE model_id = ? AND status = "active"', [model]);
    if (!row) {
      return res.status(400).json({ error: { message: `Model '${model}' not found or disabled`, type: 'invalid_request_error' } });
    }
    modelConfig = row;
  } catch (err) {
    console.error('Model lookup error:', err);
    return res.status(500).json({ error: { message: 'Internal server error', type: 'server_error' } });
  }

  // 预检余额（至少0.001元）
  if (Number(req.userBalance) < 0.001) {
    await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'insufficient_balance', '余额不足', requestId);
    return res.status(402).json({ error: { message: 'Insufficient balance', type: 'billing_error' } });
  }

  // 确定上游地址
  const provider = PROVIDERS[modelConfig.provider] || {};
  const baseUrl = modelConfig.upstream_endpoint || provider.baseUrl;
  const apiKey = modelConfig.upstream_key || provider.apiKey;

  if (!baseUrl || !apiKey) {
    return res.status(503).json({ error: { message: 'Model provider not configured', type: 'server_error' } });
  }

  try {
    // 构建转发请求
    // 如果有 upstream_model_id，使用它作为上游模型名称（用于火山引擎等需要 endpoint ID 的场景）
    const upstreamModel = modelConfig.upstream_model_id || model;
    const upstreamBody = { model: upstreamModel, messages, stream };
    if (temperature !== undefined) upstreamBody.temperature = temperature;
    if (max_tokens !== undefined) upstreamBody.max_tokens = max_tokens;
    if (top_p !== undefined) upstreamBody.top_p = top_p;

    if (stream) {
      // 流式响应
      const upstreamRes = await axios.post(`${baseUrl}/chat/completions`, upstreamBody, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        responseType: 'stream',
        timeout: 120000
      });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Request-Id', requestId);

      let fullContent = '';
      let promptTokens = 0;
      let completionTokens = 0;

      upstreamRes.data.on('data', (chunk) => {
        const text = chunk.toString();
        res.write(text);

        // 解析 SSE 数据收集 token
        const lines = text.split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.usage) {
              promptTokens = parsed.usage.prompt_tokens || promptTokens;
              completionTokens = parsed.usage.completion_tokens || completionTokens;
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) fullContent += delta;
          } catch (e) { /* ignore parse errors */ }
        }
      });

      upstreamRes.data.on('end', async () => {
        res.end();
        // 估算 token（如果上游未返回 usage）
        if (!promptTokens) promptTokens = estimateTokens(messages);
        if (!completionTokens) completionTokens = estimateTokens(fullContent);

        const cost = calculateCost(promptTokens, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k));
        await deductBalance(req.apiUserId, cost, `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`);
        await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId);
      });

      upstreamRes.data.on('error', async (err) => {
        console.error('Stream error:', err);
        res.end();
        await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'error', err.message, requestId);
      });

    } else {
      // 非流式响应
      const upstreamRes = await axios.post(`${baseUrl}/chat/completions`, upstreamBody, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 120000
      });

      const data = upstreamRes.data;
      const promptTokens = data.usage?.prompt_tokens || estimateTokens(messages);
      const completionTokens = data.usage?.completion_tokens || estimateTokens(data.choices?.[0]?.message?.content || '');

      const cost = calculateCost(promptTokens, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k));

      // 扣费
      const result = await deductBalance(req.apiUserId, cost, `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`);
      if (!result.success) {
        await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'insufficient_balance', '余额不足', requestId);
        return res.status(402).json({ error: { message: 'Insufficient balance for this request', type: 'billing_error' } });
      }

      await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId);

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
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    console.error('Upstream error:', errMsg);
    await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'error', errMsg, requestId);
    res.status(err.response?.status || 502).json({
      error: { message: errMsg, type: 'upstream_error' }
    });
  }
});

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
async function logCall(userId, apiKeyId, model, promptTokens, completionTokens, cost, ip, status, errorMsg, requestId) {
  try {
    await db.query(
      'INSERT INTO openclaw_call_logs (user_id, api_key_id, model, prompt_tokens, completion_tokens, total_cost, ip, status, error_message, request_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [userId, apiKeyId, model, promptTokens, completionTokens, cost, ip, status, errorMsg, requestId]
    );
  } catch (e) {
    console.error('Log write error:', e);
  }
}

// 简单 token 估算（中文约2字/token，英文约4字符/token）
function estimateTokens(input) {
  if (!input) return 0;
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  return Math.ceil(text.length / 3);
}

module.exports = router;
