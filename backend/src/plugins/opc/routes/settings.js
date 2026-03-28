const router = require('express').Router();
const db = require('../config/db');
const { adminAuth } = require('../middleware/auth');

// 公开：获取公开配置
router.get('/public', async (req, res) => {
  const publicKeys = ['site_name', 'site_slogan', 'author'];
  const [rows] = await db.query(`SELECT \`key\`,value FROM settings WHERE \`key\` IN (${publicKeys.map(() => '?').join(',')})`, publicKeys);
  const result = {};
  rows.forEach(r => result[r.key] = r.value);
  res.json(result);
});

// 管理：获取所有配置
router.get('/', adminAuth, async (req, res) => {
  const [rows] = await db.query('SELECT * FROM settings');
  const result = {};
  rows.forEach(r => result[r.key] = r.value);
  res.json(result);
});

// 管理：更新配置
router.put('/', adminAuth, async (req, res) => {
  const entries = Object.entries(req.body);
  for (const [key, value] of entries) {
    await db.query('INSERT INTO settings (`key`,value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=?', [key, value, value]);
  }
  res.json({ message: '配置更新成功' });
});

module.exports = router;
