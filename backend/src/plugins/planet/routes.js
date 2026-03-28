const router = require('express').Router();

// Mount planet sub-routes
router.use('/captcha', require('./routes/captcha'));
router.use('/auth', require('./routes/auth'));
router.use('/sso', require('./routes/sso'));
router.use('/quota', require('./routes/quota'));
router.use('/settings', require('./routes/settings'));
router.use('/planet', require('./routes/planet'));
router.use('/pay', require('./routes/pay'));
router.use('/search', require('./routes/search'));

// Cron: 定时发帖（每分钟检查，北京时间 6:00-24:00 每30分钟发一篇）
const db = require('../../config/db');
const { autoQueueIfNeeded } = require('./services/queueAiNews');
let lastPublishedSlot = -1;

setInterval(async () => {
  autoQueueIfNeeded().catch(e => console.error('[planet-cron] auto-queue 错误:', e.message));
  try {
    const HALF_HOUR_MS = 1800000;
    const BEIJING_OFFSET = 8 * 3600000;
    const nowUTC = Date.now();
    const beijingMs = nowUTC + BEIJING_OFFSET;
    const beijingHour = Math.floor(beijingMs / 3600000) % 24;
    if (beijingHour < 6) return;
    const slot = Math.floor(beijingMs / HALF_HOUR_MS);
    if (slot === lastPublishedSlot) return;
    const slotStartUTC = new Date(slot * HALF_HOUR_MS - BEIJING_OFFSET);
    const slotEndUTC = new Date(slotStartUTC.getTime() + HALF_HOUR_MS);
    const [[{ cnt }]] = await db.query(
      'SELECT COUNT(*) as cnt FROM planet_posts WHERE published_at >= ? AND published_at < ?',
      [slotStartUTC, slotEndUTC]
    );
    if (parseInt(cnt) > 0) { lastPublishedSlot = slot; return; }
    const [[post]] = await db.query(
      `SELECT id FROM planet_posts
       WHERE publish_status = 'scheduled' AND review_status = 'approved'
         AND rewrite_status IN ('completed', 'failed')
       ORDER BY created_at ASC LIMIT 1`
    );
    if (!post) return;
    await db.query(
      "UPDATE planet_posts SET publish_status = 'published', published_at = ? WHERE id = ?",
      [slotStartUTC, post.id]
    );
    lastPublishedSlot = slot;
    const beijingMin = (slot % 2 === 0) ? 0 : 30;
    console.log(`[planet-cron] 定时帖子 ${post.id} 已发布（北京时间 ${beijingHour}:${String(beijingMin).padStart(2, '0')}）`);
  } catch (e) {
    console.error('[planet-cron] 定时发帖错误:', e.message);
  }
}, 60000);

module.exports = router;
