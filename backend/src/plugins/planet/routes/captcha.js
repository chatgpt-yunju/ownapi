const router = require('express').Router();
const svgCaptcha = require('svg-captcha');
const crypto = require('crypto');

// 内存存储：{ token -> { text, expires } }
const store = new Map();

// 每5分钟清理过期验证码
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expires < now) store.delete(k);
  }
}, 5 * 60 * 1000);

// GET /api/captcha — 生成验证码
router.get('/', (req, res) => {
  const captcha = svgCaptcha.create({
    size: 3,
    noise: 1,
    color: true,
    background: '#f5f5f5',
    width: 100,
    height: 40,
    fontSize: 45,
  });
  const token = crypto.randomBytes(16).toString('hex');
  store.set(token, { text: captcha.text.toLowerCase(), expires: Date.now() + 5 * 60 * 1000 });
  res.json({ token, svg: captcha.data });
});

// 验证验证码（供其他路由调用）
function verifyCaptcha(token, input) {
  if (!token || !input) return false;
  const rec = store.get(token);
  if (!rec) return false;
  if (rec.expires < Date.now()) { store.delete(token); return false; }
  const ok = rec.text === input.toLowerCase().trim();
  store.delete(token); // 用完即删
  return ok;
}

module.exports = router;
module.exports.verifyCaptcha = verifyCaptcha;
