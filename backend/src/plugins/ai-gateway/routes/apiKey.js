const router = require('express').Router();
const db = require('../../../config/db');
const { generateApiKey, hashApiKey, maskApiKey } = require('../utils/crypto');
const { verifyEmailCode, sendEmailCode } = require('../../../routes/emailCode');

const KEY_CREATE_COOLDOWN_MS = 60 * 1000;
const keyCreateTimestamps = new Map();

// 运行时迁移：添加 is_deleted 字段
db.query('ALTER TABLE openclaw_api_keys ADD COLUMN is_deleted TINYINT NOT NULL DEFAULT 0').catch(() => {});

// 获取用户所有密钥（排除已删除）
router.get('/list', async (req, res) => {
  try {
    const [keys] = await db.query(
      'SELECT id, key_display, name, status, created_at, last_used_at FROM openclaw_api_keys WHERE user_id = ? AND is_deleted = 0 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ keys });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取密钥失败' });
  }
});

// 获取当前用户邮箱（脱敏）
router.get('/email-status', async (req, res) => {
  try {
    const [[user]] = await db.query('SELECT email FROM users WHERE id = ?', [req.user.id]);
    if (!user?.email) return res.json({ hasEmail: false });
    const [local, domain] = user.email.split('@');
    const masked = local.length <= 2 ? `${local[0]}***@${domain}` : `${local.slice(0, 2)}***@${domain}`;
    res.json({ hasEmail: true, maskedEmail: masked });
  } catch (err) {
    res.status(500).json({ error: '查询失败' });
  }
});

// 发送 API Key 创建验证码（自动查邮箱）
router.post('/send-code', async (req, res) => {
  try {
    const [[user]] = await db.query('SELECT email FROM users WHERE id = ?', [req.user.id]);
    if (!user?.email) {
      return res.status(400).json({ error: '请先绑定邮箱', needBindEmail: true });
    }
    const masked = await sendEmailCode(user.email, 'apikey');
    res.json({ message: '验证码已发送', masked_email: masked });
  } catch (err) {
    const status = err.message.includes('秒后再试') ? 429 : 500;
    res.status(status).json({ error: err.message });
  }
});

// 创建新密钥（邮箱验证码 + 频率限制）
router.post('/create', async (req, res) => {
  const { name, email_code } = req.body;
  const userId = req.user.id;

  try {
    if (!email_code) {
      return res.status(400).json({ error: '请输入邮箱验证码', needEmailCode: true });
    }

    // 1. 查用户邮箱
    const [[user]] = await db.query('SELECT email FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(401).json({ error: '用户不存在' });
    if (!user.email) {
      return res.status(400).json({ error: '请先绑定邮箱', needBindEmail: true });
    }

    // 2. 验证邮箱验证码
    const valid = await verifyEmailCode(user.email, email_code, 'apikey');
    if (!valid) return res.status(403).json({ error: '验证码错误或已过期' });

    // 3. 频率限制
    const lastCreate = keyCreateTimestamps.get(userId);
    if (lastCreate && Date.now() - lastCreate < KEY_CREATE_COOLDOWN_MS) {
      const waitSec = Math.ceil((KEY_CREATE_COOLDOWN_MS - (Date.now() - lastCreate)) / 1000);
      return res.status(429).json({ error: `操作过于频繁，请 ${waitSec} 秒后再试` });
    }

    // 4. 限制每用户最多10个key（排除已删除）
    const [[{ cnt }]] = await db.query('SELECT COUNT(*) as cnt FROM openclaw_api_keys WHERE user_id = ? AND is_deleted = 0', [userId]);
    if (cnt >= 10) return res.status(400).json({ error: '最多创建10个密钥' });

    const key = generateApiKey();
    const keyHash = hashApiKey(key);
    const keyDisplay = maskApiKey(key);
    const keyPrefix = key.slice(0, 7);

    await db.query(
      'INSERT INTO openclaw_api_keys (user_id, key_prefix, key_hash, key_display, name) VALUES (?, ?, ?, ?, ?)',
      [userId, keyPrefix, keyHash, keyDisplay, name || 'Default Key']
    );

    keyCreateTimestamps.set(userId, Date.now());
    res.json({ key, display: keyDisplay, message: '请保存此密钥，后续无法再次查看完整密钥' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '创建密钥失败' });
  }
});

// 禁用/启用密钥（自动切换）
router.post('/toggle', async (req, res) => {
  const { id } = req.body;
  try {
    const [[key]] = await db.query(
      'SELECT status FROM openclaw_api_keys WHERE id = ? AND user_id = ? AND is_deleted = 0',
      [id, req.user.id]
    );
    if (!key) return res.status(404).json({ error: '密钥不存在' });
    const newStatus = key.status === 'active' ? 'disabled' : 'active';
    await db.query(
      'UPDATE openclaw_api_keys SET status = ? WHERE id = ? AND user_id = ?',
      [newStatus, id, req.user.id]
    );
    res.json({ message: newStatus === 'active' ? '已启用' : '已禁用', status: newStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '操作失败' });
  }
});

// 删除密钥（软删除：标记 is_deleted）
router.post('/delete', async (req, res) => {
  const { id } = req.body;
  try {
    const [result] = await db.query(
      'UPDATE openclaw_api_keys SET is_deleted = 1, status = "disabled" WHERE id = ? AND user_id = ? AND is_deleted = 0',
      [id, req.user.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: '密钥不存在' });
    res.json({ message: '已删除' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '操作失败' });
  }
});

module.exports = router;
