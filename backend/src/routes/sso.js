const router = require('express').Router();
const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { getChinaDateString } = require('../utils/chinaTime');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { auth, requireAdmin } = require('../middleware/auth');
const { getSettingCached } = require('./quota');
const { validateSilentToken } = require('../services/ssoAuth');
require('dotenv').config();

// Runtime migrations
(async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS oauth_apps (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      name         VARCHAR(128) NOT NULL,
      app_id       VARCHAR(64) UNIQUE NOT NULL,
      app_secret   VARCHAR(255) NOT NULL,
      redirect_uris TEXT NOT NULL,
      daily_deduct_limit INT DEFAULT 0,
      is_active    TINYINT DEFAULT 1,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(() => {});
  await db.query(`
    CREATE TABLE IF NOT EXISTS oauth_codes (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      code         VARCHAR(64) UNIQUE NOT NULL,
      app_id       VARCHAR(64) NOT NULL,
      user_id      INT NOT NULL,
      redirect_uri VARCHAR(512) NOT NULL,
      used         TINYINT DEFAULT 0,
      expires_at   DATETIME NOT NULL,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(() => {});
  await db.query(`
    CREATE TABLE IF NOT EXISTS oauth_deduct_logs (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      app_id     VARCHAR(64) NOT NULL,
      user_id    INT NOT NULL,
      amount     INT NOT NULL,
      reason     VARCHAR(255) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(() => {});
})();

function genAppId() {
  return 'app_' + crypto.randomBytes(8).toString('hex');
}

function genCode() {
  return crypto.randomBytes(24).toString('hex');
}

// ── Admin: 创建应用 ──────────────────────────────────────────
// POST /api/sso/apps
router.post('/apps', auth, requireAdmin, async (req, res) => {
  const { name, redirect_uris, daily_deduct_limit } = req.body;
  if (!name || !redirect_uris) {
    return res.status(400).json({ message: '缺少 name 或 redirect_uris' });
  }
  const uriList = Array.isArray(redirect_uris) ? redirect_uris : [redirect_uris];
  if (uriList.some(u => !u.startsWith('http'))) {
    return res.status(400).json({ message: 'redirect_uri 必须以 http 开头' });
  }
  const appId = genAppId();
  const plainSecret = crypto.randomBytes(32).toString('hex');
  const hashedSecret = await bcrypt.hash(plainSecret, 10);
  await db.query(
    'INSERT INTO oauth_apps (name, app_id, app_secret, redirect_uris, daily_deduct_limit) VALUES (?,?,?,?,?)',
    [name, appId, hashedSecret, JSON.stringify(uriList), daily_deduct_limit || 0]
  );
  res.status(201).json({
    message: '应用创建成功，app_secret 仅显示一次，请妥善保存',
    app_id: appId,
    app_secret: plainSecret,
  });
});

// GET /api/sso/apps
router.get('/apps', auth, requireAdmin, async (req, res) => {
  const [rows] = await db.query(
    'SELECT id, name, app_id, redirect_uris, daily_deduct_limit, is_active, created_at FROM oauth_apps ORDER BY id DESC'
  );
  res.json(rows.map(r => ({ ...r, redirect_uris: JSON.parse(r.redirect_uris) })));
});

// PATCH /api/sso/apps/:id  (停用/启用)
router.patch('/apps/:id', auth, requireAdmin, async (req, res) => {
  const { is_active } = req.body;
  if (is_active === undefined) return res.status(400).json({ message: '缺少 is_active' });
  await db.query('UPDATE oauth_apps SET is_active=? WHERE id=?', [is_active ? 1 : 0, req.params.id]);
  res.json({ message: '更新成功' });
});

// ── Step 1: 验证授权请求，返回应用信息供前端展示 ──────────────
// GET /api/sso/authorize?app_id=&redirect_uri=&state=
router.get('/authorize', async (req, res) => {
  const { app_id, redirect_uri, state } = req.query;
  if (!app_id || !redirect_uri) {
    return res.status(400).json({ message: '缺少 app_id 或 redirect_uri' });
  }
  const [[app]] = await db.query(
    'SELECT name, redirect_uris, is_active FROM oauth_apps WHERE app_id=?', [app_id]
  );
  if (!app) return res.status(404).json({ message: '应用不存在' });
  if (!app.is_active) return res.status(403).json({ message: '应用已停用' });
  const allowed = JSON.parse(app.redirect_uris);
  if (!allowed.includes(redirect_uri)) {
    return res.status(403).json({ message: 'redirect_uri 未授权' });
  }

  // 如果是浏览器请求，返回HTML登录页面
  const acceptHeader = req.get('Accept') || '';
  if (acceptHeader.includes('text/html')) {
    return res.sendFile(require('path').join(__dirname, '../../public/sso-authorize.html'));
  }

  // API请求返回JSON
  res.json({ app_name: app.name, app_id, redirect_uri, state: state || '' });
});

// ── Step 2: 用户登录并授权，返回 code ────────────────────────
// POST /api/sso/authorize
router.post('/authorize', async (req, res) => {
  const { app_id, redirect_uri, state, username, password, captcha_token, captcha_text } = req.body;
  if (!app_id || !redirect_uri || !username || !password) {
    return res.status(400).json({ message: '参数缺失' });
  }
  const { verifyCaptcha } = require('./captcha');
  if (!verifyCaptcha(captcha_token, captcha_text)) {
    return res.status(400).json({ message: '验证码错误或已过期' });
  }
  const [[app]] = await db.query(
    'SELECT redirect_uris, is_active FROM oauth_apps WHERE app_id=?', [app_id]
  );
  if (!app || !app.is_active) return res.status(403).json({ message: '应用无效' });
  const allowed = JSON.parse(app.redirect_uris);
  if (!allowed.includes(redirect_uri)) return res.status(403).json({ message: 'redirect_uri 未授权' });

  const [[user]] = await db.query('SELECT id, username, password, role FROM users WHERE username=?', [username]);
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ message: '用户名或密码错误' });
  }
  const code = genCode();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await db.query(
    'INSERT INTO oauth_codes (code, app_id, user_id, redirect_uri, expires_at) VALUES (?,?,?,?,?)',
    [code, app_id, user.id, redirect_uri, expiresAt]
  );
  const callbackUrl = `${redirect_uri}?code=${code}${state ? '&state=' + encodeURIComponent(state) : ''}`;
  res.json({ redirect_url: callbackUrl });
});

// ── Step 3: code 换 token ─────────────────────────────────────
// POST /api/sso/token
router.post('/token', async (req, res) => {
  const { app_id, app_secret, code } = req.body;
  if (!app_id || !app_secret || !code) return res.status(400).json({ message: '参数缺失' });
  const [[app]] = await db.query('SELECT app_secret, is_active FROM oauth_apps WHERE app_id=?', [app_id]);
  if (!app || !app.is_active) return res.status(403).json({ message: '应用无效' });
  if (!(await bcrypt.compare(app_secret, app.app_secret))) {
    return res.status(403).json({ message: 'app_secret 错误' });
  }
  const [[rec]] = await db.query(
    'SELECT * FROM oauth_codes WHERE code=? AND app_id=? AND used=0', [code, app_id]
  );
  if (!rec) return res.status(400).json({ message: 'code 无效或已使用' });
  if (new Date(rec.expires_at) < new Date()) {
    return res.status(400).json({ message: 'code 已过期' });
  }
  await db.query('UPDATE oauth_codes SET used=1 WHERE id=?', [rec.id]);
  const [[user]] = await db.query('SELECT id, username, role FROM users WHERE id=?', [rec.user_id]);
  const jwtExpiry = await getSettingCached('jwt_expiry', '7d');
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: jwtExpiry }
  );
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// ── Step 4: 查询用户信息 + 积分 ───────────────────────────────
// GET /api/sso/userinfo  (Bearer token)
router.get('/userinfo', auth, async (req, res) => {
  const [[user]] = await db.query('SELECT id, username, role FROM users WHERE id=?', [req.user.id]);
  if (!user) return res.status(404).json({ message: '用户不存在' });
  const [[quota]] = await db.query('SELECT extra_quota FROM user_quota WHERE user_id=?', [req.user.id]);
  res.json({ ...user, extra_quota: quota?.extra_quota ?? 0 });
});

// ── Step 5: 外部站点扣积分 ────────────────────────────────────
// POST /api/sso/quota/deduct
router.post('/quota/deduct', async (req, res) => {
  const { app_id, app_secret, user_id, amount, reason } = req.body;
  if (!app_id || !app_secret || !user_id || !amount || !reason) {
    return res.status(400).json({ message: '参数缺失' });
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ message: 'amount 必须为正整数' });
  }
  const [[app]] = await db.query('SELECT app_secret, is_active, daily_deduct_limit FROM oauth_apps WHERE app_id=?', [app_id]);
  if (!app || !app.is_active) return res.status(403).json({ message: '应用无效' });
  if (!(await bcrypt.compare(app_secret, app.app_secret))) {
    return res.status(403).json({ message: 'app_secret 错误' });
  }
  if (app.daily_deduct_limit > 0) {
    const today = getChinaDateString();
    const [[{ total }]] = await db.query(
      'SELECT COALESCE(SUM(amount),0) as total FROM oauth_deduct_logs WHERE app_id=? AND user_id=? AND DATE(created_at)=?',
      [app_id, user_id, today]
    );
    if (total + amount > app.daily_deduct_limit) {
      return res.status(429).json({ message: '今日扣积分已达上限' });
    }
  }
  const [[quota]] = await db.query('SELECT extra_quota FROM user_quota WHERE user_id=?', [user_id]);
  if (!quota || quota.extra_quota < amount) {
    return res.status(402).json({ message: '积分不足' });
  }
  await db.query('UPDATE user_quota SET extra_quota=extra_quota-? WHERE user_id=?', [amount, user_id]);
  await db.query('INSERT INTO quota_logs (user_id, delta, reason) VALUES (?,?,?)', [user_id, -amount, reason]);
  await db.query('INSERT INTO oauth_deduct_logs (app_id, user_id, amount, reason) VALUES (?,?,?,?)', [app_id, user_id, amount, reason]);
  const [[updated]] = await db.query('SELECT extra_quota FROM user_quota WHERE user_id=?', [user_id]);
  res.json({ message: '扣积分成功', remaining: updated.extra_quota });
});

// POST /api/sso/token-authorize — QQ登录等第三方登录后，用JWT直接换SSO code
router.post('/token-authorize', async (req, res) => {
  const { token, app_id, redirect_uri, state } = req.body;
  if (!token || !app_id || !redirect_uri) return res.status(400).json({ message: '参数缺失' });
  let userId;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    userId = payload.id;
  } catch {
    return res.status(401).json({ message: 'token无效或已过期' });
  }
  const [[app]] = await db.query('SELECT redirect_uris, is_active FROM oauth_apps WHERE app_id=?', [app_id]);
  if (!app || !app.is_active) return res.status(403).json({ message: '应用无效' });
  const allowed = JSON.parse(app.redirect_uris);
  if (!allowed.includes(redirect_uri)) return res.status(403).json({ message: 'redirect_uri 未授权' });
  const code = genCode();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await db.query(
    'INSERT INTO oauth_codes (code, app_id, user_id, redirect_uri, expires_at) VALUES (?,?,?,?,?)',
    [code, app_id, userId, redirect_uri, expiresAt]
  );
  const callbackUrl = `${redirect_uri}?code=${code}${state ? '&state=' + encodeURIComponent(state) : ''}`;
  res.json({ redirect_url: callbackUrl });
});

// GET /api/sso/silent — 子站静默登录验证（验证主站JWT并返回用户信息）
router.get('/silent', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  try {
    const result = await validateSilentToken(token);
    if (!result.ok) return res.status(result.status).json({ message: result.message });
    res.json(result.user);
  } catch {
    res.status(401).json({ message: 'token无效或已过期' });
  }
});

module.exports = router;
