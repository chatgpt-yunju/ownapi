function isReadableStream(value) {
  return Boolean(value)
    && typeof value.on === 'function'
    && typeof value.pipe === 'function';
}

function parseJson(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractMessageFromPayload(payload) {
  if (!payload) return null;

  if (Buffer.isBuffer(payload)) {
    return extractMessageFromPayload(payload.toString('utf8'));
  }

  if (typeof payload === 'string') {
    const text = payload.trim();
    if (!text) return null;
    const parsed = parseJson(text);
    return extractMessageFromPayload(parsed) || text;
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const msg = extractMessageFromPayload(item);
      if (msg) return msg;
    }
    return null;
  }

  if (typeof payload === 'object') {
    return payload.error?.message
      || payload.message
      || (typeof payload.error === 'string' ? payload.error : null)
      || payload.detail
      || payload.details?.message
      || payload.response?.error?.message
      || null;
  }

  return null;
}

function readStreamBody(stream, limit = 64 * 1024, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    let size = 0;
    const chunks = [];

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      resolve(value);
    };

    const onData = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buf.length;
      if (size <= limit) chunks.push(buf);
      if (size >= limit) finish(Buffer.concat(chunks).toString('utf8'));
    };

    const onEnd = () => finish(Buffer.concat(chunks).toString('utf8'));
    const onError = () => finish(Buffer.concat(chunks).toString('utf8'));
    const timer = setTimeout(() => finish(Buffer.concat(chunks).toString('utf8')), timeoutMs);

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

async function extractUpstreamErrorMessage(err, fallback = 'Upstream request failed') {
  const responseData = err?.response?.data;

  if (isReadableStream(responseData)) {
    const body = await readStreamBody(responseData);
    return extractMessageFromPayload(body) || err?.message || fallback;
  }

  return extractMessageFromPayload(responseData)
    || err?.message
    || fallback;
}

module.exports = {
  extractUpstreamErrorMessage,
};
