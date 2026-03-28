const nodemailer = require('nodemailer');
const db = require('./config/db');
const { getSetting } = require('./routes/quota');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '2743319061@qq.com';
const BACKUP_DIR = path.join(__dirname, '../backups');
const LOW_STOCK_THRESHOLD = 2;

// Track today's low-stock alerts to avoid duplicates
const alertedToday = new Set();
let alertedDate = '';

async function getTransporter() {
  const host = await getSetting('smtp_host') || 'smtp.qq.com';
  const port = parseInt(await getSetting('smtp_port')) || 465;
  const user = await getSetting('smtp_user');
  const pass = await getSetting('smtp_pass');
  if (!user || !pass) return null;
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
}

async function sendMail(subject, html, attachments = []) {
  const transporter = await getTransporter();
  if (!transporter) return console.warn('[Scheduler] SMTP未配置，跳过邮件');
  const from = await getSetting('smtp_user');
  await transporter.sendMail({ from, to: ADMIN_EMAIL, subject, html, attachments });
}

// ── Daily DB backup ──────────────────────────────────────────────────────────
async function runBackup() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const dbName = process.env.DB_NAME || 'wechat_cms';
  const dbUser = process.env.DB_USER || 'root';
  const dbPass = process.env.DB_PASSWORD || '';
  const dbHost = process.env.DB_HOST || 'localhost';
  const dbPort = process.env.DB_PORT || '3306';

  const safeStr = s => s.replace(/[^a-zA-Z0-9_\-\.@]/g, '');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `backup-${timestamp}.sql`;
  const filepath = path.join(BACKUP_DIR, filename);

  const args = [`-h${safeStr(dbHost)}`, `-P${safeStr(dbPort)}`, `-u${safeStr(dbUser)}`, `--result-file=${filepath}`, safeStr(dbName)];
  const env = { ...process.env };
  if (dbPass) env.MYSQL_PWD = dbPass;

  return new Promise(resolve => {
    execFile('mysqldump', args, { env }, async err => {
      if (err) { console.error('[Backup] 失败:', err.message); return resolve(null); }
      const size = fs.statSync(filepath).size;
      console.log(`[Backup] 成功: ${filename} (${(size / 1024).toFixed(1)} KB)`);
      try {
        await sendMail(
          `【自动备份】数据库备份 ${timestamp}`,
          `<p>备份文件：<b>${filename}</b><br>大小：${(size / 1024).toFixed(1)} KB<br>时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>`,
          [{ filename, path: filepath }]
        );
      } catch (e) { console.error('[Backup] 邮件失败:', e.message); }
      resolve(filepath);
    });
  });
}

// ── Payment-triggered backup ─────────────────────────────────────────────────
async function sendPaymentBackup(orderInfo) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const dbName = process.env.DB_NAME || 'wechat_cms';
  const dbUser = process.env.DB_USER || 'root';
  const dbPass = process.env.DB_PASSWORD || '';
  const dbHost = process.env.DB_HOST || 'localhost';
  const dbPort = process.env.DB_PORT || '3306';
  const safeStr = s => s.replace(/[^a-zA-Z0-9_\-\.@]/g, '');

  const dbFile = path.join(BACKUP_DIR, `pay-db-${timestamp}.sql`);
  const srcFile = path.join(BACKUP_DIR, `pay-src-${timestamp}.tar.gz`);
  const projectRoot = path.join(__dirname, '../../');

  // Step 1: mysqldump
  await new Promise((resolve, reject) => {
    const args = [`-h${safeStr(dbHost)}`, `-P${safeStr(dbPort)}`, `-u${safeStr(dbUser)}`, `--result-file=${dbFile}`, safeStr(dbName)];
    const env = { ...process.env };
    if (dbPass) env.MYSQL_PWD = dbPass;
    execFile('mysqldump', args, { env }, err => err ? reject(err) : resolve());
  });

  // Step 2: tar source (exclude node_modules, uploads, backups, .git)
  await new Promise((resolve, reject) => {
    const args = [
      '-czf', srcFile,
      '--exclude=./node_modules', '--exclude=./frontend/admin/node_modules',
      '--exclude=./frontend/user/node_modules', '--exclude=./backend/uploads',
      '--exclude=./backend/backups', '--exclude=./.git',
      '.',
    ];
    execFile('tar', args, { cwd: projectRoot }, err => err ? reject(err) : resolve());
  });

  const dbSize = (fs.statSync(dbFile).size / 1024).toFixed(1);
  const srcSize = (fs.statSync(srcFile).size / 1024).toFixed(1);
  const label = orderInfo?.source === 'shop' ? '商城' : '充值';
  const html = `
<h2 style="color:#07c160">💰 支付成功备份通知</h2>
<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse">
  <tr><td>来源</td><td>${label}</td></tr>
  <tr><td>订单号</td><td>${orderInfo?.tradeNo || '-'}</td></tr>
  <tr><td>金额</td><td>¥${orderInfo?.amount || '-'}</td></tr>
  <tr><td>用户ID</td><td>${orderInfo?.userId || '-'}</td></tr>
  <tr><td>时间</td><td>${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</td></tr>
  <tr><td>数据库备份</td><td>${path.basename(dbFile)} (${dbSize} KB)</td></tr>
  <tr><td>源码备份</td><td>${path.basename(srcFile)} (${srcSize} KB)</td></tr>
</table>`;

  try {
    await sendMail(
      `【支付备份】${label}订单 ${orderInfo?.tradeNo || timestamp}`,
      html,
      [
        { filename: path.basename(dbFile), path: dbFile },
        { filename: path.basename(srcFile), path: srcFile },
      ]
    );
    console.log(`[PayBackup] 备份邮件已发送，订单: ${orderInfo?.tradeNo}`);
  } catch (e) {
    console.error('[PayBackup] 邮件发送失败:', e.message);
  }
}

// ── Daily operations report ──────────────────────────────────────────────────
async function sendDailyReport() {
  try {
    const now = new Date();
    const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() + 8 * 3600000 - 86400000).toISOString().slice(0, 10);

    // User stats
    const [[{ total_users }]] = await db.query('SELECT COUNT(*) AS total_users FROM users');
    const [[{ new_users }]] = await db.query("SELECT COUNT(*) AS new_users FROM users WHERE DATE(created_at) = ?", [today]);
    const [[{ active_users }]] = await db.query("SELECT COUNT(DISTINCT user_id) AS active_users FROM quota_logs WHERE DATE(created_at) = ?", [today]);

    // Payment stats
    const [[{ paid_orders, paid_amount }]] = await db.query(
      "SELECT COUNT(*) AS paid_orders, COALESCE(SUM(amount),0) AS paid_amount FROM recharge_orders WHERE status='paid' AND DATE(paid_at) = ?", [today]
    );

    // Content stats
    const [[{ total_content }]] = await db.query("SELECT COUNT(*) AS total_content FROM content WHERE review_status='approved'");
    const [[{ claims_today }]] = await db.query("SELECT COUNT(*) AS claims_today FROM claims WHERE DATE(claimed_at) = ?", [today]);
    const [[{ pending_review }]] = await db.query("SELECT COUNT(*) AS pending_review FROM content WHERE review_status='pending'");

    // Low stock categories
    const [lowStock] = await db.query(`
      SELECT COALESCE(c.category,'未分类') AS category,
        SUM(CASE WHEN cl.id IS NULL THEN 1 ELSE 0 END) AS unclaimed
      FROM content c
      LEFT JOIN claims cl ON cl.content_id = c.id
      WHERE c.video_path IS NOT NULL AND c.video_path != '' AND c.review_status='approved'
      GROUP BY category HAVING unclaimed <= ?
    `, [LOW_STOCK_THRESHOLD]);

    // Suspicious users: >50 quota logs today
    const [suspiciousUsers] = await db.query(`
      SELECT u.username, COUNT(*) AS ops
      FROM quota_logs ql JOIN users u ON u.id = ql.user_id
      WHERE DATE(ql.created_at) = ?
      GROUP BY ql.user_id HAVING ops > 50
    `, [today]);

    // Top claimers today
    const [topClaimers] = await db.query(`
      SELECT u.username, COUNT(*) AS cnt
      FROM claims cl JOIN users u ON u.id = cl.user_id
      WHERE DATE(cl.claimed_at) = ?
      GROUP BY cl.user_id ORDER BY cnt DESC LIMIT 5
    `, [today]);

    const lowStockHtml = lowStock.length
      ? lowStock.map(r => `<tr><td>${r.category}</td><td style="color:#e53935"><b>${r.unclaimed}</b></td></tr>`).join('')
      : '<tr><td colspan="2" style="color:#999">无库存预警</td></tr>';

    const suspiciousHtml = suspiciousUsers.length
      ? suspiciousUsers.map(r => `<tr><td>${r.username}</td><td style="color:#e53935">${r.ops}</td></tr>`).join('')
      : '<tr><td colspan="2" style="color:#999">无异常用户</td></tr>';

    const topClaimersHtml = topClaimers.length
      ? topClaimers.map(r => `<tr><td>${r.username}</td><td>${r.cnt}</td></tr>`).join('')
      : '<tr><td colspan="2" style="color:#999">暂无数据</td></tr>';

    const html = `
<html><body style="font-family:sans-serif;max-width:700px;margin:0 auto;padding:20px">
<h2 style="color:#07c160">📊 每日运营报告 — ${today}</h2>

<h3>👥 用户数据</h3>
<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
  <tr><th>指标</th><th>数值</th></tr>
  <tr><td>总用户数</td><td>${total_users}</td></tr>
  <tr><td>今日新增用户</td><td>${new_users}</td></tr>
  <tr><td>今日活跃用户</td><td>${active_users}</td></tr>
</table>

<h3>💰 支付数据</h3>
<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
  <tr><th>指标</th><th>数值</th></tr>
  <tr><td>今日支付订单</td><td>${paid_orders}</td></tr>
  <tr><td>今日支付金额</td><td>¥${Number(paid_amount).toFixed(2)}</td></tr>
</table>

<h3>🎬 内容数据</h3>
<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
  <tr><th>指标</th><th>数值</th></tr>
  <tr><td>已上架视频总数</td><td>${total_content}</td></tr>
  <tr><td>今日领取次数</td><td>${claims_today}</td></tr>
  <tr><td>待审核视频</td><td>${pending_review}</td></tr>
</table>

<h3>⚠️ 库存预警（剩余≤${LOW_STOCK_THRESHOLD}条）</h3>
<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
  <tr><th>分类</th><th>剩余未领取</th></tr>
  ${lowStockHtml}
</table>

<h3>🚨 异常用户（今日操作>50次）</h3>
<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
  <tr><th>用户名</th><th>今日操作次数</th></tr>
  ${suspiciousHtml}
</table>

<h3>🏆 今日领取排行 Top5</h3>
<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
  <tr><th>用户名</th><th>领取次数</th></tr>
  ${topClaimersHtml}
</table>

<p style="color:#999;font-size:12px;margin-top:24px">报告生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>
</body></html>`;

    await sendMail(`【每日报告】运营数据 ${today}`, html);
    console.log(`[Report] 每日报告已发送 ${today}`);
  } catch (e) {
    console.error('[Report] 发送失败:', e.message);
  }
}

// ── Low stock alert (called after each claim) ────────────────────────────────
async function checkLowStock(contentId) {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  if (alertedDate !== today) { alertedDate = today; alertedToday.clear(); }

  const [[item]] = await db.query('SELECT category FROM content WHERE id = ?', [contentId]);
  if (!item) return;
  const category = item.category || '未分类';
  if (alertedToday.has(category)) return;

  const [[{ unclaimed }]] = await db.query(`
    SELECT SUM(CASE WHEN cl.id IS NULL THEN 1 ELSE 0 END) AS unclaimed
    FROM content c LEFT JOIN claims cl ON cl.content_id = c.id
    WHERE c.video_path IS NOT NULL AND c.video_path != ''
      AND COALESCE(c.category,'未分类') = ?
  `, [category]);

  if (unclaimed > LOW_STOCK_THRESHOLD) return;
  alertedToday.add(category);

  try {
    await sendMail(
      `【库存预警】「${category}」仅剩${unclaimed}条视频`,
      `<h2 style="color:#e53935">⚠️ 视频库存预警</h2><p>分类 <strong>「${category}」</strong> 剩余未领取视频仅剩 <strong style="color:#e53935">${unclaimed}</strong> 条，请及时补充！</p>`
    );
    console.log(`[预警] 已发送「${category}」库存预警，剩余${unclaimed}条`);
  } catch (e) {
    console.error('[预警] 邮件发送失败:', e.message);
  }
}

// ── Cron scheduler ───────────────────────────────────────────────────────────
try {
  const cron = require('node-cron');
  // 每日凌晨2点备份
  cron.schedule('0 2 * * *', () => { console.log('[Cron] 开始自动备份...'); runBackup(); }, { timezone: 'Asia/Shanghai' });
  // 每日早8点发运营报告
  cron.schedule('0 8 * * *', () => { console.log('[Cron] 发送每日报告...'); sendDailyReport(); }, { timezone: 'Asia/Shanghai' });
  console.log('[Scheduler] 定时任务已启动');
} catch (e) {
  console.warn('[Scheduler] node-cron未安装，定时任务不可用:', e.message);
}

module.exports = { checkLowStock, runBackup, sendDailyReport, sendPaymentBackup };
