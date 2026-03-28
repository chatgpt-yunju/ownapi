const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// 读取 SMTP 配置
const mysql = require('mysql2/promise');

async function sendEmail() {
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

  // 读取申请指南内容
  const guideContent = fs.readFileSync(path.join(__dirname, '../apply-api-keys.md'), 'utf-8');

  // 准备邮件内容（HTML格式）
  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { color: #1a73e8; border-bottom: 3px solid #1a73e8; padding-bottom: 10px; }
    h2 { color: #34a853; margin-top: 30px; }
    h3 { color: #ea4335; }
    a { color: #1a73e8; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-family: monospace; }
    pre { background: #f5f5f5; padding: 15px; border-radius: 5px; overflow-x: auto; }
    .highlight { background: #fff3cd; padding: 15px; border-left: 4px solid #ffc107; margin: 20px 0; }
    table { border-collapse: collapse; width: 100%; margin: 20px 0; }
    th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
    th { background: #1a73e8; color: white; }
    tr:nth-child(even) { background: #f9f9f9; }
    .vendor-card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin: 20px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .btn { display: inline-block; background: #1a73e8; color: white; padding: 10px 20px; border-radius: 5px; text-decoration: none; margin: 10px 5px; }
    .btn:hover { background: #1557b0; }
  </style>
</head>
<body>
  <h1>🎬 AI视频模型密钥申请指南</h1>

  <div class="highlight">
    <strong>📧 系统自动发送</strong><br>
    这是您请求的AI视频模型厂商密钥申请指南。请按照以下步骤申请各厂商的API密钥。
  </div>

  <h2>📊 厂商对比</h2>
  <table>
    <tr>
      <th>厂商</th>
      <th>难度</th>
      <th>时间</th>
      <th>免费额度</th>
      <th>推荐指数</th>
    </tr>
    <tr>
      <td>智谱AI</td>
      <td>⭐ 简单</td>
      <td>5分钟</td>
      <td>✅ 有</td>
      <td>⭐⭐⭐⭐⭐</td>
    </tr>
    <tr>
      <td>阿里通义</td>
      <td>⭐⭐ 中等</td>
      <td>10分钟</td>
      <td>✅ 有</td>
      <td>⭐⭐⭐⭐</td>
    </tr>
    <tr>
      <td>豆包</td>
      <td>⭐⭐ 中等</td>
      <td>10分钟</td>
      <td>❌ 按量付费</td>
      <td>⭐⭐⭐⭐</td>
    </tr>
    <tr>
      <td>快手可灵</td>
      <td>⭐⭐⭐ 较难</td>
      <td>1-3天</td>
      <td>❌ 按量付费</td>
      <td>⭐⭐⭐</td>
    </tr>
    <tr>
      <td>腾讯混元</td>
      <td>⭐⭐⭐ 较难</td>
      <td>15分钟</td>
      <td>❌ 按量付费</td>
      <td>⭐⭐⭐</td>
    </tr>
  </table>

  <h2>🚀 推荐申请顺序</h2>
  <ol>
    <li><strong>智谱AI</strong> - 最简单，立即可用，有免费额度</li>
    <li><strong>阿里通义</strong> - 阿里云账号通用，有试用额度</li>
    <li><strong>腾讯混元</strong> - 如需腾讯生态</li>
    <li><strong>快手可灵</strong> - 需要认证，时间较长</li>
  </ol>

  <div class="vendor-card">
    <h3>1. 智谱AI（推荐优先申请）⭐</h3>
    <p><strong>申请地址</strong>: <a href="https://open.bigmodel.cn/" target="_blank">https://open.bigmodel.cn/</a></p>
    <p><strong>直达链接</strong>: <a href="https://open.bigmodel.cn/usercenter/apikeys" target="_blank">https://open.bigmodel.cn/usercenter/apikeys</a></p>
    <p><strong>优势</strong>:</p>
    <ul>
      <li>✅ 注册最简单（手机号即可）</li>
      <li>✅ 有免费额度（新用户送 tokens）</li>
      <li>✅ 实名认证快速</li>
      <li>✅ 适合测试</li>
    </ul>
    <p><strong>快速步骤</strong>:</p>
    <ol>
      <li>点击右上角"注册/登录"</li>
      <li>手机号验证码登录</li>
      <li>完成实名认证（上传身份证）</li>
      <li>进入"API Keys"页面</li>
      <li>点击"创建新的API Key"</li>
      <li>复制密钥（格式：<code>xxx.xxxxxxxxxxxxxxxx</code>）</li>
    </ol>
    <a href="https://open.bigmodel.cn/usercenter/apikeys" class="btn" target="_blank">立即申请</a>
  </div>

  <div class="vendor-card">
    <h3>2. 阿里通义万象</h3>
    <p><strong>申请地址</strong>: <a href="https://dashscope.aliyun.com/" target="_blank">https://dashscope.aliyun.com/</a></p>
    <p><strong>控制台</strong>: <a href="https://dashscope.console.aliyun.com/" target="_blank">https://dashscope.console.aliyun.com/</a></p>
    <p><strong>快速步骤</strong>:</p>
    <ol>
      <li>登录阿里云账号（没有则注册）</li>
      <li>搜索"DashScope"或直接访问上述链接</li>
      <li>开通服务（可能需要实名认证）</li>
      <li>进入"API-KEY管理"</li>
      <li>创建新的 API Key（格式：<code>sk-xxxxxxxxxxxxxxxx</code>）</li>
    </ol>
    <a href="https://dashscope.aliyun.com/" class="btn" target="_blank">立即申请</a>
  </div>

  <div class="vendor-card">
    <h3>3. 快手可灵 Kling</h3>
    <p><strong>申请地址</strong>: <a href="https://klingai.kuaishou.com/" target="_blank">https://klingai.kuaishou.com/</a></p>
    <p><strong>开放平台</strong>: <a href="https://developers.kuaishou.com/" target="_blank">https://developers.kuaishou.com/</a></p>
    <p><strong>注意事项</strong>:</p>
    <ul>
      <li>⚠️ 需要快手账号</li>
      <li>⚠️ 需要企业认证或个人开发者认证</li>
      <li>⚠️ 审核时间较长（1-3个工作日）</li>
    </ul>
    <p><strong>快速步骤</strong>:</p>
    <ol>
      <li>快手账号登录</li>
      <li>进入"开放平台" → "应用管理"</li>
      <li>创建新应用</li>
      <li>提交认证资料</li>
      <li>审核通过后获取 Access Key 和 Secret Key</li>
    </ol>
    <a href="https://klingai.kuaishou.com/" class="btn" target="_blank">立即申请</a>
  </div>

  <div class="vendor-card">
    <h3>4. 腾讯混元视频</h3>
    <p><strong>申请地址</strong>: <a href="https://cloud.tencent.com/product/hunyuan" target="_blank">https://cloud.tencent.com/product/hunyuan</a></p>
    <p><strong>控制台</strong>: <a href="https://console.cloud.tencent.com/cam/capi" target="_blank">https://console.cloud.tencent.com/cam/capi</a></p>
    <p><strong>快速步骤</strong>:</p>
    <ol>
      <li>登录腾讯云账号</li>
      <li>搜索"混元大模型"并开通</li>
      <li>进入"访问管理" → "API密钥管理"</li>
      <li>创建密钥</li>
      <li>获取 SecretId 和 SecretKey</li>
    </ol>
    <a href="https://cloud.tencent.com/product/hunyuan" class="btn" target="_blank">立即申请</a>
  </div>

  <div class="vendor-card">
    <h3>5. 豆包（字节跳动）</h3>
    <p><strong>申请地址</strong>: <a href="https://console.volcengine.com/ark" target="_blank">https://console.volcengine.com/ark</a></p>
    <p><strong>快速步骤</strong>:</p>
    <ol>
      <li>注册火山引擎账号</li>
      <li>进入"豆包大模型"控制台</li>
      <li>创建 API Key</li>
      <li>模型：<code>doubao-seedance-1-0-lite-t2v-250428</code></li>
    </ol>
    <a href="https://console.volcengine.com/ark" class="btn" target="_blank">立即申请</a>
  </div>

  <h2>💡 申请后配置</h2>
  <p>申请到密钥后，有两种配置方式：</p>

  <h3>方式1：管理后台配置（推荐）</h3>
  <ol>
    <li>访问管理后台 Settings 页面</li>
    <li>找到"AI视频模型配置"区块</li>
    <li>填写各厂商密钥</li>
    <li>选择默认使用的模型</li>
    <li>设置积分消耗</li>
    <li>点击保存</li>
  </ol>

  <h3>方式2：使用配置脚本</h3>
  <pre><code>cd /home/ubuntu/AI-Short-Video-Management-System
bash configure-video-keys.sh</code></pre>

  <h2>📞 需要帮助？</h2>
  <p>如有问题，请查看详细文档：</p>
  <ul>
    <li>完整申请指南：<code>apply-api-keys.md</code></li>
    <li>配置说明：<code>AI-VIDEO-CONFIG.md</code></li>
  </ul>

  <div class="highlight">
    <strong>⚠️ 安全提示</strong><br>
    请妥善保管API密钥，不要泄露给他人。定期检查用量，避免超额消费。
  </div>

  <hr>
  <p style="color: #999; font-size: 12px; text-align: center;">
    此邮件由 AI短视频管理系统 自动发送<br>
    发送时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
  </p>
</body>
</html>
  `;

  // 发送邮件
  const info = await transporter.sendMail({
    from: `"AI视频系统" <${config.smtp_user}>`,
    to: '2743319061@qq.com',
    subject: '🎬 AI视频模型密钥申请指南',
    html: htmlContent,
    attachments: [
      {
        filename: 'apply-api-keys.md',
        path: path.join(__dirname, '../apply-api-keys.md')
      },
      {
        filename: 'AI-VIDEO-CONFIG.md',
        path: path.join(__dirname, '../AI-VIDEO-CONFIG.md')
      }
    ]
  });

  console.log('✓ 邮件发送成功！');
  console.log('  收件人: 2743319061@qq.com');
  console.log('  Message ID:', info.messageId);
  console.log('  附件: apply-api-keys.md, AI-VIDEO-CONFIG.md');
}

sendEmail().catch(err => {
  console.error('✗ 邮件发送失败:', err.message);
  process.exit(1);
});
