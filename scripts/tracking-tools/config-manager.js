/**
 * 配置管理器 - 支持管理员面板设置
 * 所有变量可通过 Web 界面配置
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = './system-config.json';

// 默认配置
const DEFAULT_CONFIG = {
    // Webhook 配置
    webhook: {
        url: 'http://localhost:3003/track',
        enabled: true
    },

    // 项目列表
    projects: [
        { id: 'shop_vip', name: '商城VIP版', path: '../../test-projects/project-a/src' },
        { id: 'admin_pro', name: '后台专业版', path: '../../test-projects/project-b/js' },
    ],

    // 推送配置
    alerts: {
        wechat: {
            enabled: false,
            key: '',
            name: '企业微信'
        },
        dingtalk: {
            enabled: false,
            token: '',
            name: '钉钉'
        },
        bark: {
            enabled: false,
            key: '',
            name: 'Bark'
        },
        serverchan: {
            enabled: false,
            key: '',
            name: 'Server酱'
        }
    },

    // 通知模板
    templates: {
        title: '【部署告警】',
        body: '项目：{project}\n域名：{host}\n时间：{time}'
    },

    // 高级设置
    advanced: {
        delayMs: 5 * 60 * 1000,  // 上报延迟
        heartbeatInterval: 4,      // 心跳间隔（小时）
        dnsTrack: true,           // DNS追踪
        fingerprint: true         // 响应头指纹
    },

    // 系统设置
    system: {
        port: 3003,
        dataFile: './deploys.json',
        logLevel: 'info',
        autoStart: true
    }
};

class ConfigManager {
    constructor() {
        this.config = this.load();
    }

    load() {
        try {
            if (fs.existsSync(CONFIG_FILE)) {
                const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
                return this.merge(DEFAULT_CONFIG, saved);
            }
        } catch (e) {
            console.error('[Config] 加载失败:', e.message);
        }
        return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }

    save() {
        try {
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf8');
            return true;
        } catch (e) {
            console.error('[Config] 保存失败:', e.message);
            return false;
        }
    }

    merge(defaultConfig, savedConfig) {
        const result = JSON.parse(JSON.stringify(defaultConfig));
        for (const key in savedConfig) {
            if (typeof savedConfig[key] === 'object' && !Array.isArray(savedConfig[key])) {
                result[key] = this.merge(result[key] || {}, savedConfig[key]);
            } else {
                result[key] = savedConfig[key];
            }
        }
        return result;
    }

    get(path) {
        const keys = path.split('.');
        let value = this.config;
        for (const key of keys) {
            if (value === undefined) return undefined;
            value = value[key];
        }
        return value;
    }

    set(path, value) {
        const keys = path.split('.');
        let target = this.config;
        for (let i = 0; i < keys.length - 1; i++) {
            if (target[keys[i]] === undefined) {
                target[keys[i]] = {};
            }
            target = target[keys[i]];
        }
        target[keys[keys.length - 1]] = value;
        return this.save();
    }

    getAll() {
        return this.config;
    }

    updateAll(newConfig) {
        this.config = this.merge(this.config, newConfig);
        return this.save();
    }

    reset() {
        this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        return this.save();
    }

    // 获取配置页面HTML
    getConfigPage() {
        const config = this.getAll();

        return `<!DOCTYPE html>
<html lang="zh">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>系统配置面板</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f5f5;
            padding: 20px;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 24px;
            border-radius: 8px;
            margin-bottom: 24px;
        }
        .header h1 { font-size: 24px; }
        .header p { opacity: 0.9; margin-top: 8px; }

        .nav {
            display: flex; gap: 8px;
            background: white; padding: 8px;
            border-radius: 8px;
            margin-bottom: 24px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .nav-btn {
            padding: 8px 16px; border: none; border-radius: 4px;
            background: transparent; cursor: pointer;
            font-size: 14px;
        }
        .nav-btn:hover { background: #f5f5f5; }
        .nav-btn.active { background: #667eea; color: white; }

        .tab-content { display: none; }
        .tab-content.active { display: block; }

        .card {
            background: white; border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            margin-bottom: 20px; overflow: hidden;
        }
        .card-header {
            padding: 16px 20px;
            border-bottom: 1px solid #eee;
            background: #f8f9fa;
        }
        .card-header h2 { font-size: 16px; color: #333; }
        .card-body { padding: 20px; }

        .form-group {
            margin-bottom: 16px;
        }
        .form-group label {
            display: block;
            font-size: 14px;
            color: #333;
            margin-bottom: 6px;
        }
        .form-group input[type="text"],
        .form-group input[type="number"],
        .form-group input[type="password"],
        .form-group textarea,
        .form-group select {
            width: 100%; padding: 8px 12px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 14px;
        }
        .form-group input:focus {
            border-color: #667eea;
            outline: none;
        }
        .form-group small {
            display: block;
            margin-top: 4px;
            color: #666;
            font-size: 12px;
        }
        .form-group .checkbox {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .form-group .checkbox input {
            width: auto;
        }

        .btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .btn-primary { background: #667eea; color: white; }
        .btn-primary:hover { background: #5568d3; }
        .btn-danger { background: #ff4d4f; color: white; }
        .btn-secondary { background: #f5f5f5; color: #333; }

        .project-item {
            display: grid;
            grid-template-columns: 150px 1fr 100px;
            gap: 12px;
            align-items: center;
            padding: 12px;
            border: 1px solid #eee;
            border-radius: 4px;
            margin-bottom: 8px;
        }
        .project-item input {
            padding: 6px 10px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 14px;
        }
        .alert-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 16px;
            border-bottom: 1px solid #eee;
        }
        .alert-item:last-child { border-bottom: none; }
        .alert-item .info h3 { font-size: 15px; color: #333; }
        .alert-item .info p { font-size: 13px; color: #666; margin-top: 4px; }

        .toast {
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            background: #52c41a;
            color: white;
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
            display: none;
        }
        .toast.show { display: block; }

        @media (max-width: 768px) {
            .project-item {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>⚙️ 系统配置面板</h1>
            <p>管理所有变量和设置</p>
        </div>

        <div class="nav">
            <button class="nav-btn active" onclick="showTab('general')">常规设置</button>
            <button class="nav-btn" onclick="showTab('projects')">项目管理</button>
            <button class="nav-btn" onclick="showTab('alerts')">推送配置</button>
            <button class="nav-btn" onclick="showTab('advanced')">高级设置</button>
            <button class="nav-btn" onclick="showTab('preview')">配置预览</button>
        </div>

        <form id="configForm">
            <!-- 常规设置 -->
            <div id="general" class="tab-content active">
                <div class="card">
                    <div class="card-header">
                        <h2>Webhook 配置</h2>
                    </div>
                    <div class="card-body">
                        <div class="form-group">
                            <label>接收地址</label>
                            <input type="text" name="webhook.url" value="${config.webhook.url}">
                            <small>埋点代码上报的地址</small>
                        </div>
                        <div class="form-group checkbox">
                            <input type="checkbox" name="webhook.enabled" ${config.webhook.enabled ? 'checked' : ''}>
                            <label>启用 Webhook 接收</label>
                        </div>
                    </div>
                </div>

                <div class="card">
                    <div class="card-header">
                        <h2>通知模板</h2>
                    </div>
                    <div class="card-body">
                        <div class="form-group">
                            <label>标题模板</label>
                            <input type="text" name="templates.title" value="${config.templates.title}">
                        </div>
                        <div class="form-group">
                            <label>正文体</label>
                            <textarea name="templates.body" rows="4">${config.templates.body}</textarea>
                            <small>可用变量: {project}, {host}, {ip}, {time}, {ua}</small>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 项目管理 -->
            <div id="projects" class="tab-content">
                <div class="card">
                    <div class="card-header">
                        <h2>项目列表</h2>
                    </div>
                    <div class="card-body">
                        <div id="projectsList">
                            ${config.projects.map((p, i) => `
                            <div class="project-item">
                                <input type="text" name="projects[${i}].id" value="${p.id}" placeholder="项目ID">
                                <input type="text" name="projects[${i}].path" value="${p.path}" placeholder="路径">
                                <button type="button" class="btn btn-danger" onclick="removeProject(this)">删除</button>
                            </div>
                            `).join('')}
                        </div>
                        <button type="button" class="btn btn-secondary" onclick="addProject()">+ 添加项目</button>
                    </div>
                </div>
            </div>

            <!-- 推送配置 -->
            <div id="alerts" class="tab-content">
                <div class="card">
                    <div class="card-header">
                        <h2>推送渠道</h2>
                    </div>
                    <div class="card-body">
                        ${Object.entries(config.alerts).map(([key, alert]) => `
                        <div class="alert-item">
                            <div class="info">
                                <h3>${alert.name}</h3>
                                <p>状态: ${alert.enabled ? '已启用' : '未启用'}</p>
                            </div>
                            <div class="form-group checkbox" style="margin:0">
                                <label>启用</label>
                                <input type="checkbox" name="alerts.${key}.enabled" ${alert.enabled ? 'checked' : ''}>
                            </div>
                        </div>
                        <div class="form-group" style="margin-left: 16px; ${alert.enabled ? '' : 'display:none;'}">
                            <label>${alert.name} Key/Token</label>
                            <input type="password" name="alerts.${key}.${key === 'dingtalk' ? 'token' : 'key'}" value="${alert.key || alert.token || ''}" placeholder="输入 Key">
                        </div>
                        `).join('')}
                    </div>
                </div>
            </div>

            <!-- 高级设置 -->
            <div id="advanced" class="tab-content">
                <div class="card">
                    <div class="card-header">
                        <h2>高级设置</h2>
                    </div>
                    <div class="card-body">
                        <div class="form-group">
                            <label>上报延迟（毫秒）</label>
                            <input type="number" name="advanced.delayMs" value="${config.advanced.delayMs}">
                            <small>默认5分钟（300000毫秒），降低被立即发现的概率</small>
                        </div>
                        <div class="form-group">
                            <label>心跳间隔（小时）</label>
                            <input type="number" name="advanced.heartbeatInterval" value="${config.advanced.heartbeatInterval}">
                            <small>每N小时上报一次存活状态</small>
                        </div>
                        <div class="form-group checkbox">
                            <input type="checkbox" name="advanced.dnsTrack" ${config.advanced.dnsTrack ? 'checked' : ''}>
                            <label>启用 DNS 追踪（无法被屏蔽）</label>
                        </div>
                        <div class="form-group checkbox">
                            <input type="checkbox" name="advanced.fingerprint" ${config.advanced.fingerprint ? 'checked' : ''}>
                            <label>启用响应头指纹</label>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 配置预览 -->
            <div id="preview" class="tab-content">
                <div class="card">
                    <div class="card-header">
                        <h2>当前配置（JSON）</h2>
                    </div>
                    <div class="card-body">
                        <pre style="background:#f5f5f5;padding:16px;border-radius:4px;overflow:auto;max-height:500px;font-size:13px;">${JSON.stringify(config, null, 2)}</pre>
                    </div>
                </div>
            </div>

            <div style="display:flex;gap:12px;justify-content:flex-end;">
                <button type="button" class="btn btn-secondary" onclick="resetConfig()">重置为默认</button>
                <button type="submit" class="btn btn-primary">保存配置</button>
            </div>
        </form>
    </div>

    <div id="toast" class="toast">保存成功！</div>

    <script>
        function showTab(tabId) {
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            document.getElementById(tabId).classList.add('active');
            event.target.classList.add('active');
        }

        document.getElementById('configForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            const config = {};

            formData.forEach((value, key) => {
                const keys = key.split(/\[?\]?\.?/).filter(Boolean);
                let target = config;
                for (let i = 0; i < keys.length - 1; i++) {
                    if (!target[keys[i]]) target[keys[i]] = {};
                    target = target[keys[i]];
                }
                target[keys[keys.length - 1]] = value;
            });

            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            if (res.ok) {
                const toast = document.getElementById('toast');
                toast.classList.add('show');
                setTimeout(() => toast.classList.remove('show'), 2000);
            }
        });

        function addProject() {
            const list = document.getElementById('projectsList');
            const index = list.children.length;
            list.innerHTML += \`
                <div class="project-item">
                    <input type="text" name="project[\${index}].id" placeholder="项目ID">
                    <input type="text" name="project[\${index}].path" placeholder="路径">
                    <button type="button" class="btn btn-danger" onclick="removeProject(this)">删除</button>
                </div>
            \`;
        }

        function removeProject(btn) {
            btn.parentElement.remove();
        }

        function resetConfig() {
            if (confirm('确定要重置为默认配置吗？')) {
                fetch('/api/config/reset', { method: 'POST' })
                    .then(() => location.reload());
            }
        }
    </script>
</body>
</html>`;
    }
}

module.exports = new ConfigManager();
