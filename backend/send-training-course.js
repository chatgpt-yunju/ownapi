const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

async function sendTrainingCourse() {
  try {
    // SMTP 配置（从数据库读取）
    const config = {
      smtp_host: 'smtp.qq.com',
      smtp_port: 465,
      smtp_user: '2042132648@qq.com',
      smtp_pass: 'bbdlllxpdijucibj'
    };

    // 创建邮件传输器
    const transporter = nodemailer.createTransport({
      host: config.smtp_host,
      port: parseInt(config.smtp_port),
      secure: true,
      auth: {
        user: config.smtp_user,
        pass: config.smtp_pass
      }
    });

    // 准备 HTML 邮件内容
    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif; line-height: 1.8; color: #333; }
    .container { max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { color: #1a73e8; border-bottom: 3px solid #1a73e8; padding-bottom: 15px; }
    .highlight { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
    .info-box { background: #e8f5e9; border-left: 4px solid #4caf50; padding: 15px; margin: 15px 0; border-radius: 4px; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #999; font-size: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📚 OpenClaw 实战培训课</h1>
    <div class="highlight">
      <strong>AI 办公效能加速器：OpenClaw AI 全场景实战应用</strong>
    </div>
    <div class="info-box">
      <strong>培训课时：1天</strong><br>
      本课程聚焦于先进国产推理大模型 OpenClaw、通用 AIGC 大模型创新技术，旨在为学员提供一套完整的解决方案，以提升工作效率和创新能力。
    </div>
    <h2>课程收益</h2>
    <ul>
      <li>探索国内外 AI 技术与应用工具发展状况</li>
      <li>掌握当前主流 AI 对话工具：OpenClaw、KIMI、豆包、通义千问等</li>
      <li>掌握正确 AI 对话提示词使用方法</li>
      <li>掌握 AI 工具在邮件、工作汇报、项目方案等场景的应用</li>
      <li>掌握 AI 工具在 PPT 制作场景下的应用技巧</li>
      <li>掌握 AI 工具在生成图片、处理图片等场景的应用技能</li>
    </ul>
    <h2>课程模块</h2>
    <ul>
      <li><strong>模块一：</strong>AI 引领未来职场变革 - 让 OpenClaw 成为公文创作助手</li>
      <li><strong>模块二：</strong>OpenClaw + PPT 智能设计 - AI 图片生成与处理</li>
      <li><strong>模块三：</strong>OpenClaw 数据处理分析 - AI Agent 智能体</li>
    </ul>
    <div class="footer">
      <p>此邮件由 AI 短视频管理系统 自动发送</p>
      <p>发送时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>
    </div>
  </div>
</body>
</html>`;

    // 发送邮件
    const info = await transporter.sendMail({
      from: `"OpenClaw 培训课程" <${config.smtp_user}>`,
      to: '2743319061@qq.com',
      subject: '📚 OpenClaw 实战培训课：AI 办公效能加速器 - 课程大纲',
      html: htmlContent,
      attachments: [
        {
          filename: 'AI办公效能加速器_OpenClaw培训课程.docx',
          path: '/tmp/docx-training/AI办公效能加速器_OpenClaw培训课程.docx'
        }
      ]
    });

    console.log('✓ 邮件发送成功！');
    console.log(' 收件人: 2743319061@qq.com');
    console.log(' 主题: OpenClaw 实战培训课 - 课程大纲');
    console.log(' Message ID:', info.messageId);
    console.log(' 附件: AI办公效能加速器_OpenClaw培训课程.docx');
  } catch (err) {
    console.error('✗ 邮件发送失败:', err.message);
    process.exit(1);
  }
}

sendTrainingCourse();