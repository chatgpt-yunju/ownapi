const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function sendOpenClawGuide() {
  try {
    // 连接数据库获取 SMTP 配置
    const connection = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: '',
      database: 'wechat_cms'
    });

    const [rows] = await connection.query("SELECT `key`, `value` FROM settings WHERE `key` LIKE 'smtp%'");
    const config = {};
    rows.forEach(r => config[r.key] = r.value);
    await connection.end();

    if (!config.smtp_host || !config.smtp_user || !config.smtp_pass) {
      console.error('✗ SMTP 配置不完整，请先在管理后台配置 SMTP 设置');
      process.exit(1);
    }

    // 创建邮件传输器
    const transporter = nodemailer.createTransport({
      host: config.smtp_host || 'smtp.qq.com',
      port: parseInt(config.smtp_port) || 465,
      secure: true,
      auth: {
        user: config.smtp_user,
        pass: config.smtp_pass
      }
    });

    // 读取配置指南
    const guideContent = fs.readFileSync('/home/ubuntu/openclaw-config-guide.md', 'utf-8');

    // 准备 HTML 邮件内容
    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
      line-height: 1.8;
      color: #333;
      max-width: 900px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f7fa;
    }
    .container {
      background: white;
      border-radius: 12px;
      padding: 40px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    }
    h1 {
      color: #1a73e8;
      border-bottom: 3px solid #1a73e8;
      padding-bottom: 15px;
      margin-bottom: 30px;
      font-size: 32px;
    }
    h2 {
      color: #34a853;
      margin-top: 40px;
      margin-bottom: 20px;
      font-size: 24px;
      border-left: 4px solid #34a853;
      padding-left: 15px;
    }
    h3 {
      color: #ea4335;
      margin-top: 30px;
      margin-bottom: 15px;
      font-size: 20px;
    }
    .highlight {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 25px;
      border-radius: 8px;
      margin: 25px 0;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
    }
    .highlight strong {
      font-size: 18px;
      display: block;
      margin-bottom: 10px;
    }
    .info-box {
      background: #e8f5e9;
      border-left: 4px solid #4caf50;
      padding: 20px;
      margin: 20px 0;
      border-radius: 4px;
    }
    .warning-box {
      background: #fff3cd;
      border-left: 4px solid #ffc107;
      padding: 20px;
      margin: 20px 0;
      border-radius: 4px;
    }
    .error-box {
      background: #ffebee;
      border-left: 4px solid #f44336;
      padding: 20px;
      margin: 20px 0;
      border-radius: 4px;
    }
    code {
      background: #f5f5f5;
      padding: 3px 8px;
      border-radius: 4px;
      font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
      font-size: 14px;
      color: #e83e8c;
    }
    pre {
      background: #282c34;
      color: #abb2bf;
      padding: 20px;
      border-radius: 8px;
      overflow-x: auto;
      font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
      font-size: 14px;
      line-height: 1.6;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    }
    pre code {
      background: transparent;
      color: inherit;
      padding: 0;
    }
    .btn {
      display: inline-block;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 12px 30px;
      border-radius: 25px;
      text-decoration: none;
      margin: 10px 5px;
      font-weight: 600;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
      transition: transform 0.2s;
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6);
    }
    .platform-card {
      background: white;
      border: 2px solid #e0e0e0;
      border-radius: 12px;
      padding: 25px;
      margin: 25px 0;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .platform-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.12);
    }
    .platform-icon {
      font-size: 48px;
      margin-bottom: 15px;
    }
    ul, ol {
      padding-left: 25px;
    }
    li {
      margin: 10px 0;
    }
    a {
      color: #1a73e8;
      text-decoration: none;
      font-weight: 500;
    }
    a:hover {
      text-decoration: underline;
    }
    .footer {
      margin-top: 50px;
      padding-top: 30px;
      border-top: 2px solid #e0e0e0;
      text-align: center;
      color: #999;
      font-size: 14px;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      margin-left: 10px;
    }
    .status-success {
      background: #4caf50;
      color: white;
    }
    .status-pending {
      background: #ff9800;
      color: white;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🤖 OpenClaw 配置完整教程</h1>

    <div class="highlight">
      <strong>📧 配置指南已发送</strong><br>
      感谢使用 OpenClaw！本邮件包含完整的配置教程，帮助你快速接入企业微信、飞书和 QQ。
    </div>

    <div class="info-box">
      <strong>✅ 环境准备完成</strong><br>
      • 服务器 IP: <code>43.129.235.9</code><br>
      • Node.js: <code>v22.22.0</code> <span class="status-badge status-success">已安装</span><br>
      • OpenClaw: <code>2026.2.26</code> <span class="status-badge status-success">已安装</span><br>
      • 豆包 API: <span class="status-badge status-success">已配置</span><br>
      • 配置文件: <code>~/.openclaw/openclaw.json</code>
    </div>

    <h2>📱 三大平台配置</h2>

    <div class="platform-card">
      <div class="platform-icon">💼</div>
      <h3>企业微信配置</h3>
      <p><strong>状态:</strong> <span class="status-badge status-pending">待配置</span></p>
      <p><strong>需要准备:</strong></p>
      <ul>
        <li>企业微信管理员权限</li>
        <li>创建自建应用</li>
        <li>配置回调 URL: <code>http://43.129.235.9:18789/wecom</code></li>
        <li>添加可信 IP: <code>43.129.235.9</code></li>
      </ul>
      <a href="https://work.weixin.qq.com/" class="btn">前往企业微信</a>
    </div>

    <div class="platform-card">
      <div class="platform-icon">🕊️</div>
      <h3>飞书配置</h3>
      <p><strong>状态:</strong> <span class="status-badge status-pending">待配置</span></p>
      <p><strong>需要准备:</strong></p>
      <ul>
        <li>飞书企业管理员权限</li>
        <li>创建企业自建应用</li>
        <li>使用 WebSocket 长连接（无需公网 URL）</li>
        <li>配置事件订阅</li>
      </ul>
      <a href="https://open.feishu.cn/app" class="btn">前往飞书开放平台</a>
    </div>

    <div class="platform-card">
      <div class="platform-icon">🐧</div>
      <h3>QQ 配置</h3>
      <p><strong>状态:</strong> <span class="status-badge status-pending">待配置</span></p>
      <p><strong>需要准备:</strong></p>
      <ul>
        <li>QQ 机器人账号</li>
        <li>安装 NapCat（OneBot v11）</li>
        <li>安装 OpenClaw QQ 插件</li>
        <li>配置白名单</li>
      </ul>
      <a href="https://github.com/NapNeko/NapCatQQ" class="btn">查看 NapCat 文档</a>
    </div>

    <h2>🚀 快速开始</h2>

    <div class="warning-box">
      <strong>⚠️ 重要提示</strong><br>
      配置完成后，请按以下顺序操作：<br>
      1. 启动 OpenClaw Gateway: <code>openclaw gateway start</code><br>
      2. 配置各平台的回调/事件订阅<br>
      3. 测试连接并验证功能<br>
      4. 查看日志排查问题: <code>openclaw logs --follow</code>
    </div>

    <h3>常用命令</h3>
    <pre><code># 启动 Gateway
openclaw gateway start

# 查看日志
openclaw logs --follow

# 诊断配置
openclaw doctor

# 查看配置
openclaw config list

# 重启 Gateway
openclaw gateway restart</code></pre>

    <h2>📚 附件说明</h2>
    <p>本邮件附带完整的 Markdown 格式配置指南：</p>
    <ul>
      <li><strong>openclaw-config-guide.md</strong> - 完整配置教程（包含所有平台的详细步骤）</li>
    </ul>

    <h2>🔗 参考资源</h2>
    <ul>
      <li><a href="https://docs.openclaw.ai/">OpenClaw 官方文档</a></li>
      <li><a href="https://github.com/openclaw/openclaw">OpenClaw GitHub</a></li>
      <li><a href="https://help.aliyun.com/zh/simple-application-server/use-cases/openclaw-enterprise-wechat-integration">企业微信集成指南</a></li>
      <li><a href="https://github.com/AlexAnys/openclaw-feishu">飞书插件文档</a></li>
      <li><a href="https://github.com/CreatorAris/openclaw-qq-plugin">QQ 插件文档</a></li>
    </ul>

    <div class="error-box">
      <strong>🆘 需要帮助？</strong><br>
      如遇到问题，请查看：<br>
      • 详细日志: <code>openclaw logs --follow</code><br>
      • 配置诊断: <code>openclaw doctor</code><br>
      • 联系邮箱: <a href="mailto:cyjlnk@foxmail.com">cyjlnk@foxmail.com</a>
    </div>

    <div class="footer">
      <p>此邮件由 AI短视频管理系统 自动发送</p>
      <p>发送时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>
      <p>OpenClaw 版本: 2026.2.26 | 服务器 IP: 43.129.235.9</p>
    </div>
  </div>
</body>
</html>
    `;

    // 发送邮件
    const info = await transporter.sendMail({
      from: `"OpenClaw 配置助手" <${config.smtp_user}>`,
      to: '2743319061@qq.com',
      subject: '🤖 OpenClaw 配置完整教程 - 企业微信/飞书/QQ 接入指南',
      html: htmlContent,
      attachments: [
        {
          filename: 'openclaw-config-guide.md',
          path: '/home/ubuntu/openclaw-config-guide.md'
        }
      ]
    });

    console.log('✓ 邮件发送成功！');
    console.log('  收件人: 2743319061@qq.com');
    console.log('  主题: OpenClaw 配置完整教程');
    console.log('  Message ID:', info.messageId);
    console.log('  附件: openclaw-config-guide.md');
    console.log('\n📧 请检查你的邮箱（包括垃圾邮件文件夹）');

  } catch (err) {
    console.error('✗ 邮件发送失败:', err.message);
    if (err.code === 'EAUTH') {
      console.error('\n提示: SMTP 认证失败，请检查邮箱配置');
    } else if (err.code === 'ECONNECTION') {
      console.error('\n提示: 无法连接到 SMTP 服务器，请检查网络');
    }
    process.exit(1);
  }
}

sendOpenClawGuide();
