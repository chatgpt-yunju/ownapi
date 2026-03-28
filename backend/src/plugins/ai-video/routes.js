const router = require('express').Router();
const { auth } = require('../../middleware/auth');
const db = require('../../config/db');
const { ensureQuota, addQuotaLog, getSetting, getSettingCached } = require('../../routes/quota');
const {
  callDoubaoVideo, callKlingVideo, callZhipuVideo,
  callWanxVideo, callHunyuanVideo, callSora2Video, callVeo3Video,
} = require('../../utils/videoProviders');

const VIDEO_PROVIDERS = {
  doubao:   { match: m => m.includes('doubao') || m.includes('seedance'), call: callDoubaoVideo },
  kling:    { match: m => m.includes('kling'), call: callKlingVideo },
  zhipu:    { match: m => m.includes('cogvideo') || m.includes('zhipu'), call: callZhipuVideo },
  wanx:     { match: m => m.includes('wanx') || m.includes('dashscope'), call: callWanxVideo },
  hunyuan:  { match: m => m.includes('hunyuan') || m.includes('tencent'), call: callHunyuanVideo },
  sora2:    { match: m => m.includes('sora2') || m.includes('sora-2'), call: callSora2Video },
  veo3:     { match: m => m.includes('veo3') || m.includes('veo-3'), call: callVeo3Video },
};

const API_KEY_MAP = {
  doubao: { keys: ['doubao_video_api_key'], envs: ['DOUBAO_API_KEY'] },
  kling:  { keys: ['kling_access_key', 'kling_secret_key'], envs: ['KLING_ACCESS_KEY', 'KLING_SECRET_KEY'] },
  zhipu:  { keys: ['zhipu_api_key'], envs: ['ZHIPU_API_KEY'] },
  wanx:   { keys: ['dashscope_api_key'], envs: ['DASHSCOPE_API_KEY'] },
  hunyuan: { keys: ['tencent_secret_id', 'tencent_secret_key'], envs: ['TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY'] },
  sora2:  { keys: ['sora2_api_key'], envs: ['SORA2_API_KEY'] },
  veo3:   { keys: ['veo3_api_key'], envs: ['VEO3_API_KEY'] },
};

async function resolveApiKeys(providerName) {
  const cfg = API_KEY_MAP[providerName];
  if (!cfg) return [];
  const results = [];
  for (let i = 0; i < cfg.keys.length; i++) {
    const val = await getSetting(cfg.keys[i]) || process.env[cfg.envs[i]];
    if (!val) return null;
    results.push(val);
  }
  return results;
}

function findProvider(model) {
  for (const [name, p] of Object.entries(VIDEO_PROVIDERS)) {
    if (p.match(model)) return { name, call: p.call };
  }
  return null;
}

// POST /api/plugins/ai-video/generate
router.post('/generate', auth, async (req, res) => {
  const { prompt, duration = 5 } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ message: '请输入视频描述' });

  const model = await getSetting('ai_video_model') || 'cogvideox';
  const cost = parseInt(await getSetting('ai_video_cost') || '5');

  const quota = await ensureQuota(req.user.id);
  if (quota.extra_quota < cost) {
    return res.status(403).json({ message: `积分不足，需要 ${cost} 积分，当前 ${quota.extra_quota} 积分`, code: 'QUOTA_EXCEEDED' });
  }

  await db.query('UPDATE user_quota SET extra_quota = extra_quota - ? WHERE user_id = ?', [cost, req.user.id]);
  await addQuotaLog(req.user.id, -cost, 'AI视频生成(插件)');

  try {
    const provider = findProvider(model);
    if (!provider) throw new Error('不支持的视频模型');

    const keys = await resolveApiKeys(provider.name);
    if (!keys) throw new Error('视频API密钥未配置，请联系管理员');

    const videoUrl = await provider.call(prompt.trim(), ...([duration].concat(keys)));
    res.json({ url: videoUrl });
  } catch (e) {
    await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [cost, req.user.id]);
    await addQuotaLog(req.user.id, cost, 'AI视频生成(插件)失败退还');
    res.status(500).json({ message: e.message || 'AI视频生成失败' });
  }
});

// GET /api/plugins/ai-video/config
router.get('/config', async (req, res) => {
  const cost = parseInt(await getSetting('ai_video_cost') || '5');
  res.json({ cost });
});

module.exports = router;
