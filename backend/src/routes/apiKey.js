const router = require('express').Router();
const db = require('../config/db');
const { generateApiKey, hashApiKey, maskApiKey } = require('../utils/crypto');

// 获取用户所有密钥
router.get('/list', async (req, res) => {
  try {
    const [keys] = await db.query(
      'SELECT id, key_display, name, status, created_at, last_used_at FROM openclaw_api_keys WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ keys });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取密钥失败' });
  }
});

// 创建新密钥
router.post('/create', async (req, res) => {
  const { name } = req.body;
  try {
    // 限制每用户最多10个key
    const [[{ cnt }]] = await db.query('SELECT COUNT(*) as cnt FROM openclaw_api_keys WHERE user_id = ?', [req.user.id]);
    if (cnt >= 10) return res.status(400).json({ error: '最多创建10个密钥' });

    const key = generateApiKey();
    const keyHash = hashApiKey(key);
    const keyDisplay = maskApiKey(key);
    const keyPrefix = key.slice(0, 7);

    await db.query(
      'INSERT INTO openclaw_api_keys (user_id, key_prefix, key_hash, key_display, name) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, keyPrefix, keyHash, keyDisplay, name || 'Default Key']
    );

    // 只在创建时返回完整 key，之后不可查看
    res.json({ key, display: keyDisplay, message: '请保存此密钥，后续无法再次查看完整密钥' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '创建密钥失败' });
  }
});

// 禁用/启用密钥
router.post('/toggle', async (req, res) => {
  const { id, status } = req.body;
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: '无效状态' });

  try {
    const [result] = await db.query(
      'UPDATE openclaw_api_keys SET status = ? WHERE id = ? AND user_id = ?',
      [status, id, req.user.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: '密钥不存在' });
    res.json({ message: status === 'active' ? '已启用' : '已禁用' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '操作失败' });
  }
});

// 删除密钥（软删除：设为disabled）
router.post('/delete', async (req, res) => {
  const { id } = req.body;
  try {
    const [result] = await db.query(
      'UPDATE openclaw_api_keys SET status = "disabled" WHERE id = ? AND user_id = ?',
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
