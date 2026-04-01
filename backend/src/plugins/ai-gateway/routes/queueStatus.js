'use strict';
/**
 * 队列监控路由
 * GET  /api/admin/queue/status       — 查看当前队列状态
 * POST /api/admin/queue/config/reload — 强制刷新配置（无需重启）
 */

const router = require('express').Router();
const { adminOnly } = require('../middleware/auth');
const { getQueueStats, refreshConfig } = require('../middleware/requestQueue');
const cache = require('../utils/cache');

// GET /api/admin/queue/status
router.get('/status', adminOnly, async (req, res) => {
  const stats = await getQueueStats();

  let redisStats = null;
  try {
    if (cache.redis && cache.redis.status === 'ready') {
      redisStats = await cache.redis.hgetall('queue:stats');
    }
  } catch { /* 忽略 */ }

  res.json({
    queue: stats,
    redis: redisStats,
    timestamp: new Date().toISOString(),
  });
});

// POST /api/admin/queue/config/reload
router.post('/config/reload', adminOnly, async (req, res) => {
  await refreshConfig();
  res.json({ ok: true, config: await getQueueStats() });
});

module.exports = router;
