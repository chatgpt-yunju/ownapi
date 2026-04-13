/**
 * 增强版追踪服务器 - 带管理员配置面板
 * 所有变量可通过 Web 界面配置
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const configManager = require('./config-manager');

const DATA_FILE = configManager.get('system.dataFile') || './deploys.json';

let deploys = [];

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

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(deploys, null, 2));
    } catch (e) {
        console.error('[Track] 保存失败:', e.message);
    }
}

const CSS = `
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f5; padding: 20px; }
    .container { max-width: 1400px; margin: 0 auto; }
    .nav { display: flex; gap: 20px; margin-bottom: 20px; background: white; padding: 16px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .nav a { color: #667eea; text-decoration: none; padding: 8px 16px; border-radius: 4px; }
    .nav a:hover { background: #f5f5f5; }
    .nav a.active { background: #667eea; color: white; }
</style>
`;

const app = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
    }

    const pathname = parsedUrl.pathname;

    // 配置面板
    if (pathname === '/admin/config') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(configManager.getConfigPage());
        return;
    }

    // 配置 API - 获取
    if (pathname === '/api/config' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(configManager.getAll()));
        return;
    }

    // 配置 API - 保存
    if (pathname === '/api/config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const newConfig = JSON.parse(body);
                configManager.updateAll(newConfig);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: true }));

                // 同时更新 batch-inserter.py 中的项目列表
                updateBatchInserterProjects(newConfig.projects);
            } catch (e) {
                res.statusCode = 400;
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // 配置 API - 重置
    if (pathname === '/api/config/reset' && req.method === 'POST') {
        configManager.reset();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // 接收上报
    if (pathname === '/track') {
        const data = parsedUrl.query;
        const deploy = {
            p: data.p || 'unknown',
            h: data.h || 'localhost',
            href: data.href || '-',
            ip: req.connection.remoteAddress?.replace('::ffff:', ''),
            ua: data.ua || req.headers['user-agent'] || 'unknown',
            ref: data.ref || '-',
            ts: data.ts || new Date().toISOString(),
            reportedAt: new Date().toISOString()
        };

        // 保存并转发
        deploys.unshift(deploy);
        saveData();

        console.log('\n🎉 新部署:', deploy.p, deploy.h);

        // 转发到配置的推送渠道
        forwardAlert(deploy);

        res.setHeader('Content-Type', 'image/gif');
        res.end(Buffer.from('R0lGODlhAQABAJAAAP8AAAAAACH5BAUQAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'));
        return;
    }

    // 管理面板
    if (pathname === '/admin') {
        res.statusCode = 302;
        res.setHeader('Location', '/admin/config');
        res.end();
        return;
    }

    // 首页
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>追踪系统</title>
    ${CSS}
</head>
<body>
    <div class="container">
        <div class="nav">
            <a href="/admin/config" class="active">配置面板</a>
            <a href="/admin/deploys">部署列表</a>
            <a href="/api/config" target="_blank">API</a>
        </div>
        <h1>欢迎使用部署追踪系统</h1>
        <p>所有设置都可以通过 <a href="/admin/config">配置面板</a> 管理</p>
    </div>
</body>
</html>`);
});

// 更新 batch-inserter.py 中的项目列表
function updateBatchInserterProjects(projects) {
    const batchPath = path.join(__dirname, 'batch-inserter.py');
    if (!fs.existsSync(batchPath)) return;

    let content = fs.readFileSync(batchPath, 'utf8');

    // 生成项目列表代码
    const projectsCode = projects.map(p =>
        `    ('${p.path.replace(/\\/g, '/')}', '${p.id}'),`;
    ).join('\n');

    // 替换 PROJECTS 部分
    content = content.replace(
        /PROJECTS = \[([\s\S]*?)\]/,
        `PROJECTS = [\n${projectsCode}\n]`
    );

    fs.writeFileSync(batchPath, content);
    console.log('[Config] 已同步更新 batch-inserter.py');
}

// 转发告警
async function forwardAlert(deploy) {
    const alerts = configManager.get('alerts');

    // 企业微信
    if (alerts.wechat.enabled && alerts.wechat.key) {
        try {
            const https = require('https');
            const data = JSON.stringify({
                msgtype: 'text',
                text: {
                    content: `【部署告警】\n项目：${deploy.p}\n域名：${deploy.h}\n时间：${new Date(deploy.ts).toLocaleString('zh-CN')}`
                }
            });

            const req = https.request({
                hostname: 'qyapi.weixin.qq.com',
                path: `/cgi-bin/webhook/send?key=${alerts.wechat.key}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            req.write(data);
            req.end();
        } catch (e) {
            console.error('[Alert] 企业微信推送失败:', e.message);
        }
    }

    // Bark 推送
    if (alerts.bark.enabled && alerts.bark.key) {
        try {
            const https = require('https');
            const title = encodeURIComponent(`${deploy.p} 被部署`);
            const body = encodeURIComponent(`域名：${deploy.h}`);
            https.get(`https://api.day.app/${alerts.bark.key}/${title}/${body}`);
        } catch (e) {
            console.error('[Alert] Bark推送失败:', e.message);
        }
    }

    // DingTalk
    if (alerts.dingtalk.enabled && alerts.dingtalk.token) {
        // DingTalk 推送实现...
    }
}

// 启动
loadData();
const port = configManager.get('system.port') || 3003;

app.listen(port, () => {
    console.log('\n✅ 追踪服务器已启动（带配置面板）');
    console.log('\n访问地址：');
    console.log(`  配置面板: http://localhost:${port}/admin/config`);
    console.log(`  部署列表: http://localhost:${port}/admin/deploys`);
    console.log(`  API地址:  http://localhost:${port}/api/config\n`);
    console.log('按 Ctrl+C 停止服务\n');
});
