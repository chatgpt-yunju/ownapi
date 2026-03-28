const router = require('express').Router();
const nodemailer = require('nodemailer');
const db = require('../config/db');
const { getSettingCached } = require('./quota');

// ── DB Migration ──
(async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS email_codes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(200) NOT NULL,
      code VARCHAR(6) NOT NULL,
      purpose ENUM('register','login','reset','bind') NOT NULL,
      used TINYINT DEFAULT 0,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_email_purpose (email, purpose)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  await db.query(`ALTER TABLE users ADD COLUMN email VARCHAR(200) DEFAULT NULL`).catch(() => {});
  await db.query(`ALTER TABLE users ADD UNIQUE INDEX idx_email (email)`).catch(() => {});

  // 扩展 purpose 枚举，支持 apikey 验证
  await db.query("ALTER TABLE email_codes MODIFY COLUMN purpose ENUM('register','login','reset','bind','apikey') NOT NULL").catch(() => {});
})();

// ── SMTP transporter (lazy init) ──
const CODE_EXPIRE_MIN = 5;
const SEND_INTERVAL_SEC = 60;
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

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}${local[1]}***@${domain}`;
}

const PURPOSE_LABELS = {
  register: '注册验证',
  login: '登录验证',
  reset: '密码重置',
  bind: '邮箱绑定',
  apikey: 'API Key 创建',
};

// ── POST /api/email-code/send ──
router.post('/send', async (req, res) => {
  try {
    const { email, purpose } = req.body;
    if (!email || !purpose) return res.status(400).json({ message: '参数缺失' });
    if (!isValidEmail(email)) return res.status(400).json({ message: '邮箱格式不正确' });
    if (!PURPOSE_LABELS[purpose]) return res.status(400).json({ message: '无效的验证类型' });

    // Rate limit: 60s per email
    const [[recent]] = await db.query(
      'SELECT id FROM email_codes WHERE email = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? SECOND) ORDER BY id DESC LIMIT 1',
      [email, SEND_INTERVAL_SEC]
    );
    if (recent) {
      return res.status(429).json({ message: `请${SEND_INTERVAL_SEC}秒后再试` });
    }

    // Check email uniqueness for register
    if (purpose === 'register') {
      const [[existing]] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
      if (existing) return res.status(409).json({ message: '该邮箱已被注册' });
    }

    // Check email exists for reset
    if (purpose === 'reset') {
      const [[user]] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
      if (!user) return res.status(404).json({ message: '该邮箱未绑定任何账户' });
    }

    const code = generateCode();
    await db.query(
      'INSERT INTO email_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))',
      [email, code, purpose, CODE_EXPIRE_MIN]
    );

    const transporter = await getTransporter();
    if (!transporter) return res.status(500).json({ message: 'SMTP未配置，请联系管理员' });

    const smtpUser = await getSettingCached('smtp_user', '');
    const label = PURPOSE_LABELS[purpose];
    await transporter.sendMail({
      from: `"云聚平台" <${smtpUser}>`,
      to: email,
      subject: `【云聚】${label}验证码: ${code}`,
      html: `
        <div style="max-width:400px;margin:0 auto;padding:24px;font-family:sans-serif">
          <h2 style="color:#4f46e5">${label}验证码</h2>
          <p style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#333;margin:16px 0">${code}</p>
          <p style="color:#666;font-size:14px">${CODE_EXPIRE_MIN}分钟内有效，请勿泄露给他人。</p>
          <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
          <p style="color:#999;font-size:12px">如非本人操作，请忽略此邮件。</p>
        </div>`,
    });

    res.json({ message: '验证码已发送', masked_email: maskEmail(email) });
  } catch (e) {
    console.error('[emailCode] 发送失败:', e.message);
    res.status(500).json({ message: '验证码发送失败: ' + e.message });
  }
});

// ── Internal: verify email code ──
async function verifyEmailCode(email, code, purpose) {
  if (!email || !code || !purpose) return false;
  const [[row]] = await db.query(
    'SELECT id FROM email_codes WHERE email = ? AND code = ? AND purpose = ? AND used = 0 AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
    [email, code, purpose]
  );
  if (!row) return false;
  await db.query('UPDATE email_codes SET used = 1 WHERE id = ?', [row.id]);
  return true;
}

// ── 可供其他模块调用的发送验证码函数 ──
async function sendEmailCode(email, purpose) {
  if (!email || !purpose) throw new Error('参数缺失');
  if (!isValidEmail(email)) throw new Error('邮箱格式不正确');
  if (!PURPOSE_LABELS[purpose]) throw new Error('无效的验证类型');

  const [[recent]] = await db.query(
    'SELECT id FROM email_codes WHERE email = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? SECOND) ORDER BY id DESC LIMIT 1',
    [email, SEND_INTERVAL_SEC]
  );
  if (recent) throw new Error(`请${SEND_INTERVAL_SEC}秒后再试`);

  const code = generateCode();
  await db.query(
    'INSERT INTO email_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))',
    [email, code, purpose, CODE_EXPIRE_MIN]
  );

  const transporter = await getTransporter();
  if (!transporter) throw new Error('SMTP未配置，请联系管理员');

  const smtpUser = await getSettingCached('smtp_user', '');
  const label = PURPOSE_LABELS[purpose];
  await transporter.sendMail({
    from: `"云聚平台" <${smtpUser}>`,
    to: email,
    subject: `【云聚】${label}验证码: ${code}`,
    html: `
      <div style="max-width:400px;margin:0 auto;padding:24px;font-family:sans-serif">
        <h2 style="color:#4f46e5">${label}验证码</h2>
        <p style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#333;margin:16px 0">${code}</p>
        <p style="color:#666;font-size:14px">${CODE_EXPIRE_MIN}分钟内有效，请勿泄露给他人。</p>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
        <p style="color:#999;font-size:12px">如非本人操作，请忽略此邮件。</p>
      </div>`,
  });
  return maskEmail(email);
}

module.exports = router;
module.exports.verifyEmailCode = verifyEmailCode;
module.exports.sendEmailCode = sendEmailCode;
module.exports.maskEmail = maskEmail;
