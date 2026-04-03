const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { verifyCaptcha } = require('./captcha');
const { getSettingCached } = require('./quota');
const arkRateLimiter = require('../utils/arkRateLimiter');
const { grantRegisterInviteRewards } = require('../plugins/ai-gateway/utils/inviteRewards');
require('dotenv').config();

const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY;
const DOUBAO_TEXT_MODEL = 'deepseek-v3-2-251201'; // fallback default, overridden by getSettingCached('doubao_text_model')

// Login failure lockout: { username -> { count, lockedUntil } }
const loginFailures = new Map();
const MAX_FAILURES = 5; // can be overridden via settings 'login_max_failures'
const LOCK_MS = 15 * 60 * 1000; // can be overridden via settings 'login_lock_minutes'

function checkLocked(username) {
  const rec = loginFailures.get(username);
  if (!rec) return false;
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) return true;
  if (rec.lockedUntil && Date.now() >= rec.lockedUntil) loginFailures.delete(username);
  return false;
}

function recordFailure(username) {
  const rec = loginFailures.get(username) || { count: 0, lockedUntil: null };
  rec.count += 1;
  if (rec.count >= MAX_FAILURES) rec.lockedUntil = Date.now() + LOCK_MS;
  loginFailures.set(username, rec);
}

function clearFailure(username) { loginFailures.delete(username); }

async function hasReusableLoginCode(email) {
  if (!email) return false;
  const [[row]] = await db.query(
    `SELECT id
     FROM email_codes
     WHERE email = ?
       AND purpose = 'login'
       AND used = 0
       AND expires_at > NOW()
     ORDER BY id DESC
     LIMIT 1`,
    [email]
  );
  return Boolean(row);
}

// Generate Chinese nickname using AI (via gateway)
async function generateNickname() {
  try {
    const { callAI } = require('../utils/aiGateway');
    const nickname = await callAI('生成一个有创意的中文昵称，2-4个字，要求：1.富有诗意或趣味性 2.不要使用常见名字 3.只返回昵称本身，不要其他内容', { tier: 'simple' });
    return nickname?.trim() || `用户${Date.now().toString().slice(-6)}`;
  } catch (error) {
    console.error('AI生成昵称失败:', error.message);
    return `用户${Date.now().toString().slice(-6)}`;
  }
}

function genInviteCode() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

// Database migration: add nickname field
(async () => {
  try {
    await db.query(`
      ALTER TABLE users
      ADD COLUMN nickname VARCHAR(50) DEFAULT NULL
      COMMENT '用户昵称（AI生成）'
    `);
    console.log('users.nickname field added');
  } catch (err) {
    if (!err.message.includes('Duplicate column')) {
      console.error('users migration error:', err.message);
    }
  }
})();

// ── 邮箱验证码相关 ──
const { verifyEmailCode, maskEmail, isAllowedEmailDomain } = require('./emailCode');
const TEMP_TOKEN_EXPIRE = '5m';

function signTempToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, purpose: 'login_verify' },
    process.env.JWT_SECRET,
    { expiresIn: TEMP_TOKEN_EXPIRE }
  );
}

function verifyTempToken(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose !== 'login_verify') return null;
    return decoded;
  } catch { return null; }
}

// POST /api/auth/login — Step1: 密码验证 → 返回 temp_token + 发邮箱验证码
router.post('/login', async (req, res) => {
  const { username, password, captcha_token, captcha_text } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: '请输入用户名和密码' });
  }
  if (checkLocked(username)) {
    return res.status(429).json({ message: '登录失败次数过多，请15分钟后再试' });
  }
  // 验证码降级：当验证码接口异常无法加载时，允许仅账号密码登录
  // 若前端传了验证码，则继续做校验；未传则跳过
  if (captcha_token || captcha_text) {
    if (!verifyCaptcha(captcha_token, captcha_text)) {
      return res.status(400).json({ message: '验证码错误或已过期' });
    }
  }
  const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password))) {
    recordFailure(username);
    return res.status(401).json({ message: '用户名或密码错误' });
  }
  clearFailure(username);

  const tempToken = signTempToken(user);

  if (user.email) {
    // 有邮箱: 发验证码
    try {
      const { sendEmailCode } = require('./emailCode');
      await sendEmailCode(user.email, 'login');
    } catch (e) {
      console.error('[auth] 登录验证码发送失败:', e.message);
      const message = String(e?.message || '');
      const reusableCode = await hasReusableLoginCode(user.email);
      if (reusableCode && (message.includes('请60秒后再试') || message.includes('验证码发送失败'))) {
        return res.json({
          step: 'email_verify',
          temp_token: tempToken,
          masked_email: maskEmail(user.email),
          reused_code: true,
        });
      }
      return res.status(500).json({ message: '登录验证码发送失败，请稍后重试' });
    }
    return res.json({
      step: 'email_verify',
      temp_token: tempToken,
      masked_email: maskEmail(user.email),
    });
  }

  // 无邮箱: 强制绑定
  res.json({ step: 'bind_email', temp_token: tempToken });
});

// POST /api/auth/login/verify — Step2: 邮箱验证码 → 正式 JWT
router.post('/login/verify', async (req, res) => {
  const { temp_token, email_code } = req.body;
  if (!temp_token || !email_code) return res.status(400).json({ message: '参数缺失' });

  const decoded = verifyTempToken(temp_token);
  if (!decoded) return res.status(401).json({ message: '临时令牌无效或已过期，请重新登录' });

  const [[user]] = await db.query('SELECT id, username, role, email FROM users WHERE id = ?', [decoded.id]);
  if (!user || !user.email) return res.status(400).json({ message: '账户异常' });

  const valid = await verifyEmailCode(user.email, email_code, 'login');
  if (!valid) return res.status(400).json({ message: '验证码错误或已过期' });

  const jwtExpiry = await getSettingCached('jwt_expiry', '7d');
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: jwtExpiry }
  );
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, email: user.email } });
});

// POST /api/auth/bind-email — 老用户绑定邮箱 + 完成登录
router.post('/bind-email', async (req, res) => {
  const { temp_token, email, email_code } = req.body;
  if (!temp_token || !email || !email_code) return res.status(400).json({ message: '参数缺失' });
  if (!isAllowedEmailDomain(email)) return res.status(400).json({ message: '仅支持国内主流邮箱（QQ、163、126、新浪、搜狐等）' });

  const decoded = verifyTempToken(temp_token);
  if (!decoded) return res.status(401).json({ message: '临时令牌无效或已过期，请重新登录' });

  // 检查邮箱是否已被占用
  const [[existing]] = await db.query('SELECT id FROM users WHERE email = ? AND id != ?', [email, decoded.id]);
  if (existing) return res.status(409).json({ message: '该邮箱已被其他账户绑定' });

  const valid = await verifyEmailCode(email, email_code, 'bind');
  if (!valid) return res.status(400).json({ message: '验证码错误或已过期' });

  await db.query('UPDATE users SET email = ? WHERE id = ?', [email, decoded.id]);

  const jwtExpiry = await getSettingCached('jwt_expiry', '7d');
  const token = jwt.sign(
    { id: decoded.id, username: decoded.username, role: decoded.role, email },
    process.env.JWT_SECRET,
    { expiresIn: jwtExpiry }
  );
  res.json({ token, user: { id: decoded.id, username: decoded.username, role: decoded.role, email } });
});

// POST /api/auth/forgot-password — 发送密码重置验证码
router.post('/forgot-password', async (req, res) => {
  const { email, captcha_token, captcha_text } = req.body;
  if (!email) return res.status(400).json({ message: '请输入邮箱' });
  if (!verifyCaptcha(captcha_token, captcha_text)) {
    return res.status(400).json({ message: '验证码错误或已过期' });
  }
  // 不透露邮箱是否存在（安全最佳实践）
  const [[user]] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
  if (!user) return res.json({ message: '如果该邮箱已注册，验证码将发送到您的邮箱' });

  // 调用 email-code/send 逻辑
  try {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await db.query(
      'INSERT INTO email_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))',
      [email, code, 'reset']
    );
    const nodemailer = require('nodemailer');
    const host = await getSettingCached('smtp_host', '');
    const port = parseInt(await getSettingCached('smtp_port', '465'));
    const smtpUser = await getSettingCached('smtp_user', '');
    const pass = await getSettingCached('smtp_pass', '');
    if (host && smtpUser) {
      const transporter = nodemailer.createTransport({
        host, port, secure: port === 465,
        auth: { user: smtpUser, pass },
      });
      await transporter.sendMail({
        from: `"云聚平台" <${smtpUser}>`,
        to: email,
        subject: `【云聚】密码重置验证码: ${code}`,
        html: `<div style="max-width:400px;margin:0 auto;padding:24px;font-family:sans-serif"><h2 style="color:#e53935">密码重置验证码</h2><p style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#333">${code}</p><p style="color:#666;font-size:14px">5分钟内有效。如非本人操作，请忽略此邮件。</p></div>`,
      });
    }
  } catch (e) {
    console.error('[auth] 重置验证码发送失败:', e.message);
  }
  res.json({ message: '如果该邮箱已注册，验证码将发送到您的邮箱' });
});

// POST /api/auth/reset-password — 验证码重置密码
router.post('/reset-password', async (req, res) => {
  const { email, email_code, new_password } = req.body;
  if (!email || !email_code || !new_password) return res.status(400).json({ message: '参数缺失' });
  if (!/(?=.*[a-zA-Z])(?=.*\d).{8,}/.test(new_password)) {
    return res.status(400).json({ message: '密码至少8位且包含字母和数字' });
  }

  const valid = await verifyEmailCode(email, email_code, 'reset');
  if (!valid) return res.status(400).json({ message: '验证码错误或已过期' });

  const hash = await bcrypt.hash(new_password, 10);
  const [result] = await db.query('UPDATE users SET password = ? WHERE email = ?', [hash, email]);
  if (result.affectedRows === 0) return res.status(404).json({ message: '账户不存在' });

  res.json({ message: '密码重置成功，请使用新密码登录' });
});

router.post('/register', async (req, res) => {
  const { username, password, email, email_code, invite_code, captcha_token, captcha_text } = req.body;
  if (!username || !password || !email || !email_code) {
    return res.status(400).json({ message: '请填写用户名、密码、邮箱和验证码' });
  }
  if (!isAllowedEmailDomain(email)) {
    return res.status(400).json({ message: '仅支持国内主流邮箱（QQ、163、126、新浪、搜狐等）' });
  }
  if (!verifyCaptcha(captcha_token, captcha_text)) {
    return res.status(400).json({ message: '图形验证码错误或已过期' });
  }
  if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return res.status(400).json({ message: '密码至少8位，且需包含字母和数字' });
  }
  // 验证邮箱验证码
  const emailValid = await verifyEmailCode(email, email_code, 'register');
  if (!emailValid) {
    return res.status(400).json({ message: '邮箱验证码错误或已过期' });
  }
  const hash = await bcrypt.hash(password, 10);
  const myCode = genInviteCode();
  const tempNickname = `用户${Date.now().toString().slice(-6)}`;
  try {
    const conn = await db.getConnection();
    let newUserId;
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        'INSERT INTO users (username, password, role, invite_code, nickname, email) VALUES (?, ?, "user", ?, ?, ?)',
        [username, hash, myCode, tempNickname, email]
      );
      newUserId = result.insertId;

      if (invite_code) {
        await grantRegisterInviteRewards({
          conn,
          inviteCode: invite_code,
          inviteeUserId: newUserId,
          inviteeUsername: username,
        });
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    // AI 昵称后台异步生成，不阻塞注册
    generateNickname().then(aiNick => {
      if (aiNick && !aiNick.startsWith('用户')) {
        db.query('UPDATE users SET nickname=? WHERE id=?', [aiNick, newUserId]).catch(() => {});
      }
    }).catch(() => {});

    // Generate JWT token for auto-login
    const jwtExpiry = await getSettingCached('jwt_expiry', '7d');
    const token = jwt.sign(
      { id: newUserId, username: username, role: 'user', email },
      process.env.JWT_SECRET,
      { expiresIn: jwtExpiry }
    );
    res.status(201).json({
      message: 'Registered successfully',
      id: newUserId,
      token,
      user: { id: newUserId, username: username, role: 'user', email }
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Username already taken' });
    }
    throw err;
  }
});

// 修改密码
router.post('/change-password', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: '未登录' });
  let userId;
  try { userId = require('jsonwebtoken').verify(token, process.env.JWT_SECRET).id; } catch { return res.status(401).json({ message: 'token无效' }); }
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) return res.status(400).json({ message: '参数缺失' });
  if (!/(?=.*[a-zA-Z])(?=.*\d).{8,}/.test(new_password)) return res.status(400).json({ message: '新密码至少8位且包含字母和数字' });
  const [[user]] = await db.query('SELECT password FROM users WHERE id=?', [userId]);
  if (!user) return res.status(404).json({ message: '用户不存在' });
  const ok = await bcrypt.compare(old_password, user.password);
  if (!ok) return res.status(400).json({ message: '当前密码错误' });
  const hash = await bcrypt.hash(new_password, 10);
  await db.query('UPDATE users SET password=? WHERE id=?', [hash, userId]);
  res.json({ message: '密码修改成功' });
});

// 首次设置密码（仅限从未设置过密码的 SSO/QQ 用户）
router.post('/set-initial-password', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: '未登录' });
  let userId;
  try { userId = require('jsonwebtoken').verify(token, process.env.JWT_SECRET).id; } catch { return res.status(401).json({ message: 'token无效' }); }
  const { new_password } = req.body;
  if (!new_password) return res.status(400).json({ message: '请输入新密码' });
  if (!/(?=.*[a-zA-Z])(?=.*\d).{8,}/.test(new_password)) {
    return res.status(400).json({ message: '密码至少8位且包含字母和数字' });
  }
  const [[user]] = await db.query('SELECT password FROM users WHERE id=?', [userId]);
  if (!user) return res.status(404).json({ message: '用户不存在' });
  if (user.password && user.password.length > 0) {
    return res.status(400).json({ message: '您已设置过密码，请使用修改密码功能' });
  }
  const hash = await bcrypt.hash(new_password, 10);
  await db.query('UPDATE users SET password=? WHERE id=?', [hash, userId]);
  res.json({ message: '密码设置成功' });
});

// QQ OAuth DB migration
(async () => {
  const cols = [
    "ADD COLUMN qq_openid VARCHAR(64) DEFAULT NULL",
    "ADD COLUMN qq_nickname VARCHAR(100) DEFAULT NULL",
    "ADD COLUMN qq_avatar VARCHAR(500) DEFAULT NULL",
  ];
  for (const col of cols) {
    try { await db.query(`ALTER TABLE users ${col}`); }
    catch (err) { if (!err.message.includes('Duplicate column')) console.error('users QQ migration:', err.message); }
  }
  try { await db.query('ALTER TABLE users ADD INDEX idx_qq_openid (qq_openid)'); } catch {}
})();

// GET /api/auth/qq — 发起QQ OAuth登录
router.get('/qq', async (req, res) => {
  const enabled = await getSettingCached('qq_login_enabled', 'false');
  if (enabled !== 'true') return res.status(403).json({ message: 'QQ登录未启用' });
  const appId = await getSettingCached('qq_app_id', '');
  if (!appId) return res.status(500).json({ message: 'QQ App ID未配置' });
  const relayDomain = await getSettingCached('login_relay_domain', 'https://login.opensora2.cn');
  const redirectUri = encodeURIComponent(`${relayDomain}/return.php`);
  const state = encodeURIComponent(req.query.return_url || '/');
  res.redirect(`https://graph.qq.com/oauth2.0/authorize?response_type=code&client_id=${appId}&redirect_uri=${redirectUri}&state=${state}&scope=get_user_info`);
});

// GET /api/auth/qq/callback — QQ回调处理
router.get('/qq/callback', async (req, res) => {
  const { code, state } = req.query;
  const returnUrl = decodeURIComponent(state || '/');
  try {
    const appId = await getSettingCached('qq_app_id', '');
    const appKey = await getSettingCached('qq_app_key', '');
    const relayDomain = await getSettingCached('login_relay_domain', 'https://login.opensora2.cn');
    const redirectUri = encodeURIComponent(`${relayDomain}/return.php`);
    const axios = require('axios');
    // Step 1: code → access_token
    const tokenRes = await axios.get(
      `https://graph.qq.com/oauth2.0/token?grant_type=authorization_code&client_id=${appId}&client_secret=${appKey}&code=${code}&redirect_uri=${redirectUri}&fmt=json`
    );
    console.log('[QQ OAuth] Step1 token response:', JSON.stringify(tokenRes.data));
    const accessToken = tokenRes.data.access_token;
    if (!accessToken) throw new Error(`QQ token failed: ${JSON.stringify(tokenRes.data)}`);
    // Step 2: access_token → openid
    const meRes = await axios.get(
      `https://graph.qq.com/oauth2.0/me?access_token=${accessToken}&fmt=json`
    );
    console.log('[QQ OAuth] Step2 me response:', JSON.stringify(meRes.data));
    const openid = meRes.data.openid;
    if (!openid) throw new Error(`QQ openid failed: ${JSON.stringify(meRes.data)}`);
    // Step 3: get user info
    const infoRes = await axios.get(
      `https://graph.qq.com/user/get_user_info?access_token=${accessToken}&oauth_consumer_key=${appId}&openid=${openid}`
    );
    const qqNickname = infoRes.data.nickname || '';
    const qqAvatar = infoRes.data.figureurl_qq_1 || '';
    // Step 4: find or create user
    let [[user]] = await db.query('SELECT id, username, role FROM users WHERE qq_openid=?', [openid]);
    if (!user) {
      const username = `qq_${openid.slice(-8)}`;
      const myCode = genInviteCode();
      const [result] = await db.query(
        'INSERT INTO users (username, password, role, invite_code, qq_openid, qq_nickname, qq_avatar) VALUES (?,?,?,?,?,?,?)',
        [username, '', 'user', myCode, openid, qqNickname, qqAvatar]
      );
      user = { id: result.insertId, username, role: 'user' };
    } else {
      await db.query('UPDATE users SET qq_nickname=?, qq_avatar=? WHERE id=?', [qqNickname, qqAvatar, user.id]);
    }
    const jwtExpiry = await getSettingCached('jwt_expiry', '7d');
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: jwtExpiry }
    );
    const sep = returnUrl.includes('?') ? '&' : '?';
    res.redirect(`${returnUrl}${sep}token=${token}`);
  } catch (err) {
    console.error('QQ OAuth callback error:', err.message);
    const sep = returnUrl.includes('?') ? '&' : '?';
    res.redirect(`${returnUrl}${sep}error=qq_login_failed&msg=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
