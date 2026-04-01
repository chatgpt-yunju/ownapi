const axios = require('axios');
const http = require('http');
const https = require('https');

const maxSockets = Math.max(100, parseInt(process.env.UPSTREAM_MAX_SOCKETS, 10) || 400);
const maxFreeSockets = Math.max(20, parseInt(process.env.UPSTREAM_MAX_FREE_SOCKETS, 10) || 100);
const upstreamRequestTimeoutMs = Math.max(1000, parseInt(process.env.UPSTREAM_REQUEST_TIMEOUT_MS, 10) || 30000);
const upstreamStreamConnectTimeoutMs = Math.max(1000, parseInt(process.env.UPSTREAM_STREAM_CONNECT_TIMEOUT_MS, 10) || 15000);
const upstreamStreamIdleTimeoutMs = Math.max(1000, parseInt(process.env.UPSTREAM_STREAM_IDLE_TIMEOUT_MS, 10) || 45000);

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets,
  maxFreeSockets,
  keepAliveMsecs: 30000,
  scheduling: 'lifo',
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets,
  maxFreeSockets,
  keepAliveMsecs: 30000,
  scheduling: 'lifo',
});

const axiosInstance = axios.create({
  httpAgent,
  httpsAgent,
  timeout: upstreamRequestTimeoutMs,
});

function getUpstreamTimeouts({ stream = false, connectTimeoutMs, idleTimeoutMs, requestTimeoutMs } = {}) {
  return {
    requestTimeoutMs: Math.max(1000, Number(requestTimeoutMs) || upstreamRequestTimeoutMs),
    connectTimeoutMs: Math.max(1000, Number(connectTimeoutMs) || (stream ? upstreamStreamConnectTimeoutMs : upstreamRequestTimeoutMs)),
    idleTimeoutMs: Math.max(1000, Number(idleTimeoutMs) || upstreamStreamIdleTimeoutMs),
  };
}

function applyStreamIdleTimeout(stream, timeoutMs, errorFactory) {
  if (!stream || typeof stream.setTimeout !== 'function') return;
  const effectiveTimeoutMs = Math.max(1000, Number(timeoutMs) || upstreamStreamIdleTimeoutMs);
  stream.setTimeout(effectiveTimeoutMs, () => {
    const error = typeof errorFactory === 'function'
      ? (errorFactory() || new Error('Upstream stream idle timeout'))
      : new Error('Upstream stream idle timeout');
    error.code = error.code || 'UPSTREAM_STREAM_IDLE_TIMEOUT';
    stream.destroy(error);
  });
}

module.exports = {
  applyStreamIdleTimeout,
  axiosInstance,
  getUpstreamTimeouts,
  httpAgent,
  httpsAgent,
  upstreamRequestTimeoutMs,
  upstreamStreamConnectTimeoutMs,
  upstreamStreamIdleTimeoutMs,
};
