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
  let baseUrl = modelConfig.upstream_endpoint || provider.baseUrl;
  const apiKey = modelConfig.upstream_key || provider.apiKey;

  if (!baseUrl || !apiKey) {
    return res.status(503).json({ error: { message: 'Model provider not configured', type: 'server_error' } });
  }

  // 判断是否使用 Anthropic API 格式（CC Club）
  const isAnthropicAPI = modelConfig.provider === 'ccclub' || baseUrl.includes('claude-code.club');

  // 根据 API 类型确定 URL
  let upstreamUrl;
  if (isAnthropicAPI) {
    upstreamUrl = baseUrl.includes('/messages') ? baseUrl : `${baseUrl}/v1/messages`;
  } else {
    upstreamUrl = baseUrl.includes('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  }

  try {
    // 构建转发请求
    // 如果有 upstream_model_id，使用它作为上游模型名称（用于火山引擎等需要 endpoint ID 的场景）
    const upstreamModel = modelConfig.upstream_model_id || model;

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
    } else {
      // OpenAI 兼容格式
      upstreamBody = { model: upstreamModel, messages, stream };
      if (temperature !== undefined) upstreamBody.temperature = temperature;
      if (max_tokens !== undefined) upstreamBody.max_tokens = max_tokens;
      if (top_p !== undefined) upstreamBody.top_p = top_p;

      headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      };
    }

    if (stream) {
      // 流式响应
      const upstreamRes = await axios.post(upstreamUrl, upstreamBody, {
        headers,
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
      let anthropicBuffer = ''; // 缓存 Anthropic SSE 数据

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
                  promptTokens = parsed.message?.usage?.input_tokens || 0;
                  console.log(`[Anthropic Stream] message_start: input_tokens=${promptTokens}`);
                } else if (parsed.type === 'content_block_delta') {
                  const delta = parsed.delta?.text || '';
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
        } else {
          // OpenAI 格式直接转发
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
        }
      });

      upstreamRes.data.on('end', async () => {
        res.end();
        // 估算 token（如果上游未返回 usage）
        if (!promptTokens) promptTokens = estimateTokens(messages);
        if (!completionTokens) completionTokens = estimateTokens(fullContent);

        console.log(`[Stream End] Model: ${model}, Prompt: ${promptTokens}, Completion: ${completionTokens}, Content: "${fullContent}"`);

        const cost = calculateCost(promptTokens, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
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
      const upstreamRes = await axios.post(upstreamUrl, upstreamBody, {
        headers,
        timeout: 120000
      });

      const data = upstreamRes.data;
      let promptTokens, completionTokens, responseContent;

      if (isAnthropicAPI) {
        // Anthropic API 响应格式
        console.log(`[Upstream Usage] Model: ${model}, Raw usage:`, JSON.stringify(data.usage));
        promptTokens = data.usage?.input_tokens || estimateTokens(messages);
        completionTokens = data.usage?.output_tokens || 0;
        responseContent = data.content?.[0]?.text || '';
        console.log(`[Token Stats] Model: ${model}, Prompt: ${promptTokens}, Completion: ${completionTokens}, Currency: ${modelConfig.price_currency || 'CNY'}`);

        // 转换为 OpenAI 格式返回
        const cost = calculateCost(promptTokens, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
        const result = await deductBalance(req.apiUserId, cost, `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`);

        if (!result.success) {
          await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'insufficient_balance', '余额不足', requestId);
          return res.status(402).json({ error: { message: 'Insufficient balance for this request', type: 'billing_error' } });
        }

        await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId);

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
        // OpenAI 兼容格式
        console.log(`[Upstream Usage] Model: ${model}, Raw usage:`, JSON.stringify(data.usage));
        promptTokens = data.usage?.prompt_tokens || estimateTokens(messages);
        completionTokens = data.usage?.completion_tokens || estimateTokens(data.choices?.[0]?.message?.content || '');
        console.log(`[Token Stats] Model: ${model}, Prompt: ${promptTokens}, Completion: ${completionTokens}`);

        const cost = calculateCost(promptTokens, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);

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
