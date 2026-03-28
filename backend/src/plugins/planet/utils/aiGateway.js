const GATEWAY_URL = process.env.AI_GATEWAY_URL || 'http://localhost:3000/api/plugins/ai-gateway';
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || '';

/**
 * 通过内部 AI 网关调用文本生成
 * @param {string} prompt - 用户提示
 * @param {object} options - { userId, system, max_tokens }
 * @returns {Promise<string>} AI 返回的文本内容
 */
async function callAI(prompt, { userId = 1, system, max_tokens } = {}) {
  const messages = system
    ? [{ role: 'system', content: system }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }];

  const body = { messages, temperature: 0.7 };
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
    const err = await response.text().catch(() => '');
    throw new Error(`AI网关返回 ${response.status}: ${err.slice(0, 100)}`);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI返回格式异常');
  return content.trim();
}

module.exports = { callAI, GATEWAY_URL, INTERNAL_SECRET };
