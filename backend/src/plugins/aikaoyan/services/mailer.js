const nodemailer = require('nodemailer');
const { getSettingCached } = require('../../../routes/quota');

let _transporter = null;

async function getTransporter() {
  if (_transporter) return _transporter;
  const host = await getSettingCached('smtp_host', '');
  const port = parseInt(await getSettingCached('smtp_port', '465'));
  const user = await getSettingCached('smtp_user', '');
  const pass = await getSettingCached('smtp_pass', '');
  if (!host || !user) return null;
  _transporter = nodemailer.createTransport({
    host, port, secure: port === 465,
    auth: { user, pass },
  });
  return _transporter;
}

async function sendPurchaseEmail(to, orderNo, papers, amount) {
  const transporter = await getTransporter();
  if (!transporter) throw new Error('SMTP未配置');
  const user = await getSettingCached('smtp_user', 'noreply@opensora2.cn');
  const list = papers.map(p => `${p.subject_name}（${p.year}年）`).join('、');
  return transporter.sendMail({
    from: `"AI考研真题" <${user}>`,
    to,
    subject: `【AI考研】订单${orderNo} 真题已发送`,
    html: `<h3>您购买的考研真题</h3><p>订单号：${orderNo}</p><p>真题：${list}</p><p>金额：¥${amount}</p><p>请查收附件。</p>`,
  });
}

async function sendVipEmail(to) {
  const transporter = await getTransporter();
  if (!transporter) throw new Error('SMTP未配置');
  const user = await getSettingCached('smtp_user', 'noreply@opensora2.cn');
  return transporter.sendMail({
    from: `"AI考研真题" <${user}>`,
    to,
    subject: '【AI考研】VIP会员开通成功',
    html: '<h3>恭喜您成为VIP会员！</h3><p>您现在可以免费下载所有真题资料。</p>',
  });
}

module.exports = { sendPurchaseEmail, sendVipEmail, getTransporter };
