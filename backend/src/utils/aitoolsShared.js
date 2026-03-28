/**
 * aitools 共享工具函数
 * 供 aitools.js 和各 AI 插件共用
 */

// ─── 游客体验计数（内存，重启后清空） ───
const guestChatExperiences = new Map();
const guestExperiences = new Map();
const guestImageExperiences = new Map();
const guestToolExperiences = new Map();

// ─── 工具函数 ───

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.connection.remoteAddress ||
         req.socket.remoteAddress;
}

function verifyToken(req) {
  // If already authenticated by API key middleware, use that
  if (req.user?.id) return req.user.id;

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-in-production');
    return decoded.id;
  } catch {
    return null;
  }
}

function guestToolLimit(req, res, next) {
  const userId = verifyToken(req);
  if (userId) return next();
  return res.status(401).json({
    message: '请先登录或输入 API Key 后再使用 AI 功能',
    code: 'LOGIN_REQUIRED',
    needLogin: true,
    needApiKey: true,
  });
}

// ─── AI 调用封装 ───

async function callText(prompt, cost, userId, reason) {
  if (!userId) {
    const err = new Error('请先登录后再使用 AI 功能');
    err.code = 'LOGIN_REQUIRED';
    throw err;
  }
  const tier = cost >= 3 ? 'complex' : cost >= 2 ? 'medium' : 'simple';
  const { callGateway } = require('yunjunet-common/backend-core/ai/doubao');
  const data = await callGateway({ userId, messages: [{ role: 'user', content: prompt }], tier });
  return data.choices?.[0]?.message?.content || '';
}

async function callImage(prompt, cost, userId, reason) {
  if (!userId) {
    const err = new Error('请先登录后再使用 AI 功能');
    err.code = 'LOGIN_REQUIRED';
    throw err;
  }
  const { callImage: gatewayCallImage } = require('yunjunet-common/backend-core/ai/doubao');
  return gatewayCallImage(prompt, cost, userId, reason);
}

module.exports = {
  guestChatExperiences,
  guestExperiences,
  guestImageExperiences,
  guestToolExperiences,
  getClientIP,
  verifyToken,
  guestToolLimit,
  callText,
  callImage,
};
