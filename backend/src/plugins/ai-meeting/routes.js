const router = require('express').Router();
const { verifyToken } = require('../../utils/aitoolsShared');

const MAX_ROUNDS = 10;
const STREAM_DELAY_MS = 500;
const MAX_TOKENS = 500;
const TEMPERATURE = 0.8;

// 5个AI员工角色定义
const EMPLOYEES = [
  { name: '张策划', role: '内容策划师', context: '短视频内容策划师。擅长选题策划、热点分析、用户画像分析、内容定位', style: '专业但不失亲和力', task: '从内容策划的角度给出专业建议', extra: '给出3-5个具体可执行的建议' },
  { name: '李文案', role: '文案编辑', context: '创意文案编辑。擅长撰写吸引人的标题、文案、脚本，善于用文字打动人心', style: '生动活泼，富有创意', task: '从文案创作的角度给出建议', extra: '提供2-3个具体的文案示例', prev: '刚才张策划已经发言。' },
  { name: '王数据', role: '数据分析师', context: '数据分析师。擅长用户行为分析、数据洞察、效果评估，习惯用数据说话', style: '理性客观，注重数据和逻辑', task: '从数据分析的角度给出建议', extra: '提供2-3个关键数据指标', prev: '前面张策划和李文案已经发言。' },
  { name: '赵剪辑', role: '视频剪辑师', context: '视频剪辑师。擅长镜头语言、节奏把控、视觉效果、剪辑技巧', style: '专业，注重视觉呈现', task: '从视频制作的角度给出建议', extra: '提供2-3个具体的剪辑技巧', prev: '前面几位同事已经发言。' },
  { name: '刘总监', role: '运营总监', context: '运营总监。擅长整体把控、资源协调、战略规划，负责做最终决策', style: '稳重有力，体现领导风范', task: '作为总监做总结性发言', extra: '综合前面同事的建议，给出行动计划', prev: '前面4位同事（张策划、李文案、王数据、赵剪辑）已经发言。', maxLen: 250 },
];

function buildPrompt(emp, topic, question, round, history) {
  const historyKey = emp.name;
  let prompt = `你是${emp.name}，一位${emp.context}。\n\n会议主题：${topic}\n当前问题（第${round}轮）：${question}`;

  if (history.length > 0) {
    const prev = history.map(h =>
      `问题：${h.question}\n你的回答：${h.responses[historyKey] || '未发言'}`
    ).join('\n\n');
    prompt += `\n\n前面几轮的讨论内容：\n${prev}`;
  }

  const preamble = emp.prev ? `\n\n${emp.prev}现在请你${emp.task}。` : `\n\n请针对当前问题，${emp.task}。`;
  const roundNote = round > 1 ? '如果是后续轮次，要结合前面的讨论内容\n' : '';
  const maxLen = emp.maxLen || 200;

  prompt += `${preamble}\n\n要求：\n1. 用第一人称"我"发言，体现个人风格\n${roundNote}2. 语气${emp.style}\n3. ${emp.extra}\n4. 控制在${maxLen}字以内\n5. 不要使用Markdown格式，用纯文本自然换行`;
  return prompt;
}

async function streamEmployee(emp, apiUrl, modelName, headers, topic, question, round, history, sendEvent) {
  sendEvent({ type: 'employee_start', name: emp.name, role: emp.role });

  const prompt = buildPrompt(emp, topic, question, round, history);
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: prompt }], stream: true, max_tokens: MAX_TOKENS, temperature: TEMPERATURE }),
  });

  if (!response.ok) throw new Error(`员工 ${emp.name} 调用失败`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:') || trimmed === 'data: [DONE]') continue;
      try {
        const delta = JSON.parse(trimmed.slice(5)).choices?.[0]?.delta?.content;
        if (delta) { content += delta; sendEvent({ type: 'delta', delta }); }
      } catch { /* ignore parse errors */ }
    }
  }

  sendEvent({ type: 'employee_end', name: emp.name });
  return content;
}

// POST /api/plugins/ai-meeting/start
router.post('/start', async (req, res) => {
  const { topic, question, round = 1, history = [] } = req.body;
  if (!question?.trim()) return res.status(400).json({ message: '请输入问题' });
  if (round > MAX_ROUNDS) return res.status(400).json({ message: `已达到最大轮次（${MAX_ROUNDS}轮）` });

  const userId = verifyToken(req);
  if (!userId) {
    return res.status(401).json({ message: '请先登录后再使用 AI 功能', code: 'LOGIN_REQUIRED', needLogin: true });
  }

  // SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const GW_URL = process.env.AI_GATEWAY_URL || 'http://localhost:3021';
    const SECRET = process.env.INTERNAL_API_SECRET || '';
    const { pickModel } = require('yunjunet-common/backend-core/ai/model-router');
    const picked = await pickModel('medium');
    const apiUrl = `${GW_URL}/v1/internal/chat/completions`;
    const headers = { 'Content-Type': 'application/json', 'X-Internal-Secret': SECRET, 'X-User-Id': String(userId) };

    const currentRoundResponses = {};

    for (const emp of EMPLOYEES) {
      try {
        const content = await streamEmployee(emp, apiUrl, picked.model, headers, topic, question, round, history, sendEvent);
        currentRoundResponses[emp.name] = content;
        await new Promise(r => setTimeout(r, STREAM_DELAY_MS));
      } catch (empError) {
        console.error(`Employee ${emp.name} error:`, empError);
        sendEvent({ type: 'delta', delta: `\n[${emp.name}暂时无法发言，已跳过]` });
        sendEvent({ type: 'employee_end', name: emp.name });
      }
    }

    sendEvent({ type: 'round_complete', round, history: [...history, { round, question, responses: currentRoundResponses }] });
    res.end();
  } catch (e) {
    sendEvent({ error: e.message || 'AI 调用失败' });
    res.end();
  }
});

module.exports = router;
