const MINIMAX_M27_CONTEXT_LIMIT = 196608;
const DEFAULT_CONTEXT_GUARD_TOKENS = 2048;
const MIN_TEXT_TOKENS_TO_KEEP = 512;

function estimateTokens(input) {
  if (!input) return 0;
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  const nonCjkCount = text.length - cjkCount;
  const estimated = Math.ceil((cjkCount / 1.5 + nonCjkCount / 4) * 1.1);
  return Math.max(estimated, 1);
}

function cloneMessage(message) {
  if (!message || typeof message !== 'object') return message;
  return Array.isArray(message)
    ? message.map((item) => cloneMessage(item))
    : { ...message };
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text'))
    .map((block) => block.text || '')
    .join('\n');
}

function estimateMessageTokens(message) {
  if (!message) return 0;
  if (typeof message === 'string') return estimateTokens(message);
  if (typeof message.content === 'string') return estimateTokens(message.content);
  if (Array.isArray(message.content)) {
    const text = extractMessageText(message.content);
    if (text) return estimateTokens(text);
    return estimateTokens(message.content);
  }
  if (message.content !== undefined && message.content !== null) {
    return estimateTokens(message.content);
  }
  return estimateTokens(message);
}

function normalizeSystemPrompt(system) {
  if (!system) return '';
  if (typeof system === 'string') return system.trim();
  if (Array.isArray(system)) {
    return system
      .map((block) => block?.text || '')
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return String(system).trim();
}

function buildCompactNote({ droppedCount, droppedTokens, requestedMaxTokens, contextLimit }) {
  return [
    '【自动压缩】',
    `已压缩前文 ${droppedCount} 条消息，`,
    `约释放 ${droppedTokens} tokens，`,
    `以适配当前上下文窗口（${contextLimit} tokens）和输出请求（${requestedMaxTokens} tokens）。`,
  ].join('');
}

function trimTextToBudget(text, tokenBudget) {
  if (!text) return '';
  const budget = Math.max(MIN_TEXT_TOKENS_TO_KEEP, Math.floor(Number(tokenBudget) || 0));
  const maxChars = Math.max(64, Math.floor(budget * 4));
  if (text.length <= maxChars) return text;
  const tail = text.slice(-Math.max(32, maxChars - 16));
  return `...[已自动截断]\n${tail}`;
}

function trimMessageToBudget(message, tokenBudget) {
  const cloned = cloneMessage(message);
  if (!cloned || typeof cloned !== 'object') return cloned;
  if (typeof cloned.content === 'string') {
    cloned.content = trimTextToBudget(cloned.content, tokenBudget);
    return cloned;
  }
  if (Array.isArray(cloned.content)) {
    const text = extractMessageText(cloned.content);
    if (text) {
      cloned.content = trimTextToBudget(text, tokenBudget);
      return cloned;
    }
  }
  return cloned;
}

function prepareMessagesForContextLimit({
  system,
  messages,
  requestedMaxTokens = 0,
  contextLimit = MINIMAX_M27_CONTEXT_LIMIT,
  guardTokens = DEFAULT_CONTEXT_GUARD_TOKENS,
} = {}) {
  const sourceMessages = Array.isArray(messages) ? messages : [];
  const normalizedSystem = normalizeSystemPrompt(system);
  const requestedOutputTokens = Math.max(1, Number(requestedMaxTokens) || 1);
  const safeBudget = Math.max(1024, Number(contextLimit) - requestedOutputTokens - Number(guardTokens || 0));

  let usedTokens = estimateTokens(normalizedSystem);
  const kept = [];
  let droppedCount = 0;
  let droppedTokens = 0;

  for (let i = sourceMessages.length - 1; i >= 0; i--) {
    const current = sourceMessages[i];
    const currentTokens = estimateMessageTokens(current);

    if (kept.length === 0 || usedTokens + currentTokens <= safeBudget) {
      kept.unshift(cloneMessage(current));
      usedTokens += currentTokens;
      continue;
    }

    droppedCount += 1;
    droppedTokens += currentTokens;
  }

  let compactedSystem = normalizedSystem;
  let compacted = droppedCount > 0;
  if (compacted) {
    const note = buildCompactNote({
      droppedCount,
      droppedTokens,
      requestedMaxTokens: requestedOutputTokens,
      contextLimit,
    });
    compactedSystem = compactedSystem ? `${compactedSystem}\n\n${note}` : note;
    usedTokens = estimateTokens(compactedSystem) + kept.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
  }

  if (kept.length > 0 && usedTokens > safeBudget) {
    const overflow = usedTokens - safeBudget;
    kept[0] = trimMessageToBudget(kept[0], Math.max(MIN_TEXT_TOKENS_TO_KEEP, estimateMessageTokens(kept[0]) - overflow));
    usedTokens = estimateTokens(compactedSystem) + kept.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
    compacted = true;
  }

  const maxOutputTokens = Math.max(1, Math.min(requestedOutputTokens, contextLimit - usedTokens - guardTokens));

  return {
    system: compactedSystem || normalizedSystem || undefined,
    messages: kept.length > 0 ? kept : sourceMessages.map((msg) => cloneMessage(msg)),
    compacted,
    droppedCount,
    droppedTokens,
    inputTokens: usedTokens,
    maxOutputTokens,
    contextLimit,
  };
}

module.exports = {
  DEFAULT_CONTEXT_GUARD_TOKENS,
  MINIMAX_M27_CONTEXT_LIMIT,
  prepareMessagesForContextLimit,
};
