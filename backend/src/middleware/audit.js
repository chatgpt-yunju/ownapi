const db = require('../config/db');

async function auditLog(req, action, detail = '') {
  try {
    const userId = req.user?.id || null;
    const username = req.user?.username || null;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
    await db.query(
      'INSERT INTO admin_audit_logs (user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)',
      [userId, username, action, detail, ip]
    );
  } catch (e) {
    console.error('[审计] 写入失败:', e.message);
  }
}

module.exports = { auditLog };
