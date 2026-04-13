/**
 * License Tracker - 追踪部署域名使用情况
 * 收集匿名使用统计，发送给开发者
 */
const db = require('../config/db');
const { getSettingCached } = require('../routes/quota');

// 存储已知的域名（内存缓存，防止频繁通知）
const knownDomains = new Set();
let lastNotifyTime = 0;
const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000; // 5分钟内不重复通知

// 数据库表名
const TABLE_NAME = 'license_domain_tracking';

// 初始化数据库表（幂等）
async function initTrackingTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        domain VARCHAR(255) NOT NULL,
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        request_count INT DEFAULT 1,
        first_ip VARCHAR(45),
        first_user_agent TEXT,
        first_path VARCHAR(500),
        notified_at DATETIME,
        UNIQUE KEY idx_domain (domain)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } catch (e) {
    console.log('[license-tracker] Table init:', e.message);
  }
}

// 检查是否为开发/测试环境
function isDevEnvironment(domain, ip) {
  const devPatterns = [
    /^localhost$/i,
    /^127\.\d+\.\d+\.\d+$/,
    /^192\.168\.\d+\.\d+$/,
    /^10\.\d+\.\d+\.\d+$/,
    /^172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+$/,
    /^0\.0\.0\.0$/,
    /^::1$/,
    /^\[::\]$/,
    /\.local$/,
    /\.test$/,
    /\.dev$/,
    /\.example$/,
    /invalid/gi,
    /test/gi,
  ];
  return devPatterns.some(p => p.test(domain) || p.test(ip));
}

// 检查是否为已知的自动化工具/爬虫
function isBot(userAgent) {
  if (!userAgent) return false;
  const botPatterns = [
    /bot/i, /crawler/i, /spider/i, /scraper/i,
    /curl/i, /wget/i, /httpie/i, /postman/i,
    /uptimerobot/i, /pingdom/i, /statuscake/i,
  ];
  return botPatterns.some(p => p.test(userAgent));
}

// 记录域名访问
async function trackDomain(req) {
  const domain = (req.headers.host || req.hostname || '').toLowerCase().trim();
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const userAgent = req.headers['user-agent'] || '';
  const path = req.path || req.url || '/';

  // 跳过无效数据
  if (!domain || domain === 'undefined' || domain === 'null') return null;

  // 跳过开发环境和爬虫
  if (isDevEnvironment(domain, ip)) return null;
  if (isBot(userAgent)) return null;

  // 内存缓存检查（防止高频重复处理）
  if (knownDomains.has(domain)) return { domain, known: true };
  knownDomains.add(domain);

  // 确保表存在
  await initTrackingTable();

  try {
    // 尝试插入新记录，如果已存在则更新
    const [result] = await db.query(`
      INSERT INTO ${TABLE_NAME}
      (domain, first_ip, first_user_agent, first_path, request_count)
      VALUES (?, ?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE
      request_count = request_count + 1,
      last_seen_at = CURRENT_TIMESTAMP
    `, [domain, ip, userAgent.substring(0, 500), path.substring(0, 500)]);

    // 检查是否是新发现的域名
    const isNewDomain = result.affectedRows === 1; // INSERT 成功
    return { domain, isNew: isNewDomain, ip, path };
  } catch (e) {
    console.error('[license-tracker] Track error:', e.message);
    return null;
  }
}

// 获取未通知的域名列表
async function getUnnotifiedDomains() {
  try {
    const [rows] = await db.query(`
      SELECT * FROM ${TABLE_NAME}
      WHERE notified_at IS NULL
      ORDER BY first_seen_at DESC
      LIMIT 50
    `);
    return rows;
  } catch (e) {
    return [];
  }
}

// 标记域名已通知
async function markDomainsNotified(domainIds) {
  if (!domainIds.length) return;
  try {
    await db.query(`
      UPDATE ${TABLE_NAME}
      SET notified_at = CURRENT_TIMESTAMP
      WHERE id IN (${domainIds.map(() => '?').join(',')})
    `, domainIds);
  } catch (e) {
    console.error('[license-tracker] Mark notified error:', e.message);
  }
}

// 获取统计摘要
async function getTrackingSummary() {
  try {
    const [[total]] = await db.query(`SELECT COUNT(*) as count FROM ${TABLE_NAME}`);
    const [[today]] = await db.query(`
      SELECT COUNT(*) as count FROM ${TABLE_NAME}
      WHERE DATE(first_seen_at) = CURDATE()
    `);
    const [[unnotified]] = await db.query(`
      SELECT COUNT(*) as count FROM ${TABLE_NAME} WHERE notified_at IS NULL
    `);
    return {
      totalDomains: total.count,
      todayNew: today.count,
      unnotified: unnotified.count
    };
  } catch (e) {
    return { totalDomains: 0, todayNew: 0, unnotified: 0 };
  }
}

// 统计过去 N 天的域名趋势
async function getDomainTrend(days = 7) {
  try {
    const [rows] = await db.query(`
      SELECT
        DATE(first_seen_at) as date,
        COUNT(*) as count
      FROM ${TABLE_NAME}
      WHERE first_seen_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(first_seen_at)
      ORDER BY date DESC
    `, [days]);
    return rows;
  } catch (e) {
    return [];
  }
}

// Express 中间件
function trackingMiddleware(req, res, next) {
  // 跳过健康检查和静态资源
  if (req.path === '/api/health' || req.path.startsWith('/health')) {
    return next();
  }
  if (req.path.match(/\.(js|css|png|jpg|gif|ico|svg|woff|woff2|ttf)$/)) {
    return next();
  }

  // 异步追踪（不阻塞请求）
  trackDomain(req).catch(() => {});
  next();
}

module.exports = {
  trackingMiddleware,
  trackDomain,
  getUnnotifiedDomains,
  markDomainsNotified,
  getTrackingSummary,
  getDomainTrend,
  initTrackingTable,
  knownDomains,
  TABLE_NAME
};
