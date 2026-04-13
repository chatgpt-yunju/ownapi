#!/bin/bash
# 追踪服务器部署脚本
# 用法: ./deploy-track-server.sh

set -e

echo "=== 部署 License 追踪服务器 ==="

# 配置TRACK_PORT=${TRACK_PORT:-3001}
TRACK_DOMAIN=${TRACK_DOMAIN:-"track.yunjunet.cn"}  # 修改为你的域名
ADMIN_EMAIL=${ADMIN_EMAIL:-"2743319061@qq.com"}      # 修改为你的邮箱

# 创建工作目录
mkdir -p ~/license-tracker
cd ~/license-tracker

# 创建追踪服务器代码
cat > server.js << 'EOF'
const express = require('express');
const fs = require('fs').promises;
const nodemailer = require('nodemailer');
const app = express();

const CONFIG = {
  PORT: process.env.TRACK_PORT || 3001,
  DATA_FILE: './deploys.json',
  EMAIL: process.env.ADMIN_EMAIL || '2743319061@qq.com',
  ENCRYPT_KEY: 'YunjuNET2024'  // 必须与代码中一致
};

// 存储
deploys = new Map();

// 加载旧数据
async function loadData() {
  try {
    const data = await fs.readFile(CONFIG.DATA_FILE, 'utf8');
    const parsed = JSON.parse(data);
    Object.entries(parsed).forEach(([k, v]) => deploys.set(k, v));
    console.log(`[Track] Loaded ${deploys.size} existing deploys`);
  } catch {
    console.log('[Track] Starting fresh');
  }
}

// 保存数据
async function saveData() {
  const obj = Object.fromEntries(deploys);
  await fs.writeFile(CONFIG.DATA_FILE, JSON.stringify(obj, null, 2));
}

// 解密
function decrypt(encrypted) {
  try {
    const normalized = encrypted.replace(/-/g, '+').replace(/_/g, '/');
    const text = Buffer.from(normalized, 'base64').toString('utf8');
    let result = '';
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i) ^ CONFIG.ENCRYPT_KEY.charCodeAt(i % CONFIG.ENCRYPT_KEY.length);
      result += String.fromCharCode(charCode);
    }
    return JSON.parse(result);
  } catch (e) {
    return null;
  }
}

// 发送邮件通知
async function sendEmail(subject, html) {
  // 这里需要你配置SMTP
  console.log(`[Email] Would send: ${subject}`);
  console.log(`[Email] To: ${CONFIG.EMAIL}`);
  // TODO: 配置SMTP后取消注释
}

app.use(express.json());

// 接收部署上报
app.post('/api/v1/deploy', async (req, res) => {
  const { payload, v } = req.body;

  if (!payload) {
    return res.status(400).json({ error: 'Missing payload' });
  }

  const info = decrypt(payload);
  if (!info) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const id = info.installId || 'unknown';
  const isNew = !deploys.has(id);

  // 保存/更新
  deploys.set(id, {
    ...info,
    firstSeen: deploys.get(id)?.firstSeen || new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    reportCount: (deploys.get(id)?.reportCount || 0) + 1,
    version: v
  });

  await saveData();

  // 新部署通知
  if (isNew && !info.test) {
    console.log(`[Track] 🎉 New deploy: ${info.domain} (${info.publicIP})`);
    await sendEmail(
      `【授权追踪】新部署: ${info.domain}`,
      `<h2>新部署检测</h2>
      <p><b>域名:</b> ${info.domain}</p>
      <p><b>IP:</b> ${info.publicIP}</p>
      <p><b>平台:</b> ${info.platform}</p>
      <p><b>时间:</b> ${new Date().toLocaleString()}</p>`
    );
  } else {
    console.log(`[Track] Update: ${info.domain}`);
  }

  res.json({ ok: true, isNew });
});

// 心跳
app.get('/api/v1/deploy/ping', async (req, res) => {
  const { id } = req.query;
  if (id && deploys.has(id)) {
    const data = deploys.get(id);
    data.lastSeen = new Date().toISOString();
    data.heartbeatCount = (data.heartbeatCount || 0) + 1;
    await saveData();
  }
  res.json({ ok: true });
});

// 管理面板
app.get('/admin', (req, res) => {
  const list = Array.from(deploys.entries()).map(([id, data]) => ({
    id,
    ...data
  })).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

  res.json({
    total: list.length,
    active24h: list.filter(d => {
      const lastSeen = new Date(d.lastSeen);
      return Date.now() - lastSeen < 24 * 60 * 60 * 1000;
    }).length,
    deploys: list
  });
});

// 启动
loadData().then(() => {
  app.listen(CONFIG.PORT, () => {
    console.log(`[Track] Server running on port ${CONFIG.PORT}`);
    console.log(`[Track] Admin: http://localhost:${CONFIG.PORT}/admin`);
  });
});
EOF

# 创建 package.json
cat > package.json << 'EOF'
{
  "name": "license-tracker-server",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "nodemailer": "^6.9.0"
  }
}
EOF

# 安装依赖
npm install

# 创建启动脚本
cat > start.sh << EOF
#!/bin/bash
export TRACK_PORT=${TRACK_PORT}
export ADMIN_EMAIL=${ADMIN_EMAIL}
nohup node server.js > tracker.log 2>&1 &
echo "Tracker started on port ${TRACK_PORT}"
EOF
chmod +x start.sh

echo ""
echo "=== 部署完成 ==="
echo ""
echo "启动命令: cd ~/license-tracker && ./start.sh"
echo "查看日志: tail -f ~/license-tracker/tracker.log"
echo "管理面板: curl http://localhost:${TRACK_PORT}/admin"
echo ""
echo "下一步: 配置Nginx反向代理到 ${TRACK_DOMAIN}"
