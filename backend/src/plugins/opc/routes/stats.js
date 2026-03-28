const router = require('express').Router();
const db = require('../config/db');
const { adminAuth } = require('../middleware/auth');

// 管理：统计概览
router.get('/', adminAuth, async (req, res) => {
  const [[{ total_users }]] = await db.query('SELECT COUNT(*) as total_users FROM users');
  const [[{ total_launches }]] = await db.query('SELECT COUNT(*) as total_launches FROM launch_logs');
  const [[{ today_launches }]] = await db.query('SELECT COUNT(*) as today_launches FROM launch_logs WHERE DATE(created_at)=CURDATE()');
  const [model_dist] = await db.query('SELECT model, COUNT(*) as count FROM launch_logs GROUP BY model ORDER BY count DESC');
  const [scene_dist] = await db.query('SELECT scene, COUNT(*) as count FROM launch_logs GROUP BY scene ORDER BY count DESC');
  res.json({ total_users, total_launches, today_launches, model_dist, scene_dist });
});

// 记录启动日志（用户端调用）
router.post('/launch', async (req, res) => {
  const { model, scene } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  await db.query('INSERT INTO launch_logs (model,scene,ip) VALUES (?,?,?)', [model, scene, ip]);
  res.json({ message: 'ok' });
});

module.exports = router;
