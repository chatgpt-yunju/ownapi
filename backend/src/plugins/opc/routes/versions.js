const router = require('express').Router();
const db = require('../config/db');
const { adminAuth } = require('../middleware/auth');

// 公开：获取最新版本
router.get('/latest', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM versions WHERE is_latest=1 LIMIT 1');
  res.json(rows[0] || {});
});

// 管理：获取所有版本
router.get('/', adminAuth, async (req, res) => {
  const [rows] = await db.query('SELECT * FROM versions ORDER BY created_at DESC');
  res.json(rows);
});

// 管理：发布新版本
router.post('/', adminAuth, async (req, res) => {
  const { version, notes, download_url, force_update } = req.body;
  await db.query('UPDATE versions SET is_latest=0');
  await db.query('INSERT INTO versions (version,notes,download_url,force_update,is_latest) VALUES (?,?,?,?,1)',
    [version, notes, download_url, force_update || 0]);
  res.json({ message: '版本发布成功' });
});

module.exports = router;
