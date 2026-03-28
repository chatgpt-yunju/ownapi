const router = require('express').Router();
const { getSettingCached } = require('../../routes/quota');
const { callImage, getClientIP, verifyToken, guestImageExperiences } = require('../../utils/aitoolsShared');

// POST /api/plugins/ai-image/generate
router.post('/generate', async (req, res) => {
  const { prompt: userPrompt } = req.body;
  if (!userPrompt?.trim()) return res.status(400).json({ message: '请输入图片描述' });

  const clientIP = getClientIP(req);
  const userId = verifyToken(req);
  const isGuest = !userId;

  if (isGuest) {
    const guestRecord = guestImageExperiences.get(clientIP);
    if (guestRecord && guestRecord.count >= 1) {
      return res.status(403).json({
        message: '您已用完免费体验次数，注册登录后可继续使用',
        code: 'GUEST_USED',
        needLogin: true,
      });
    }
    guestImageExperiences.set(clientIP, {
      count: (guestRecord?.count || 0) + 1,
      lastTime: new Date(),
    });
  }

  try {
    const imageCost = parseInt(await getSettingCached('cost_image_generate', '1')) || 1;
    const url = await callImage(userPrompt.trim(), imageCost, userId, 'AI生图(插件)');
    res.json({ url });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'BALANCE_INSUFFICIENT') return res.status(402).json({ message: e.message, code: 'BALANCE_INSUFFICIENT' });
    res.status(500).json({ message: e.message || 'AI 生图失败，请稍后重试' });
  }
});

module.exports = router;
