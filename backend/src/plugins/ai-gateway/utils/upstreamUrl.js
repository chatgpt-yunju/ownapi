function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function isOpenAICompatibleBase(baseUrl) {
  return /\/(chat\/completions|embeddings|responses|messages)$/.test(baseUrl)
    || /\/(v\d+(?:beta|alpha)?|api\/v\d+|api\/paas\/v\d+|compatible-mode\/v\d+)$/.test(baseUrl);
}

function resolveVersionedUpstreamUrl(baseUrl, pathSuffix, { defaultVersion = 'v1' } = {}) {
  const trimmed = stripTrailingSlash(baseUrl);
  if (!trimmed) return trimmed;
  if (trimmed.endsWith(`/${pathSuffix}`)) return trimmed;
  if (isOpenAICompatibleBase(trimmed)) return `${trimmed}/${pathSuffix}`;

  const cleanBase = trimmed
    .replace(/\/(chat\/completions|embeddings|responses|messages)$/, '')
    .replace(/\/v\d+(?:beta|alpha)?$/, '')
    .replace(/\/api\/v\d+$/, '')
    .replace(/\/api\/paas\/v\d+$/, '')
    .replace(/\/compatible-mode\/v\d+$/, '');

  if (cleanBase !== trimmed) {
    return `${cleanBase}/${defaultVersion}/${pathSuffix}`;
  }

  return `${trimmed}/${defaultVersion}/${pathSuffix}`;
}

function resolveOpenAICompatibleUpstreamUrl(baseUrl, pathSuffix) {
  return resolveVersionedUpstreamUrl(baseUrl, pathSuffix, { defaultVersion: 'v1' });
}

function resolveAnthropicCompatibleUpstreamUrl(baseUrl) {
  return resolveVersionedUpstreamUrl(baseUrl, 'messages', { defaultVersion: 'v1' });
}

module.exports = {
  resolveAnthropicCompatibleUpstreamUrl,
  resolveOpenAICompatibleUpstreamUrl,
  resolveVersionedUpstreamUrl,
  stripTrailingSlash,
};
