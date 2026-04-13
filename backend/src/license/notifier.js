/**
 * License Notifier - 发送追踪通知邮件
 * 使用现有的 nodemailer SMTP 配置
 */
const nodemailer = require('nodemailer');
const { getSettingCached } = require('../routes/quota');

// 环境变量
const NOTIFY_EMAIL = process.env.LICENSE_NOTIFY_EMAIL || '2743319061@qq.com';
const DISABLE_TELEMETRY = process.env.DISABLE_TELEMETRY === '1';

// 全局配置
let _isInitializing = false;
let _globalTransporter = null;

// 获取 SMTP Transporter（复用现有配置）
async function getTransporter() {
  if (_globalTransporter) return _globalTransporter;
  if (_isInitializing) {
    // 等待初始化完成
    await new Promise(resolve => setTimeout(resolve, 100));
    return getTransporter();
  }

  _isInitializing = true;
  try {
    const host = await getSettingCached('smtp_host', '');
    const port = parseInt(await getSettingCached('smtp_port', '465'));
    const user = await getSettingCached('smtp_user', '');
    const pass = await getSettingCached('smtp_pass', '');

    if (!host || !user || !pass) {
      console.log('[license-notifier] SMTP not configured');
      _isInitializing = false;
      return null;
    }

    _globalTransporter = nodemailer.createTransporter({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      // 添加连接池配置
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
    });

    _isInitializing = false;
    return _globalTransporter;
  } catch (e) {
    console.error('[license-notifier] Transporter init error:', e.message);
    _isInitializing = false;
    return null;
  }
}

// 检验是否允许发送
function canSendNotification() {
  if (DISABLE_TELEMETRY) {
    console.log('[license-notifier] Telemetry disabled');
    return false;
  }
  return true;
}

// 发送通知邮件
async function sendNotification(subject, html, options = {}) {
  if (!canSendNotification()) return false;

  const transporter = await getTransporter();
  if (!transporter) return false;

  try {
    const smtpUser = await getSettingCached('smtp_user', '');
    const fromName = options.fromName || '代码授权追踪';

    await transporter.sendMail({
      from: `"${fromName}" <${smtpUser}>`,
      to: options.to || NOTIFY_EMAIL,
      subject,
      html,
      // 添加文本版本
      text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    });

    console.log(`[license-notifier] Notification sent: ${subject}`);
    return true;
  } catch (e) {
    console.error('[license-notifier] Send failed:', e.message);
    return false;
  }
}

// 发送新域名发现通知
async function notifyNewDomain(domainInfo) {
  const { domain, ip, path, firstSeen } = domainInfo;
  const when = firstSeen || new Date().toISOString();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 24px; color: white; }
    .header h2 { margin: 0; font-size: 20px; }
    .content { padding: 24px; }
    .info-row { display: flex; padding: 12px 0; border-bottom: 1px solid #eee; }
    .info-row:last-child { border-bottom: none; }
    .info-label { width: 100px; color: #666; font-weight: 500; }
    .info-value { flex: 1; color: #333; font-family: monospace; font-size: 14px; }
    .domain-highlight { background: #e8f5e9; color: #2e7d32; padding: 4px 12px; border-radius: 4px; font-weight: bold; }
    .footer { background: #f8f9fa; padding: 16px 24px; color: #666; font-size: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>🚀 新域名部署通知</h2>
    </div>
    <div class="content">
      <p>检测到新的代码部署：</p>
      <div class="info-row">
        <span class="info-label">域名</span>
        <span class="info-value"><span class="domain-highlight">${domain}</span></span>
      </div>
      <div class="info-row">
        <span class="info-label">IP 地址</span>
        <span class="info-value">${ip || '未知'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">首次路径</span>
        <span class="info-value">${path || '/'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">发现时间</span>
        <span class="info-value">${new Date(when).toLocaleString('zh-CN')}</span>
      </div>
    </div>
    <div class="footer">
      此邮件由代码授权追踪系统自动发送
    </div>
  </div>
</body>
</html>`;

  return sendNotification(
    `【授权追踪】新域名部署: ${domain}`,
    html,
    { fromName: '代码授权系统' }
  );
}

// 发送每日汇总通知
async function sendDailySummary(summary, newDomains = []) {
  const { totalDomains, todayNew, unnotified } = summary;

  const domainList = newDomains.length > 0
    ? newDomains.map(d => `<li>${d.domain} <span style="color:#999;font-size:12px">(${new Date(d.first_seen_at).toLocaleDateString('zh-CN')})</span></li>`).join('')
    : '<li style="color:#999">今日无新增域名</li>';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 24px; color: white; }
    .header h2 { margin: 0; font-size: 20px; }
    .stats { display: flex; padding: 24px; gap: 16px; }
    .stat-item { flex: 1; text-align: center; padding: 16px; background: #f8f9fa; border-radius: 8px; }
    .stat-value { font-size: 32px; font-weight: bold; color: #667eea; }
    .stat-label { font-size: 12px; color: #666; margin-top: 4px; }
    .content { padding: 0 24px 24px; }
    .section-title { font-size: 16px; font-weight: bold; color: #333; margin-bottom: 12px; }
    .domain-list { list-style: none; padding: 0; margin: 0; }
    .domain-list li { padding: 8px 0; border-bottom: 1px solid #f0f0f0; }
    .domain-list li:last-child { border-bottom: none; }
    .footer { background: #f8f9fa; padding: 16px 24px; color: #666; font-size: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>📊 每日部署统计</h2>
    </div>
    <div class="stats">
      <div class="stat-item">
        <div class="stat-value">${totalDomains}</div>
        <div class="stat-label">总域名数</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${todayNew}</div>
        <div class="stat-label">今日新增</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${unnotified}</div>
        <div class="stat-label">待通知</div>
      </div>
    </div>
    <div class="content">
      <div class="section-title">今日新增域名</div>
      <ul class="domain-list">
        ${domainList}
      </ul>
    </div>
    <div class="footer">
      YunjuNET API Gateway - 代码授权追踪系统 | ${new Date().toLocaleDateString('zh-CN')}
    </div>
  </div>
</body>
</html>`;

  return sendNotification(
    `【授权追踪】每日统计 - ${new Date().toLocaleDateString('zh-CN')}`,
    html,
    { fromName: '代码授权系统' }
  );
}

// 发送启动通知（服务启动时调用）
async function sendStartupNotification() {
  const hostname = require('os').hostname();
  const startTime = new Date().toISOString();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
    .container { max-width: 500px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 24px; color: white; }
    .header h2 { margin: 0; font-size: 20px; }
    .content { padding: 24px; color: #333; }
    .footer { background: #f8f9fa; padding: 16px 24px; color: #666; font-size: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>▶️ 服务启动通知</h2>
    </div>
    <div class="content">
      <p>授权追踪系统已启动</p>
      <p><strong>主机:</strong> ${hostname}</p>
      <p><strong>时间:</strong> ${new Date(startTime).toLocaleString('zh-CN')}</p>
      <p style="color:#666;font-size:12px;margin-top:16px">系统正在监控部署域名...</p>
    </div>
    <div class="footer">
      YunjuNET API Gateway
    </div>
  </div>
</body>
</html>`;

  return sendNotification(
    '【授权追踪】服务已启动',
    html,
    { fromName: '代码授权系统' }
  );
}

// 初始化通知系统
async function initNotifier() {
  if (DISABLE_TELEMETRY) {
    console.log('[license-notifier] Telemetry disabled, notifier not initialized');
    return;
  }

  // 延迟发送启动通知（等待 SMTP 配置加载完成）
  setTimeout(async () => {
    await sendStartupNotification();
  }, 10000);

  // 设置每日汇总定时发送
  try {
    const cron = require('node-cron');
    // 每晚 20:00 发送
    cron.schedule('0 20 * * *', async () => {
      console.log('[license-notifier] Running daily summary...');
      const tracker = require('./tracker');
      const summary = await tracker.getTrackingSummary();
      // 获取今天新增的域名
      const trend = await tracker.getDomainTrend(1);
      await sendDailySummary(summary, trend);
      // 标记已通知
      const unnotified = await tracker.getUnnotifiedDomains();
      if (unnotified.length) {
        await tracker.markDomainsNotified(unnotified.map(d => d.id));
      }
    }, {
      scheduled: true,
      timezone: 'Asia/Shanghai'
    });
    console.log('[license-notifier] Daily summary scheduled at 20:00');
  } catch (e) {
    console.log('[license-notifier] Cron scheduler not available');
  }
}

module.exports = {
  sendNotification,
  notifyNewDomain,
  sendDailySummary,
  sendStartupNotification,
  canSendNotification,
  initNotifier,
  DISABLE_TELEMETRY
};
