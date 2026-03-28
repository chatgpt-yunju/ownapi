/**
 * 简易 AI 网关调用工具
 * 供后端路由中的内联 AI 调用使用（替代直接调用火山引擎 Ark API）
 * 所有调用通过 api.yunjunet.cn 内部端点，消耗 USD 余额
 */
const GATEWAY_URL = process.env.AI_GATEWAY_URL || 'http://localhost:3000/api/plugins/ai-gateway';
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || '';

/**
 * 非流式调用
 * @param {string} prompt - 用户输入
 * @param {Object} [opts] - { userId, system, tier, model, temperature, max_tokens }
 * @returns {string} AI 回复文本
 */
async function callAI(prompt, opts = {}) {
  const { userId = 1, system, tier = 'simple', model, temperature, max_tokens } = opts;

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const body = { model, messages, stream: false };
  if (!model) {
    const { pickModel } = require('yunjunet-common/backend-core/ai/model-router');
    const picked = await pickModel(tier, messages);
    body.model = picked.model;
  }
  if (temperature !== undefined) body.temperature = temperature;
  if (max_tokens) body.max_tokens = max_tokens;

  const response = await fetch(`${GATEWAY_URL}/v1/internal/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': INTERNAL_SECRET,
      'X-User-Id': String(userId),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let errMsg = `AI 网关返回 ${response.status}`;
    try { const d = await response.json(); errMsg = d.error?.message || errMsg; } catch {}
    throw new Error(errMsg);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

module.exports = { callAI };
