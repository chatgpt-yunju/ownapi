const jwt = require('jsonwebtoken');
const db = require('../config/db');

async function validateSilentToken(token) {
  if (!token) {
    return { ok: false, status: 401, message: '未提供token' };
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return { ok: false, status: 401, message: 'token无效或已过期' };
  }

  const [[user]] = await db.query(
    'SELECT id, username, role, status FROM users WHERE id = ?',
    [payload.id]
  );
  if (!user) {
    return { ok: false, status: 404, message: '用户不存在' };
  }

  const [[quota]] = await db.query(
    'SELECT extra_quota, vip_expires_at, balance FROM user_quota WHERE user_id = ?',
    [payload.id]
  ).catch(() => [[null]]);

  const vip = Boolean(quota?.vip_expires_at && new Date(quota.vip_expires_at) > new Date());

  return {
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status || 'active',
      extra_quota: quota?.extra_quota ?? 0,
      vip,
      vip_expires_at: quota?.vip_expires_at ?? null,
      balance: quota?.balance ?? 0,
    },
  };
}

module.exports = { validateSilentToken };
