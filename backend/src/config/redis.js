const { createClient } = require('redis');

const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
});

redisClient.on('error', (err) => console.error('[Redis] 连接错误:', err.message));
redisClient.on('connect', () => console.log('[Redis] 连接成功'));

redisClient.connect().catch((err) => console.error('[Redis] 初始连接失败:', err.message));

module.exports = redisClient;
