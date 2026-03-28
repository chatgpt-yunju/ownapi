const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../../config/db');
const { verifyCaptcha } = require('./captcha');
const { getSettingCached } = require('./quota');

const loginFailures = new Map();

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
  if (rec.count >= 5) rec.lockedUntil = Date.now() + 15 * 60 * 1000;
  loginFailures.set(username, rec);
}

function clearFailure(username) { loginFailures.delete(username); }

router.post('/login', async (req, res) => {
  const { username, password, captcha_token, captcha_text } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password required' });
  }
  if (checkLocked(username)) {
    return res.status(429).json({ message: '登录失败次数过多，请15分钟后再试' });
  }
  if (!verifyCaptcha(captcha_token, captcha_text)) {
    return res.status(400).json({ message: '验证码错误或已过期' });
  }
  const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password))) {
    recordFailure(username);
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  clearFailure(username);
  const jwtExpiry = await getSettingCached('jwt_expiry', '7d');
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: jwtExpiry }
  );
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

module.exports = router;
