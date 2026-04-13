/**
 * License Module - 域名授权追踪系统
 *
 * 功能：
 * 1. 追踪部署域名使用情况
 * 2. 发送部署通知邮件（默认发送到 2743319061@qq.com）
 * 3. 生成每日使用统计
 *
 * 使用方法：
 * 1. 在 app.js 中引入并初始化：
 *    const license = require('./license');
 *    app.use(license.trackingMiddleware);
 *
 * 2. 配置环境变量（可选）：
 *    LICENSE_NOTIFY_EMAIL=your@email.com  # 接收通知的邮箱
 *    DISABLE_TELEMETRY=1                   # 关闭追踪（尊重隐私）
 *
 * 3. 确保数据库可以创建 license_domain_tracking 表
 */

const tracker = require('./tracker');
const notifier = require('./notifier');
const hybrid = require('./hybrid-tracker');

// 自动初始化（延迟执行，等待数据库连接就绪）
let initialized = false;
let newDomainNotifyQueue = [];
let notifyTimer = null;

async function initLicenseModule() {
  if (initialized) return;
  if (notifier.DISABLE_TELEMETRY) {
    console.log('[license] Telemetry disabled');
    return;
  }

  try {
    // 初始化数据库表
    await tracker.initTrackingTable();

    // 启动通知定时器（每30秒检查一次新域名并发送通知）
    startNewDomainNotifier();

    // 初始化每日汇总定时任务
    await notifier.initNotifier();

    initialized = true;
    console.log('[license] Module initialized');
  } catch (e) {
    console.error('[license] Init failed:', e.message);
  }
}

// 新域名通知机制（防抖批量）
function startNewDomainNotifier() {
  notifyTimer = setInterval(async () => {
    if (newDomainNotifyQueue.length === 0) return;

    // 取出队列中的域名
    const domains = [...newDomainNotifyQueue];
    newDomainNotifyQueue = [];

    // 发送通知
    for (const info of domains) {
      await notifier.notifyNewDomain(info);
    }

    // 标记为已通知
    try {
      const tracker = require('./tracker');
      const db = require('../config/db');
      const domainNames = domains.map(d => d.domain);
      if (domainNames.length) {
        await db.query(`
          UPDATE ${tracker.TABLE_NAME}
          SET notified_at = CURRENT_TIMESTAMP
          WHERE domain IN (${domainNames.map(() => '?').join(',')})
        `, domainNames);
      }
    } catch (e) {
      console.error('[license] Mark notified error:', e.message);
    }
  }, 30000); // 30秒批量发送一次
}

// 增强版追踪中间件（带即时通知）
async function enhancedTrackingMiddleware(req, res, next) {
  // 调用原始追踪
  const result = await tracker.trackDomain(req);

  // 如果是新域名，加入通知队列
  if (result && result.isNew && result.domain) {
    newDomainNotifyQueue.push({
      domain: result.domain,
      ip: result.ip,
      path: result.path,
      firstSeen: new Date().toISOString()
    });
  }

  next();
}

// Express 中间件（使用增强版）
const trackingMiddleware = (req, res, next) => {
  // 跳过健康检查和静态资源
  if (req.path === '/api/health' || req.path === '/api/internal/metrics') {
    return next();
  }
  if (req.path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/i)) {
    return next();
  }

  // 异步追踪
  enhancedTrackingMiddleware(req, res, next);
};

// API 路由 - 获取追踪统计（仅限管理员）
const statsRouter = require('express').Router();

statsRouter.get('/stats', async (req, res) => {
  try {
    // 简单的密钥验证（在生产环境应该用 JWT）
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.INTERNAL_API_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const summary = await tracker.getTrackingSummary();
    const trend = await tracker.getDomainTrend(30);

    res.json({
      ...summary,
      trend,
      email: process.env.LICENSE_NOTIFY_EMAIL || '2743319061@qq.com',
      telemetryEnabled: !notifier.DISABLE_TELEMETRY
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

statsRouter.get('/domains', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.INTERNAL_API_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const [rows] = await require('../config/db').query(`
      SELECT * FROM ${tracker.TABLE_NAME}
      ORDER BY last_seen_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    res.json({ domains: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 导出
module.exports = {
  // 中间件
  trackingMiddleware,

  // 多层防护追踪（不依赖用户配置）
  hybridTracker: hybrid.hybridTracker,
  fingerprintMiddleware: hybrid.fingerprintMiddleware(),

  // 初始化函数
  init: initLicenseModule,

  // 追踪函数
  trackDomain: tracker.trackDomain,
  getUnnotifiedDomains: tracker.getUnnotifiedDomains,
  markDomainsNotified: tracker.markDomainsNotified,
  getTrackingSummary: tracker.getTrackingSummary,
  getDomainTrend: tracker.getDomainTrend,

  // 通知函数
  sendNotification: notifier.sendNotification,
  notifyNewDomain: notifier.notifyNewDomain,
  sendDailySummary: notifier.sendDailySummary,

  // 统计路由
  statsRouter,

  // 配置
  DISABLE_TELEMETRY: notifier.DISABLE_TELEMETRY
};

// 延迟自动初始化（确保数据库已连接）
setTimeout(() => {
  initLicenseModule().catch(e => {
    console.error('[license] Auto-init failed:', e.message);
  });
}, 5000);
