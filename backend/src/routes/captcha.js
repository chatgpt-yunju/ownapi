const router = require('express').Router();
const svgCaptcha = require('svg-captcha');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// GET /api/captcha — 生成验证码
// token 用 JWT 签名，答案嵌入其中，多 worker 均可验证
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
  const text = captcha.text.toLowerCase();
  const token = jwt.sign({ ct: text }, process.env.JWT_SECRET, { expiresIn: '5m' });
  res.json({ token, svg: captcha.data });
});

// 验证验证码（供其他路由调用）
function verifyCaptcha(token, input) {
  if (!token || !input) return false;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded.ct === input.toLowerCase().trim();
  } catch {
    return false;
  }
}

module.exports = router;
module.exports.verifyCaptcha = verifyCaptcha;
