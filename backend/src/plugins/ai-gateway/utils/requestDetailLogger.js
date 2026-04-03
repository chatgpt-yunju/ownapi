const db = require('../../../config/db');

const DETAIL_QUEUE_MAX = Math.max(200, parseInt(process.env.GATEWAY_DETAIL_QUEUE_MAX, 10) || 2000);
const DETAIL_BATCH_SIZE = Math.max(1, parseInt(process.env.GATEWAY_DETAIL_BATCH_SIZE, 10) || 25);
const DETAIL_FLUSH_INTERVAL_MS = Math.max(200, parseInt(process.env.GATEWAY_DETAIL_FLUSH_INTERVAL_MS, 10) || 500);

let queue = [];

// 去掉客户端注入的 "System: [timestamp] " 前缀，只保留实际用户输入
const SYSTEM_PREFIX_RE = /^(System:\s*\[[^\]]*\]\s*)+/i;

function stripSystemPrefix(text) {
  return text.replace(SYSTEM_PREFIX_RE, '').trim();
}

function extractUserPrompt(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') {
      const text = stripSystemPrefix(message.content);
      if (text) return text.slice(0, 4000);
    }
    if (Array.isArray(message.content)) {
      const text = stripSystemPrefix(
        message.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text || '')
          .join('\n')
      );
      if (text) return text.slice(0, 4000);
    }
  }
  return null;
}

async function enqueueRequestDetail({
  requestId,
  userId,
  model,
  messages,
  systemPrompt,
  responseContent,
  force = false,
}) {
  if (!requestId) return false;

  const userPrompt = extractUserPrompt(messages);
  const compactMessages = userPrompt
    ? JSON.stringify([{ role: 'user', content: userPrompt }]).slice(0, 20000)
    : null;

  const payload = {
    requestId,
    userId: userId || null,
    model: model || null,
    messages: compactMessages,
    userPrompt,
    systemPrompt: null,
    responseContent: null,
  };

  if (queue.length >= DETAIL_QUEUE_MAX) {
    queue.shift();
  }

  queue.push(payload);
  return true;
}

async function flushRequestDetails() {
  if (queue.length === 0) return;

  const batch = queue.splice(0, DETAIL_BATCH_SIZE);
  const values = [];
  const placeholders = batch.map(() => '(?,?,?,?,?,?,?)').join(',');

  for (const item of batch) {
    values.push(
      item.requestId,
      item.userId,
      item.model,
      item.messages,
      item.userPrompt,
      item.systemPrompt,
      item.responseContent
    );
  }

  try {
    await db.query(
      `INSERT IGNORE INTO openclaw_request_logs
        (request_id, user_id, model, messages, user_prompt, system_prompt, response_content)
       VALUES ${placeholders}`,
      values
    );
  } catch (error) {
    console.error('[request-detail] flush failed:', error.message);
    queue = batch.concat(queue);
  }
}

setInterval(() => {
  flushRequestDetails().catch((error) => console.error('[request-detail] timer failed:', error.message));
}, DETAIL_FLUSH_INTERVAL_MS).unref();

module.exports = {
  enqueueRequestDetail,
  flushRequestDetails,
};
