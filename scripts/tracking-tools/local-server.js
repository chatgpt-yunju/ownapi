/**
 * 本地追踪服务器 - 完全免费替代 webhook.site
 *
 * 功能：
 * 1. 接收前端埋点上报
 * 2. 保存数据到本地文件
 * 3. 提供管理面板查看部署
 * 4. 支持推送到 DingTalk/WeChat
 *
 * 使用方法：
 * node local-server.js
 *
 * 访问：
 * - http://localhost:3003/track  (接收上报)
 * - http://localhost:3003/admin  (管理面板)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3003;
const DATA_FILE = './deploys.json';

// 内存存储
let deploys = [];

// HTML模板
const HTML_HEADER = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <title>部署追踪面板</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f0f2f5; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 24px; border-radius: 8px; margin-bottom: 20px; }
    .header h1 { margin: 0; font-size: 24px; }
    .header p { opacity: 0.9; margin-top: 8px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin-bottom: 20px; }
    .stat-card { background: white; padding: 20px; border-radius: 8px; text-align: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .stat-value { font-size: 32px; font-weight: bold; color: #667eea; }
    .stat-label { color: #666; margin-top: 4px; }
    table { width: 100%; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); border-collapse: collapse; }
    th { background: #f8f9fa; padding: 12px; text-align: left; font-weight: 600; color: #333; }
    td { padding: 12px; border-bottom: 1px solid #eee; }
    tr:hover { background: #f8f9fa; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 4px; font-size: 12px; font-weight: 500; }
    .badge-new { background: #e8f5e9; color: #2e7d32; }
    .badge-active { background: #e3f2fd; color: #1565c0; }
    .badge-old { background: #f5f5f5; color: #999; }
    .code { font-family: monospace; background: #f5f5f5; padding: 2px 6px; border-radius: 4px; }
    .empty { text-align: center; padding: 60px; color: #666; }
    .endpoint { background: white; padding: 16px; border-radius: 8px; margin-bottom: 20px; }
    .endpoint code { background: #f5f5f5; padding: 4px 8px; border-radius: 4px; font-family: monospace; }
    .btn { display: inline-block; padding: 8px 16px; background: #667eea; color: white; text-decoration: none; border-radius: 4px; cursor: pointer; }
    .btn:hover { background: #5568d3; }
  </style>
</head>
<body>
  <div class="header">
    <h1>📡 部署追踪面板</h1>
    <p>实时监控代码部署情况 - 完全免费替代 webhook.site</p>
  </div>`;

const HTML_FOOTER = `</body>
</html>`;

// 加载已有数据
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      deploys = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      console.log(`[Track] 加载了 ${deploys.length} 条历史数据`);
    }
  } catch (e) {
    console.log('[Track] 从头开始');
  }
}

// 保存数据
function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(deploys, null, 2));
  } catch (e) {
    console.error('[Track] 保存失败:', e.message);
  }
}

// 生成管理面板
function generateAdminPage() {
  const now = new Date();
  const active24h = deploys.filter(d => {
    const time = new Date(d.ts);
    return (now - time) < 24 * 60 * 60 * 1000;
  });

  const active7d = deploys.filter(d => {
    const time = new Date(d.ts);
    return (now - time) < 7 * 24 * 60 * 60 * 1000;
  });

  const rows = deploys.map(d => {
    const time = new Date(d.ts);
    const age = now - time;
    let badgeClass = 'badge-old';
    let badgeText = '旧部署';
    if (age < 24 * 60 * 60 * 1000) {
      badgeClass = 'badge-new';
      badgeText = '今日';
    } else if (age < 7 * 24 * 60 * 60 * 1000) {
      badgeClass = 'badge-active';
      badgeText = '本周';
    }

    return `<tr>
      <td><span class="code">${d.p || 'unknown'}</span></td>
      <td>${d.h || 'localhost'}</td>
      <td class="code">${d.ip || '-'}</td>
      <td>${time.toLocaleString('zh-CN')}</td>
      <td class="code">${(d.ua || 'Mozilla').substring(0, 50)}...</td>
      <td><span class="badge ${badgeClass}">${badgeText}</span></td>
    </tr>`;
  }).join('');

  const tableContent = deploys.length > 0 ?
    `<table>
      <thead>
        <tr>
          <th>项目</th>
          <th>域名</th>
          <th>IP</th>
          <th>时间</th>
          <th>用户代理</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>` :
    `<div class="empty">
      <h3>暂无数据</h3>
      <p style="margin-top: 12px; color: #666;">
        等待接收部署上报...<br>
        请确保埋点代码已正确配置并部署。
      </p>
    </div>`;

  return `${HTML_HEADER}
    <div class="endpoint">
      <strong>接收端点地址：</strong>
      <code>http://localhost:${PORT}/track</code>
      <br>
      <span style="color: #666; font-size: 14px;">
        修改 browser-beacon.js 中的 WEBHOOK_URL 为以上地址
      </span>
    </div>
    <div class="stats">
      <div class="stat-card">
        <div class="stat-value">${deploys.length}</div>
        <div class="stat-label">总部署数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${active24h.length}</div>
        <div class="stat-label">24小时内</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${active7d.length}</div>
        <div class="stat-label">7天内</div>
      </div>
    </div>
    ${tableContent}
  ${HTML_FOOTER}`;
}

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // 跨域支持
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 处理 OPTIONS 预检请求
  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  // 管理面板
  if (pathname === '/admin') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(generateAdminPage());
    return;
  }

  // 接口 JSON
  if (pathname === '/api/deploys') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(deploys, null, 2));
    return;
  }

  // 接收上报
  if (pathname === '/track') {
    const { query } = parsedUrl;

    // 构建部署记录
    const deploy = {
      p: query.p || 'unknown',
      h: query.h || 'localhost',
      href: query.href || '-',
      ip: req.connection.remoteAddress?.replace('::ffff:', ''),
      ua: query.ua || req.headers['user-agent'] || 'unknown',
      ref: query.ref || '-',
      ts: query.ts || new Date().toISOString(),
      tz: query.tz || '-',
      sw: query.sw || '-',
      sh: query.sh || '-',
      lang: query.lang || '-',
      reportedAt: new Date().toISOString()
    };

    // 检查是否重复（5分钟内相同项目+域名）
    const isDuplicate = deploys.some(d => {
      const timeDiff = new Date() - new Date(d.ts);
      return d.p === deploy.p && d.h === deploy.h && timeDiff < 5 * 60 * 1000;
    });

    if (!isDuplicate) {
      deploys.unshift(deploy);
      saveData();

      console.log('\n🎉 ============= NEW DEPLOY =============');
      console.log(`项目: ${deploy.p}`);
      console.log(`域名: ${deploy.h}`);
      console.log(`IP: ${deploy.ip || 'localhost'}`);
      console.log(`时间: ${new Date(deploy.ts).toLocaleString('zh-CN')}`);
      console.log('=========================================\n');
    }

    // 返回透明 1x1 像素 GIF
    res.setHeader('Content-Type', 'image/gif');
    res.end(Buffer.from('R0lGODlhAQABAJAAAP8AAAAAACH5BAUQAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'));
    return;
  }

  // 首页重定向到管理面板
  if (pathname === '/') {
    res.statusCode = 302;
    res.setHeader('Location', '/admin');
    res.end();
    return;
  }

  // 404
  res.statusCode = 404;
  res.end('Not Found');
});

// 启动服务器
loadData();

server.listen(PORT, () => {
  console.log('\n✅ 本地追踪服务器已启动');
  console.log('\n访问地址：');
  console.log(`  管理面板: http://localhost:${PORT}/admin`);
  console.log(`  接收端点: http://localhost:${PORT}/track`);
  console.log(`\n使用说明：`);
  console.log(`  1. 打开管理面板查看部署列表`);
  console.log(`  2. 修改 browser-beacon.js 中的 WEBHOOK_URL 为:`);
  console.log(`     http://localhost:${PORT}/track`);
  console.log(`  3. 部署项目，5分钟后刷新管理面板\n`);
  console.log('按 Ctrl+C 停止服务\n');
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n\n保存数据并退出...');
  saveData();
  server.close(() => {
    process.exit(0);
  });
});
