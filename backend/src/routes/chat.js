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
     await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, "model_forbidden", "模型不在套餐允许范围内", requestId);
     return res.status(403).json({ error: { message: `当前套餐不支持使用此模型，请升级套餐`, type: "permission_error" } });
   }
 }

 // 预扣款机制：先预扣一笔最小费用，防止并发和流式响应后余额不足
 // 预扣金额 $0.01（约 500-2000 tokens 的费用）
 const PRE_RESERVE = 0.01;

 // 使用事务进行预扣款（原子操作，防止并发）
 const conn = await db.getConnection();
 await conn.beginTransaction();
 try {
 const [[quotaRow]] = await conn.query('SELECT balance FROM openclaw_quota WHERE user_id = ? FOR UPDATE', [req.apiUserId]);
 const currentBalance = Number(quotaRow?.balance || 0);

 if (currentBalance < PRE_RESERVE) {
 await conn.rollback();
 await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'insufficient_balance', '余额不足', requestId);
 return res.status(402).json({ error: { message: '余额不足，当前额度已用尽。请购买加油包或升级套餐以继续使用。', type: 'billing_error' } });
 }

 // 预扣费用
 await conn.query('UPDATE openclaw_quota SET balance = balance - ? WHERE user_id = ?', [PRE_RESERVE, req.apiUserId]);
 await conn.commit();

 // 记录预扣金额，供后续结算使用
 req.preReserved = PRE_RESERVE;
 req.userBalance = currentBalance - PRE_RESERVE;
 } catch (err) {
 await conn.rollback();
 throw err;
 } finally {
 conn.release();
 }

  // 检查月度调用次数限制
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
      // 检查月度调用次数
      if (userPkg.daily_limit) {
        const monthlyCallLimit = userPkg.daily_limit * 30;
        const [[callCount]] = await db.query(
          'SELECT COUNT(*) as cnt FROM openclaw_call_logs WHERE user_id = ? AND created_at >= ? AND status = "success"',
          [req.apiUserId, monthStart]
        );
        console.log(`[Limit Check] User ${req.apiUserId}: calls ${callCount.cnt}/${monthlyCallLimit}`); if (callCount.cnt >= monthlyCallLimit) {
          await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'call_limit_exceeded', `月度调用次数已达上限 ${monthlyCallLimit}`, requestId);
          return res.status(429).json({ error: { message: `月度调用次数已达上限（${callCount.cnt}/${monthlyCallLimit} 次）。请购买加油包或升级套餐以提升限额。`, type: 'rate_limit_error' } });
        }
      }
      // 检查月度配额（费用）是否超出
      if (userPkg.monthly_quota) {
        const [[monthCost]] = await db.query(
          'SELECT COALESCE(SUM(total_cost), 0) as cost FROM openclaw_call_logs WHERE user_id = ? AND created_at >= ? AND status = "success"',
          [req.apiUserId, monthStart]
        );
        const quota = Number(userPkg.monthly_quota);
        const used = Number(monthCost.cost);
        console.log(`[Limit Check] User ${req.apiUserId}: quota $${used.toFixed(4)}/$${quota.toFixed(2)}`); if (used >= quota) {
          await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'quota_exceeded', `月度配额已用尽 $${used.toFixed(4)}/$${quota.toFixed(2)}`, requestId);
          return res.status(429).json({ error: { message: `月度配额已用尽（$${used.toFixed(4)}/$${quota.toFixed(2)}）。请购买加油包或升级套餐以增加配额。`, type: 'rate_limit_error' } });
        }
      }
    }
  } catch (err) {
    console.error('Limit check error:', err);
    // 限额检查失败不阻断请求，继续处理
  }

  // 确定上游地址（支持轮询多个供应商）
  let baseUrl, apiKey;

  // 查询模型绑定的供应商列表
  const [providers] = await db.query(
    `SELECT p.id, p.base_url, p.api_key, p.weight
     FROM openclaw_model_providers mp
     JOIN openclaw_providers p ON mp.provider_id = p.id
     WHERE mp.model_id = ? AND mp.status = 'active' AND p.status = 'active'`,
    [modelConfig.id]
  );

  if (providers.length > 0) {
    // 轮询选择：基于权重随机选择
    const totalWeight = providers.reduce((sum, p) => sum + p.weight, 0);
    let random = Math.random() * totalWeight;
    let selectedProvider = providers[0];
    for (const p of providers) {
      random -= p.weight;
      if (random <= 0) {
        selectedProvider = p;
        break;
      }
    }
    baseUrl = selectedProvider.base_url;
    apiKey = selectedProvider.api_key;
  } else {
    // 回退到旧配置
    const provider = PROVIDERS[modelConfig.provider] || {};
    baseUrl = modelConfig.upstream_endpoint || provider.baseUrl;
    apiKey = modelConfig.upstream_key || provider.apiKey;
  }

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
      if (stream) {
        upstreamBody.stream_options = { include_usage: true };
      }
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
      let tokenCountIsEstimated = false;
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
        if (!promptTokens) {
          promptTokens = estimateTokens(messages);
          tokenCountIsEstimated = true;
        }
        if (!completionTokens) {
          completionTokens = estimateTokens(fullContent);
          tokenCountIsEstimated = true;
        }

        const tokenSource = tokenCountIsEstimated ? 'estimated' : 'upstream';
        console.log(`[Stream End] Model: ${model}, Prompt: ${promptTokens}, Completion: ${completionTokens}, Source: ${tokenSource}`);

        const cost = await calculateCost(promptTokens, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
        const result = await deductBalance(req.apiUserId, cost, `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`, req.preReserved || 0);
        if (result.success) {
          await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId, tokenSource);
        } else {
          await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'insufficient_balance', '余额不足（流式响应后扣款失败）', requestId, tokenSource);
          console.error(`[Billing] Stream billing failed for user ${req.apiUserId}, cost: ${cost}, balance: ${result.balance}`);
        }
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
        const cost = await calculateCost(promptTokens, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
        const result = await deductBalance(req.apiUserId, cost, `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`, req.preReserved || 0);

        if (!result.success) {
          await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'insufficient_balance', '余额不足', requestId);
          return res.status(402).json({ error: { message: '额度已用尽', type: 'billing_error' } });
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

        const cost = await calculateCost(promptTokens, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);

        // 扣费
        const result = await deductBalance(req.apiUserId, cost, `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`, req.preReserved || 0);
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

// ==========================================
// POST /v1/messages — Anthropic Messages API 兼容端点
// 支持 Claude Code CLI 等 Anthropic 原生客户端
// ==========================================
router.post('/messages', async (req, res) => {
  const requestId = `msg_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
  const { model, messages, system, max_tokens, stream = false, temperature, top_p, top_k, tools, tool_choice, stop_sequences } = req.body;

  if (!model || !messages) {
    return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'model and messages are required' } });
  }

  // 查模型配置
  let modelConfig;
  try {
    const [[row]] = await db.query('SELECT * FROM openclaw_models WHERE model_id = ? AND status = "active"', [model]);
    if (!row) {
      return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: `Model '${model}' not found or disabled` } });
    }
    modelConfig = row;
  } catch (err) {
    console.error('Model lookup error:', err);
    return res.status(500).json({ type: 'error', error: { type: 'server_error', message: 'Internal server error' } });
  }

// 预扣款机制：先预扣一笔最小费用，防止并发和流式响应后余额不足
 // 预扣金额 $0.01（约 500-2000 tokens 的费用）
 const PRE_RESERVE = 0.01;

 // 使用事务进行预扣款（原子操作，防止并发）
 const conn = await db.getConnection();
 await conn.beginTransaction();
 try {
 const [[quotaRow]] = await conn.query('SELECT balance FROM openclaw_quota WHERE user_id = ? FOR UPDATE', [req.apiUserId]);
 const currentBalance = Number(quotaRow?.balance || 0);

 if (currentBalance < PRE_RESERVE) {
 await conn.rollback();
 await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'insufficient_balance', '余额不足', requestId);
 return res.status(402).json({ type: 'error', error: { type: 'billing_error', message: '余额不足，当前额度已用尽。请购买加油包或升级套餐以继续使用。' } });
 }

 // 预扣费用
 await conn.query('UPDATE openclaw_quota SET balance = balance - ? WHERE user_id = ?', [PRE_RESERVE, req.apiUserId]);
 await conn.commit();

 // 记录预扣金额，供后续结算使用
 req.preReserved = PRE_RESERVE;
 req.userBalance = currentBalance - PRE_RESERVE;
 } catch (err) {
 await conn.rollback();
 throw err;
 } finally {
 conn.release();
 }

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
 if (userPkg.monthly_quota) {
 const [[monthCost]] = await db.query(
 'SELECT COALESCE(SUM(total_cost), 0) as cost FROM openclaw_call_logs WHERE user_id = ? AND created_at >= ? AND status = "success"',
 [req.apiUserId, monthStart]
 );
 const quota = Number(userPkg.monthly_quota);
 const used = Number(monthCost.cost);
 console.log(`[Messages Limit] User ${req.apiUserId}: quota $${used.toFixed(4)}/$${quota.toFixed(2)}`);
 if (used >= quota) {
 await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'quota_exceeded', `月度配额已用尽 $${used.toFixed(4)}/$${quota.toFixed(2)}`, requestId);
 return res.status(429).json({ type: 'error', error: { type: 'rate_limit_error', message: `月度配额已用尽（$${used.toFixed(4)}/$${quota.toFixed(2)}）。请购买加油包或升级套餐以增加配额。` } });
 }
 }
 }
 } catch (err) {
 console.error('[Messages Limit Check Error]:', err);
 }

  // 确定上游地址
  const provider = PROVIDERS[modelConfig.provider] || {};
  let baseUrl = modelConfig.upstream_endpoint || provider.baseUrl;
  const apiKey = modelConfig.upstream_key || provider.apiKey;

  if (!baseUrl || !apiKey) {
    return res.status(503).json({ type: 'error', error: { type: 'server_error', message: 'Model provider not configured' } });
  }

  const upstreamModel = modelConfig.upstream_model_id || model;
  const isUpstreamAnthropic = modelConfig.provider === 'ccclub' || modelConfig.provider === 'anthropic' || baseUrl.includes('claude-code.club') || baseUrl.includes('anthropic.com');

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
      if (stream) upstreamBody.stream = true;

      const headers = {
        'x-api-key': apiKey,
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        'Content-Type': 'application/json'
      };

      if (stream) {
        const upstreamRes = await axios.post(upstreamUrl, upstreamBody, { headers, responseType: 'stream', timeout: 120000 });

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Request-Id', requestId);

        let promptTokens = 0, completionTokens = 0;
        let sseBuffer = '';

        upstreamRes.data.on('data', (chunk) => {
          const text = chunk.toString();
          // 直接转发 SSE 给客户端
          res.write(text);

          // 解析 token usage
          sseBuffer += text;
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.type === 'message_start') {
                promptTokens = parsed.message?.usage?.input_tokens || 0;
              } else if (parsed.type === 'message_delta') {
                completionTokens = parsed.usage?.output_tokens || 0;
              }
            } catch (e) { /* ignore */ }
          }
        });

        upstreamRes.data.on('end', async () => {
          res.end();
          if (!promptTokens) promptTokens = estimateTokens(messages);
          if (!completionTokens) completionTokens = estimateTokens('');
          const cost = await calculateCost(promptTokens, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
          await deductBalance(req.apiUserId, cost, `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`, req.preReserved || 0);
          await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId);
        });

        upstreamRes.data.on('error', async (err) => {
          console.error('Anthropic stream error:', err);
          res.end();
          await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'error', err.message, requestId);
        });

      } else {
        // 非流式 Anthropic 透传
        const upstreamRes = await axios.post(upstreamUrl, upstreamBody, { headers, timeout: 120000 });
        const data = upstreamRes.data;

        const promptTokens = data.usage?.input_tokens || estimateTokens(messages);
        const completionTokens = data.usage?.output_tokens || 0;

        const cost = await calculateCost(promptTokens, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
        const result = await deductBalance(req.apiUserId, cost, `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`, req.preReserved || 0);

        if (!result.success) {
          await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'insufficient_balance', '余额不足', requestId);
          return res.status(402).json({ type: 'error', error: { type: 'billing_error', message: '额度已用尽' } });
        }

        await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId);

        // 返回 Anthropic 格式，替换 id 和 model
        data.id = requestId;
        data.model = model;
        res.json(data);
      }

    } else {
      // ===== OpenAI 兼容上游：格式转换 =====
      const upstreamUrl = baseUrl.includes('/chat/completions') ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

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
        const upstreamRes = await axios.post(upstreamUrl, openaiBody, { headers, responseType: 'stream', timeout: 120000 });

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Request-Id', requestId);

        let promptTokens = 0, completionTokens = 0;
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
                promptTokens = parsed.usage.prompt_tokens || promptTokens;
                completionTokens = parsed.usage.completion_tokens || completionTokens;
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
          if (!promptTokens) promptTokens = estimateTokens(messages);
          if (!completionTokens) completionTokens = estimateTokens(fullContent);
          const cost = await calculateCost(promptTokens, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
          await deductBalance(req.apiUserId, cost, `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`, req.preReserved || 0);
          await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId);
        });

        upstreamRes.data.on('error', async (err) => {
          console.error('OpenAI→Anthropic stream error:', err);
          res.end();
          await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'error', err.message, requestId);
        });

      } else {
        // 非流式 OpenAI → Anthropic 格式转换
        const upstreamRes = await axios.post(upstreamUrl, openaiBody, { headers, timeout: 120000 });
        const data = upstreamRes.data;

        const promptTokens = data.usage?.prompt_tokens || estimateTokens(messages);
        const completionTokens = data.usage?.completion_tokens || 0;

        const cost = await calculateCost(promptTokens, completionTokens, Number(modelConfig.input_price_per_1k), Number(modelConfig.output_price_per_1k), modelConfig.price_currency);
        const result = await deductBalance(req.apiUserId, cost, `API调用: ${model} (${promptTokens}+${completionTokens} tokens)`, req.preReserved || 0);

        if (!result.success) {
          await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'insufficient_balance', '余额不足', requestId);
          return res.status(402).json({ type: 'error', error: { type: 'billing_error', message: '额度已用尽' } });
        }

        await logCall(req.apiUserId, req.apiKeyId, model, promptTokens, completionTokens, cost, req.ip, 'success', null, requestId);

        // 构建 Anthropic Messages API 响应
        const choice = data.choices?.[0];
        const content = [];

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
    const errMsg = err.response?.data?.error?.message || err.message;
    console.error('Messages API upstream error:', errMsg);
    await logCall(req.apiUserId, req.apiKeyId, model, 0, 0, 0, req.ip, 'error', errMsg, requestId);
    res.status(err.response?.status || 502).json({
      type: 'error', error: { type: 'upstream_error', message: errMsg }
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
async function logCall(userId, apiKeyId, model, promptTokens, completionTokens, cost, ip, status, errorMsg, requestId, tokenSource = 'upstream') {
  try {
    await db.query(
      'INSERT INTO openclaw_call_logs (user_id, api_key_id, model, prompt_tokens, completion_tokens, total_cost, ip, status, error_message, request_id, token_source) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [userId, apiKeyId, model, promptTokens, completionTokens, cost, ip, status, errorMsg, requestId, tokenSource]
    );
  } catch (e) {
    console.error('Log write error:', e);
  }
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
