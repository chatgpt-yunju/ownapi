const nodemailer = require('nodemailer');

async function sendEventPPT() {
  const transporter = nodemailer.createTransport({
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    auth: {
      user: '2042132648@qq.com',
      pass: 'bbdlllxpdijucibj'
    }
  });

  const htmlContent = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.8; color: #333;">
  <div style="max-width: 800px; margin: 0 auto; padding: 20px;">
    <h1 style="color: #065A82; border-bottom: 3px solid #065A82; padding-bottom: 15px;">📋 数智分会活动海报</h1>
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
      <strong>Open Claw 安装实践与应用观察</strong>
    </div>
    <p>3月22日（周日）14:00-17:00 | 线下沙龙（30人）</p>
    <p>📍 合肥市望江西路硅谷大厦2103大科科创路演厅</p>
    <p>👥 主办：数智分会、大科科创</p>
    <p>👨‍💻 分享人：SM1920王洁、BZ1916常云举（AI数字科学家团队）</p>
    <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
    <p style="color: #999; font-size: 12px;">此邮件由 AI 短视频管理系统 自动发送</p>
  </div>
</body>
</html>`;

  const info = await transporter.sendMail({
    from: '"数智分会活动" <2042132648@qq.com>',
    to: '2743319061@qq.com',
    subject: '📋 数智分会 2026 线下活动 - Open Claw 安装实践与应用观察',
    html: htmlContent,
    attachments: [
      { filename: '数智分会_OpenClaw线下活动.pptx', path: '/tmp/ppt-event/数智分会_OpenClaw线下活动.pptx' }
    ]
  });

  console.log('✓ PPT邮件发送成功！');
  console.log(' Message ID:', info.messageId);
}

sendEventPPT().catch(console.error);