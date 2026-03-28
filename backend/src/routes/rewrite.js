const router = require('express').Router();
const { auth } = require('../middleware/auth');
const { callGateway } = require('yunjunet-common/backend-core/ai/doubao');

// POST /api/rewrite — 文章改写（通过 api.yunjunet.cn 网关，消耗 USD 余额）
router.post('/', auth, async (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ message: '请输入文章内容或标题' });

  const prompt = `请对以下公众号文章内容进行改写，要求：
1. 保留原文核心观点和信息
2. 改变句式结构和表达方式，避免与原文雷同
3. 语言自然流畅，符合中文阅读习惯
4. 直接输出改写后的内容，不要加任何说明

原文内容：
${content.trim()}`;

  try {
    const data = await callGateway({
      userId: req.user.id,
      messages: [{ role: 'user', content: prompt }],
      tier: 'simple',
    });
    const result = data.choices?.[0]?.message?.content || '';
    res.json({ result });
  } catch (e) {
    if (e.code === 'LOGIN_REQUIRED') return res.status(401).json({ message: e.message, code: 'LOGIN_REQUIRED', needLogin: true });
    if (e.code === 'BALANCE_INSUFFICIENT') return res.status(403).json({ message: '余额不足，请前往 api.yunjunet.cn 购买套餐', code: 'BALANCE_INSUFFICIENT' });
    if (e.code === 'RATE_LIMIT') return res.status(429).json({ message: e.message, code: 'RATE_LIMIT' });
    console.error('Rewrite error:', e);
    res.status(500).json({ message: '服务异常，请稍后重试' });
  }
});

module.exports = router;
