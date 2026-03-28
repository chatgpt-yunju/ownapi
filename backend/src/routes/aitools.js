const router = require('express').Router();
const db = require('../config/db');
const { auth } = require('../middleware/auth');
const { ensureQuota, addQuotaLog, getSetting, getSettingCached } = require('./quota');
const arkRateLimiter = require('../utils/arkRateLimiter');
const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads');
const AITOOLS_DIR = path.join(UPLOAD_DIR, 'aitools');

// 确保目录存在
if (!require('fs').existsSync(AITOOLS_DIR)) {
  require('fs').mkdirSync(AITOOLS_DIR, { recursive: true });
}

const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY;
const DOUBAO_TEXT_MODEL = 'deepseek-v3-2-251201'; // kept as fallback default
const DOUBAO_IMAGE_MODEL = 'doubao-seedream-5-0-260128'; // kept as fallback default
const DOUBAO_VIDEO_MODEL = 'doubao-seedance-1-0-lite-t2v-250428'; // kept as fallback default
const DOUBAO_3D_MODEL = 'doubao-seed3d-1-0-250928'; // kept as fallback default

// Dynamic model/URL getters (cached 60s from settings table)
async function getTextModel() { return (await getSettingCached('ark_glm_endpoint', '')) || (await getSettingCached('doubao_text_model', DOUBAO_TEXT_MODEL)); }
async function getImageModel() { return await getSettingCached('doubao_image_model', DOUBAO_IMAGE_MODEL); }
async function getVideoModel() { return await getSettingCached('doubao_video_model', DOUBAO_VIDEO_MODEL); }
async function get3DModel() { return await getSettingCached('doubao_3d_model', DOUBAO_3D_MODEL); }
async function getArkBaseUrl() { return await getSettingCached('ark_base_url', 'https://ark.cn-beijing.volces.com/api/v3'); }

// 视频模型厂商配置
const KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY;
const KLING_SECRET_KEY = process.env.KLING_SECRET_KEY;
const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const TENCENT_SECRET_ID = process.env.TENCENT_SECRET_ID;
const TENCENT_SECRET_KEY = process.env.TENCENT_SECRET_KEY;
const SORA2_API_KEY = process.env.SORA2_API_KEY;
const VEO3_API_KEY = process.env.VEO3_API_KEY;

// 分析视频内容生成描述
async function analyzeVideoContent(videoPath) {
  return new Promise(async (resolve) => {
    try {
      if (!DOUBAO_API_KEY) {
        console.log('[analyzeVideo] DOUBAO_API_KEY not configured');
        resolve('');
        return;
      }

      const { exec } = require('child_process');
      const tempDir = path.join(UPLOAD_DIR, 'temp');
      fs.mkdirSync(tempDir, { recursive: true });

      // 提取3个关键帧（开头、中间、结尾）
      const frames = [];
      const timestamps = ['00:00:01', '00:00:03', '00:00:05'];

      for (let i = 0; i < timestamps.length; i++) {
        const framePath = path.join(tempDir, `frame-${Date.now()}-${i}.jpg`);

        await new Promise((resolveFrame) => {
          exec(`/usr/bin/ffmpeg -i "${videoPath}" -ss ${timestamps[i]} -vframes 1 -vf "scale=512:-1" "${framePath}" -y`,
            (error) => {
              if (!error && fs.existsSync(framePath)) {
                frames.push(framePath);
              }
              resolveFrame();
            }
          );
        });
      }

      if (frames.length === 0) {
        console.log('[analyzeVideo] No frames extracted');
        resolve('');
        return;
      }

      // 读取第一帧并转为base64
      const frameBuffer = fs.readFileSync(frames[0]);
      const base64Image = frameBuffer.toString('base64');

      // 调用AI分析图像
      const prompt = `请分析这个视频截图，用简洁的中文描述视频内容（50-100字）。要求：
1. 描述画面中的主要内容和场景
2. 如果有文字，提取关键信息
3. 语言自然流畅，适合作为短视频文案
4. 直接输出描述，不要加任何前缀`;

      const arkBaseUrl = await getArkBaseUrl();
      const response = await fetch(`${arkBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DOUBAO_API_KEY}`
        },
        body: JSON.stringify({
          model: 'doubao-vision-pro-32k', // vision model — not configurable via text/image model settings
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
            ]
          }]
        })
      });

      // 清理临时文件
      frames.forEach(f => {
        try { fs.unlinkSync(f); } catch (e) {}
      });

      if (!response.ok) {
        console.log('[analyzeVideo] AI API failed:', response.status);
        resolve('');
        return;
      }

      const data = await response.json();
      const description = data.choices?.[0]?.message?.content || '';

      console.log('[analyzeVideo] Generated description:', description.substring(0, 50) + '...');
      resolve(description);

    } catch (e) {
      console.error('[analyzeVideo] Error:', e.message);
      resolve('');
    }
  });
}

// 共享工具函数（从 utils/aitoolsShared.js 引入）
const { callText, callImage, guestChatExperiences, guestExperiences, guestImageExperiences, guestToolExperiences, getClientIP, verifyToken, guestToolLimit } = require('../utils/aitoolsShared');

// POST /api/aitools/copy — AI生成短视频文案（1积分）
router.post('/copy', guestToolLimit, auth, async (req, res) => {
  const { topic, style = '轻松幽默', platform = '抖音', length = '短' } = req.body;
  if (!topic?.trim()) return res.status(400).json({ message: '请输入主题或关键词' });

  const lengthMap = { 短: '50字以内', 中: '100字左右', 长: '200字左右' };
  const prompt = `你是一位专业的短视频文案创作者，请为以下主题创作一条${platform}短视频文案。

主题/关键词：${topic.trim()}
风格：${style}
字数要求：${lengthMap[length] || '100字左右'}

要求：
1. 开头要有吸引力，能让用户停下来看
2. 语言自然口语化，符合${platform}用户习惯
3. 结尾加上互动引导（如提问、号召评论等）
4. 直接输出文案内容，不要加任何说明

请输出3个不同版本的文案，用"---"分隔。`;

  try {
    const result = await callText(prompt, 1, req.user.id, 'AI生成文案');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败，请稍后重试' });
  }
});

// POST /api/aitools/title — AI生成爆款标题（1积分）
router.post('/title', auth, async (req, res) => {
  const { copy } = req.body;
  if (!copy?.trim()) return res.status(400).json({ message: '请输入视频文案或主题' });

  const prompt = `你是一位短视频爆款标题专家，请根据以下内容生成10个吸引眼球的短视频标题。

内容：${copy.trim()}

要求：
1. 标题要有强烈的点击欲望
2. 可以使用数字、疑问句、反转、悬念等技巧
3. 每个标题控制在20字以内
4. 覆盖不同风格：情感共鸣型、干货实用型、悬念好奇型、数字冲击型等
5. 直接输出标题列表，每行一个，前面加序号`;

  try {
    const result = await callText(prompt, 1, req.user.id, 'AI生成标题');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败，请稍后重试' });
  }
});

// POST /api/aitools/comment — AI生成评论回复话术（1积分）
router.post('/comment', auth, async (req, res) => {
  const { comment, context = '' } = req.body;
  if (!comment?.trim()) return res.status(400).json({ message: '请输入评论内容' });

  const prompt = `你是一位擅长互动运营的短视频博主，请针对以下评论生成5条回复话术。

${context ? `视频主题：${context.trim()}\n` : ''}用户评论：${comment.trim()}

要求：
1. 回复要真诚、有温度，拉近与粉丝的距离
2. 适当引导用户继续互动（点赞、关注、转发）
3. 语言轻松自然，符合短视频平台风格
4. 每条回复控制在50字以内
5. 直接输出回复列表，每条用序号标注`;

  try {
    const result = await callText(prompt, 1, req.user.id, 'AI生成评论回复');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败，请稍后重试' });
  }
});

// POST /api/aitools/hashtag — AI生成话题标签（1积分）
router.post('/hashtag', auth, async (req, res) => {
  const { copy, platform = '抖音' } = req.body;
  if (!copy?.trim()) return res.status(400).json({ message: '请输入文案内容' });

  const prompt = `你是一位短视频运营专家，请根据以下文案为${platform}平台生成最优话题标签组合。

文案内容：${copy.trim()}

要求：
1. 生成20个相关话题标签
2. 包含：大流量通用标签（5个）、垂直领域标签（10个）、长尾精准标签（5个）
3. 标签要与内容高度相关，能帮助提升曝光
4. 直接输出标签，用空格分隔，每个标签前加#号`;

  try {
    const result = await callText(prompt, 1, req.user.id, 'AI生成话题标签');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败，请稍后重试' });
  }
});

// POST /api/aitools/script — AI生成视频脚本（2积分）
router.post('/script', auth, async (req, res) => {
  const { topic, duration = '60', type = '知识分享' } = req.body;
  if (!topic?.trim()) return res.status(400).json({ message: '请输入视频主题' });
  const prompt = `你是一位专业短视频导演，请为以下主题创作一个完整的短视频拍摄脚本。

主题：${topic.trim()}
视频时长：${duration}秒
视频类型：${type}

请按以下格式输出脚本：
【开场钩子】（0-5秒）：
【主体内容】（分镜头描述，包含画面、台词、动作）：
【结尾引导】（最后5秒）：
【拍摄建议】（场景、道具、注意事项）：`;
  try {
    const result = await callText(prompt, 2, req.user.id, 'AI生成视频脚本');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/live — AI生成直播话术（2积分）
router.post('/live', auth, async (req, res) => {
  const { product, scene = '开播' } = req.body;
  if (!product?.trim()) return res.status(400).json({ message: '请输入产品或直播主题' });
  const sceneMap = { 开播: '开播欢迎话术', 介绍产品: '产品介绍话术', 促单: '逼单成交话术', 互动: '粉丝互动话术', 下播: '下播留存话术' };
  const prompt = `你是一位顶级直播带货主播，请为以下产品生成专业的${sceneMap[scene] || scene}。

产品/主题：${product.trim()}
话术场景：${scene}

要求：
1. 语言热情有感染力，节奏感强
2. 突出产品卖点和用户痛点
3. 包含互动引导和紧迫感营造
4. 生成3套不同风格的话术，用"---"分隔
5. 每套话术100-200字`;
  try {
    const result = await callText(prompt, 2, req.user.id, 'AI生成直播话术');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/xiaohongshu — AI生成小红书图文（2积分）
router.post('/xiaohongshu', auth, async (req, res) => {
  const { topic, style = '生活分享' } = req.body;
  if (!topic?.trim()) return res.status(400).json({ message: '请输入主题' });
  const prompt = `你是一位小红书爆款内容创作者，请为以下主题创作一篇完整的小红书图文笔记。

主题：${topic.trim()}
风格：${style}

请按以下格式输出：
【标题】（含emoji，吸引眼球）：
【正文】（分段，含emoji，口语化，500字左右）：
【话题标签】（20个相关标签）：
【封面图建议】（描述封面图内容和风格）：`;
  try {
    const result = await callText(prompt, 2, req.user.id, 'AI生成小红书图文');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/profile — AI生成账号简介（1积分）
router.post('/profile', auth, async (req, res) => {
  const { niche, platform = '抖音', style = '专业' } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入账号定位' });
  const prompt = `你是一位自媒体账号运营专家，请为以下定位的${platform}账号生成5个不同风格的账号简介。

账号定位：${niche.trim()}
平台：${platform}
风格：${style}

要求：
1. 每个简介控制在50字以内
2. 突出账号价值和受众利益
3. 包含关键词，便于搜索
4. 语言简洁有力，让人一眼记住
5. 每个简介单独一行，前面加序号`;
  try {
    const result = await callText(prompt, 1, req.user.id, 'AI生成账号简介');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/seed — AI种草文案（1积分）
router.post('/seed', auth, async (req, res) => {
  const { product, platform = '小红书' } = req.body;
  if (!product?.trim()) return res.status(400).json({ message: '请输入产品名称或描述' });
  const prompt = `你是一位专业的种草博主，请为以下产品创作3篇真实自然的种草文案。

产品：${product.trim()}
平台：${platform}

要求：
1. 以第一人称真实体验感受为主
2. 突出产品使用场景和效果
3. 语言真实自然，避免广告感
4. 包含使用前后对比或具体细节
5. 结尾引导互动
6. 每篇150字左右，用"---"分隔`;
  try {
    const result = await callText(prompt, 1, req.user.id, 'AI种草文案');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/summary — 摘要提炼（1积分）
router.post('/summary', auth, async (req, res) => {
  const { content, length = '100字左右' } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: '请输入内容' });
  const prompt = `请将以下内容提炼为${length}的摘要，保留核心观点，语言简洁清晰：\n\n${content.trim()}`;
  try {
    const result = await callText(prompt, 1, req.user.id, 'AI摘要提炼');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/sensitive — 违禁词检测（1积分）
router.post('/sensitive', auth, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: '请输入内容' });
  const prompt = `你是一位自媒体合规专家，请检测以下内容中的违禁词、敏感词、夸大宣传词、极限词等不合规表达。

内容：${content.trim()}

请按以下格式输出：
【检测结果】：合规 / 存在风险
【风险词汇】：列出所有风险词汇（如无则写"无"）
【风险说明】：说明每个风险词的问题
【修改建议】：提供合规的替换表达`;
  try {
    const result = await callText(prompt, 1, req.user.id, '违禁词检测');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/imitate — 爆款仿写（2积分）
router.post('/imitate', auth, async (req, res) => {
  const { original, topic } = req.body;
  if (!original?.trim() || !topic?.trim()) return res.status(400).json({ message: '请输入爆款原文和仿写主题' });
  const prompt = `你是一位爆款内容创作专家，请分析以下爆款文案的写作结构和技巧，然后用相同的结构和风格，为新主题创作3个仿写版本。

爆款原文：${original.trim()}

仿写主题：${topic.trim()}

要求：
1. 保留原文的句式结构、节奏感和情绪张力
2. 替换为新主题的内容
3. 保持同等的吸引力和传播性
4. 三个版本用"---"分隔`;
  try {
    const result = await callText(prompt, 2, req.user.id, '爆款仿写');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/oral — 口播脚本（1积分）
router.post('/oral', auth, async (req, res) => {
  const { topic, duration = '60', style = '自然口语' } = req.body;
  if (!topic?.trim()) return res.status(400).json({ message: '请输入视频主题' });
  const prompt = `你是一位专业口播博主，请为以下主题创作一段${duration}秒的口播脚本。

主题：${topic.trim()}
风格：${style}

要求：
1. 语言自然流畅，适合直接对着镜头说
2. 开头3秒要有强烈的钩子吸引观众
3. 节奏感强，有停顿和重音提示（用【停顿】【重音】标注）
4. 结尾有明确的行动号召
5. 按${duration}秒语速（约每秒4-5字）控制字数`;
  try {
    const result = await callText(prompt, 1, req.user.id, '口播脚本');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/videocopy — 视频文案（1积分）
router.post('/videocopy', auth, async (req, res) => {
  const { desc, platform = '抖音' } = req.body;
  if (!desc?.trim()) return res.status(400).json({ message: '请输入视频内容描述' });
  const prompt = `你是一位${platform}平台的视频运营专家，请根据以下视频内容描述，生成完整的视频发布文案。

视频内容：${desc.trim()}
发布平台：${platform}

请输出：
【视频标题】（吸引点击，含关键词）：
【视频简介】（100字左右，描述视频价值）：
【话题标签】（15个相关标签）：
【发布时间建议】：`;
  try {
    const result = await callText(prompt, 1, req.user.id, '视频文案');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/topic — 选题分析（2积分）
router.post('/topic', auth, async (req, res) => {
  const { niche, platform = '抖音' } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入账号定位' });
  const prompt = `你是一位${platform}平台的内容策略专家，请为以下账号定位提供详细的选题分析和内容规划。

账号定位：${niche.trim()}
目标平台：${platform}

请输出：
【核心选题方向】（5个主要内容方向）：
【爆款选题推荐】（10个具体选题，含预估流量潜力）：
【内容差异化建议】（如何与同类账号区分）：
【内容日历建议】（一周内容安排示例）：
【避坑提示】（该领域常见内容误区）：`;
  try {
    const result = await callText(prompt, 2, req.user.id, '选题分析');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/hotspot — 热点捕捉（2积分）
router.post('/hotspot', auth, async (req, res) => {
  const { niche, platform = '抖音' } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入账号领域' });
  const prompt = `你是一位${platform}平台的热点运营专家，请为${niche.trim()}领域的创作者分析当前热点借势机会。

请输出：
【当前热点话题】（10个适合该领域借势的热点方向）：
【借势内容创意】（针对每个热点的具体内容创意）：
【热点结合技巧】（如何将热点与垂直内容结合）：
【发布时机建议】（热点内容的最佳发布窗口）：
【风险提示】（哪些热点需要谨慎借势）：`;
  try {
    const result = await callText(prompt, 2, req.user.id, '热点捕捉');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/dm — 私信回复（1积分）
router.post('/dm', auth, async (req, res) => {
  const { content, goal = '引导购买' } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: '请输入私信内容' });
  const prompt = `你是一位擅长私信转化的自媒体运营专家，请针对以下私信内容生成5条回复话术。

私信内容：${content.trim()}
回复目的：${goal}

要求：
1. 回复真诚自然，不显得刻意推销
2. 针对用户需求给出有价值的回应
3. 自然引导向${goal}的方向
4. 每条回复控制在100字以内
5. 每条回复单独一行，前面加序号`;
  try {
    const result = await callText(prompt, 1, req.user.id, '私信回复');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/publish — 发布建议（1积分）
router.post('/publish', auth, async (req, res) => {
  const { niche, platform = '抖音' } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入账号定位' });
  const prompt = `你是一位${platform}平台算法和运营专家，请为以下账号定位提供详细的发布策略建议。

账号定位：${niche.trim()}
目标平台：${platform}

请输出：
【最佳发布时间】（每天哪些时间段发布效果最好，及原因）：
【发布频率建议】（每周发布几条最合适）：
【内容比例建议】（不同类型内容的比例，如干货:娱乐:互动）：
【标题优化技巧】（针对该平台的标题写作要点）：
【封面设计建议】（封面图的设计要点）：
【冷启动策略】（新账号或低流量账号的破局方法）：`;
  try {
    const result = await callText(prompt, 1, req.user.id, '发布建议');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/image — AI生图（3积分，游客可体验1次）
router.post('/image', async (req, res) => {
  const { prompt: userPrompt } = req.body;
  if (!userPrompt?.trim()) return res.status(400).json({ message: '请输入图片描述' });

  const clientIP = getClientIP(req);
  const userId = verifyToken(req);
  const isGuest = !userId;
  const isApiKeyGuest = !!req.apiKeyGuest;

  // 游客模式处理（API Key 游客不受体验次数限制）
  if (isGuest && !isApiKeyGuest) {
    const guestRecord = guestImageExperiences.get(clientIP);
    if (guestRecord && guestRecord.count >= 1) {
      return res.status(403).json({
        message: '您已用完免费体验次数，请登录或输入 API Key 继续使用',
        code: 'GUEST_USED',
        needLogin: true,
        needApiKey: true
      });
    }

    // 记录游客体验
    guestImageExperiences.set(clientIP, {
      count: (guestRecord?.count || 0) + 1,
      lastTime: new Date()
    });

    console.log(`[游客体验-AI图片] IP: ${clientIP}, 第${(guestRecord?.count || 0) + 1}/1次`);
  }

  try {
    const imageCost = parseInt(await getSettingCached('cost_image_generate', '1')) || 1; // was hardcoded: 3
    const url = await callImage(userPrompt.trim(), imageCost, userId, 'AI生图');
    res.json({ url });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 生图失败，请稍后重试' });
  }
});

// POST /api/aitools/drama — 短剧剧本（3积分）
router.post('/drama', auth, async (req, res) => {
  const { title, genre = '都市情感', episodes = '1', synopsis } = req.body;
  if (!title?.trim()) return res.status(400).json({ message: '请输入剧本标题或主题' });
  const prompt = `你是一位专业的短剧编剧，请为以下主题创作一个完整的短剧剧本。

剧本标题：${title.trim()}
题材类型：${genre}
集数：第${episodes}集
${synopsis ? `故事梗概：${synopsis.trim()}` : ''}

请按以下格式输出完整剧本：
【剧本信息】
标题：
类型：
集数：
时长：约X分钟

【人物介绍】
（列出主要角色，每人一行，含姓名、年龄、性格特点）

【剧情梗概】
（100字以内概述本集剧情）

【正文剧本】
（按场景分段，格式如下）
第X场 场景名称（室内/室外，时间）
（场景描述）
人物名：（动作）"台词"
...

【结尾钩子】
（本集结尾悬念或下集预告）`;
  try {
    const result = await callText(prompt, 3, req.user.id, 'AI短剧剧本');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/manga-script — 漫剧剧本（3积分）
router.post('/manga-script', auth, async (req, res) => {
  const { title, genre = '校园青春', pages = '20', synopsis } = req.body;
  if (!title?.trim()) return res.status(400).json({ message: '请输入漫剧标题或主题' });
  const prompt = `你是一位专业的漫剧编剧，请为以下主题创作一个完整的漫剧分镜剧本。

漫剧标题：${title.trim()}
题材类型：${genre}
页数：约${pages}页
${synopsis ? `故事梗概：${synopsis.trim()}` : ''}

请按以下格式输出漫剧剧本：
【作品信息】
标题：
类型：
目标读者：
风格基调：

【人物设定】
（主要角色外形、性格、关系）

【本话剧情】
（简述本话故事线）

【分镜脚本】
（每页分镜，格式如下）
第X页（共X格）
- 第1格：画面描述 | 台词/旁白："..."
- 第2格：画面描述 | 台词："..."
...

【情感节拍】
（标注本话的情绪高潮点和转折点）`;
  try {
    const result = await callText(prompt, 3, req.user.id, 'AI漫剧剧本');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/movie-script — 电影剧本（5积分）
router.post('/movie-script', auth, async (req, res) => {
  const { title, genre = '剧情', synopsis, stage = '大纲' } = req.body;
  if (!title?.trim()) return res.status(400).json({ message: '请输入电影标题或主题' });
  const stagePrompts = {
    '大纲': `请输出：
【故事大纲】（300字以内，含起承转合）
【三幕结构】
- 第一幕（建置）：
- 第二幕（对抗）：
- 第三幕（结局）：
【主要人物】（3-5个核心角色）
【核心冲突】
【主题立意】`,
    '场景': `请输出5个关键场景的详细剧本，格式如下：
场景X：场景名称
INT./EXT. 地点 - 时间
（场景描述）
人物名
台词
（动作描述）`,
    '对白': `请重点创作核心对白，输出3-5段精彩对话，每段对话前说明情境背景，展现人物性格和戏剧冲突。`,
  };
  const prompt = `你是一位专业的电影编剧，请为以下电影创作${stage}。

电影标题：${title.trim()}
类型：${genre}
${synopsis ? `故事概念：${synopsis.trim()}` : ''}

${stagePrompts[stage] || stagePrompts['大纲']}`;
  try {
    const result = await callText(prompt, 5, req.user.id, 'AI电影剧本');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/variety-script — 综艺/微综艺剧本（3积分）
router.post('/variety-script', auth, async (req, res) => {
  const { title, type = '探店', guests = '2', duration = '15' } = req.body;
  if (!title?.trim()) return res.status(400).json({ message: '请输入综艺主题' });
  const prompt = `你是一位专业的综艺节目编剧，请为以下微综艺创作完整的节目脚本。

节目主题：${title.trim()}
节目类型：${type}
嘉宾人数：${guests}人
时长：约${duration}分钟

请输出：
【节目信息】
节目名称：
节目类型：
核心看点：

【节目流程】
（分段列出节目环节，含时间分配）

【详细脚本】
（按环节展开，包含：主持人台词、嘉宾互动引导、镜头建议、字幕提示）

【亮点设计】
（设计3个节目高光时刻）

【结尾设计】
（节目收尾和下期预告）`;
  try {
    const result = await callText(prompt, 3, req.user.id, 'AI综艺脚本');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/ad-script — 广告剧本（2积分）
router.post('/ad-script', auth, async (req, res) => {
  const { product, duration = '15', style = '情感共鸣' } = req.body;
  if (!product?.trim()) return res.status(400).json({ message: '请输入产品或品牌信息' });
  const prompt = `你是一位顶级广告创意总监，请为以下产品创作一支${duration}秒的广告剧本。

产品/品牌：${product.trim()}
广告时长：${duration}秒
创意风格：${style}

请输出：
【创意概念】（一句话核心创意）
【目标受众】
【情绪基调】

【分镜剧本】
时间轴 | 画面 | 声音/台词 | 字幕
0-Xs  | 画面描述 | 台词/音乐 | 字幕文字
...

【核心文案】（广告语/slogan）
【投放建议】（适合平台和时段）`;
  try {
    const result = await callText(prompt, 2, req.user.id, 'AI广告剧本');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/account-diagnose — 账号定位诊断（3积分）
router.post('/account-diagnose', auth, async (req, res) => {
  const { name, niche, platform = '抖音' } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入账号定位' });
  const prompt = `你是一位顶级自媒体账号运营顾问，请对以下${platform}账号进行全面的定位诊断和策略建议。

账号名称：${name?.trim() || '未提供'}
账号定位/内容方向：${niche.trim()}
目标平台：${platform}

请输出：
【定位评估】（评估当前定位的清晰度、差异化程度、市场空间）
【目标人群画像】（核心用户年龄、性别、职业、痛点、需求）
【定位优化建议】（如何让定位更精准、更有竞争力）
【差异化策略】（与同类账号的差异化方向，3个具体建议）
【变现路径规划】（适合该定位的3-5种变现方式）
【冷启动建议】（新账号前30天的具体行动计划）
【风险提示】（该定位的潜在风险和注意事项）`;
  try {
    const result = await callText(prompt, 3, req.user.id, '账号定位诊断');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/competitor-analysis — 竞品分析（3积分）
router.post('/competitor-analysis', auth, async (req, res) => {
  const { competitor, niche, platform = '抖音' } = req.body;
  if (!competitor?.trim()) return res.status(400).json({ message: '请输入竞品账号信息' });
  const prompt = `你是一位专业的自媒体竞品分析师，请对以下竞品账号进行深度分析，并给出超越策略。

竞品账号特征：${competitor.trim()}
我的账号领域：${niche?.trim() || '同领域'}
分析平台：${platform}

请输出：
【竞品内容策略分析】（内容类型、更新频率、爆款规律）
【竞品流量来源分析】（主要流量来源和获客方式）
【竞品变现模式分析】（变现方式和商业模式）
【竞品优势总结】（值得学习的3个核心优势）
【竞品弱点分析】（可以突破的3个薄弱环节）
【差异化超越策略】（5个具体的差异化方向）
【内容借鉴建议】（可以参考但需要创新的内容形式）
【行动计划】（近期可执行的3个具体动作）`;
  try {
    const result = await callText(prompt, 3, req.user.id, '竞品分析');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/content-calendar — 内容日历生成（3积分）
router.post('/content-calendar', auth, async (req, res) => {
  const { niche, platform = '抖音', period = '一周', goal = '涨粉' } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入账号定位' });
  const prompt = `你是一位专业的内容运营策划师，请为以下账号生成详细的内容发布日历。

账号定位：${niche.trim()}
目标平台：${platform}
规划周期：${period}
运营目标：${goal}

请按以下格式输出${period}内容日历：
【运营目标拆解】（将${goal}目标分解为可执行的内容指标）
【内容比例规划】（干货:娱乐:互动:变现 的比例建议）

【详细日历】
（每天/每周的具体安排，包含：）
- 发布时间
- 内容主题
- 内容类型（知识/娱乐/互动/变现）
- 核心卖点/钩子
- 预期效果

【爆款备选选题】（5个随时可用的备用选题）
【互动活动建议】（提升粉丝粘性的互动设计）`;
  try {
    const result = await callText(prompt, 3, req.user.id, '内容日历生成');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/viral-analysis — 爆款拆解（2积分）
router.post('/viral-analysis', auth, async (req, res) => {
  const { title, copy } = req.body;
  if (!title?.trim() && !copy?.trim()) return res.status(400).json({ message: '请输入爆款标题或文案' });
  const prompt = `你是一位爆款内容研究专家，请对以下爆款内容进行深度拆解分析。

爆款标题：${title?.trim() || '未提供'}
爆款文案/内容：${copy?.trim() || '未提供'}

请输出：
【爆款核心要素】（让这条内容爆火的3个核心原因）
【情绪触发点】（触发了用户哪种情绪：好奇/共鸣/愤怒/感动/搞笑等）
【内容结构拆解】（开头钩子→主体内容→结尾引导 的具体写法）
【标题技巧分析】（标题用了哪些吸引点击的技巧）
【可复用的写作公式】（提炼出可以套用的内容模板）
【适用场景】（这个爆款模式适合哪些领域和主题）
【仿写示例】（用相同结构写一个不同主题的示例）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '爆款拆解');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/topic-matrix — 选题矩阵（3积分）
router.post('/topic-matrix', auth, async (req, res) => {
  const { niche, platform = '抖音' } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入账号定位' });
  const prompt = `你是一位内容策略专家，请为以下账号生成完整的选题矩阵。

账号定位：${niche.trim()}
目标平台：${platform}

请按四个维度生成选题矩阵，每个维度给出8个具体选题：

【痛点解决型选题】（解决用户核心痛点，高转化）
（列出8个具体选题，标注预期完播率）

【干货知识型选题】（提供实用价值，建立专业形象）
（列出8个具体选题，标注适合的内容形式）

【娱乐共鸣型选题】（引发情感共鸣，提升传播性）
（列出8个具体选题，标注情绪触发点）

【变现转化型选题】（自然植入产品/服务，促进转化）
（列出8个具体选题，标注变现方式）

【选题优先级建议】（哪类选题应该优先做，原因是什么）
【爆款概率排行】（以上32个选题中，最有爆款潜力的TOP5）`;
  try {
    const result = await callText(prompt, 3, req.user.id, '选题矩阵');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/comment-batch — 批量评论话术（2积分）
router.post('/comment-batch', auth, async (req, res) => {
  const { niche, style = '亲切互动' } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入账号领域' });
  const prompt = `你是一位擅长粉丝运营的自媒体博主，请为${niche.trim()}领域的账号生成一套完整的评论区话术库。

话术风格：${style}

请输出以下类型的话术，每类5条：

【置顶评论话术】（引导互动、增加停留时长的置顶评论）
【回复夸奖评论】（粉丝说"好棒""学到了"等正面评论的回复）
【回复质疑评论】（粉丝提出质疑或不同意见时的回复）
【回复求资源评论】（粉丝求链接、资料、方法的回复）
【引导关注话术】（自然引导用户关注的评论话术）
【引导转发话术】（鼓励用户转发分享的话术）
【活动互动话术】（发起投票、提问、抽奖等互动的话术）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '批量评论话术');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/fan-dm — 粉丝私信模板（2积分）
router.post('/fan-dm', auth, async (req, res) => {
  const { niche, goal = '引导购买' } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入账号领域' });
  const prompt = `你是一位私域运营专家，请为${niche.trim()}领域的账号生成一套完整的私信话术模板库。

运营目标：${goal}

请输出以下场景的私信模板，每类3条：

【新粉欢迎私信】（新粉丝关注后的自动欢迎语）
【活动通知私信】（通知粉丝参与活动/直播的私信）
【福利发放私信】（发送资料包/优惠券等福利的私信）
【转化引导私信】（引导粉丝${goal}的私信）
【沉默粉丝唤醒】（唤醒长期未互动粉丝的私信）
【VIP客户维护】（维护高价值粉丝关系的私信）

要求：每条私信自然真诚，不显得机械，控制在100字以内。`;
  try {
    const result = await callText(prompt, 2, req.user.id, '粉丝私信模板');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/live-warmup — 直播预热文案（2积分）
router.post('/live-warmup', auth, async (req, res) => {
  const { topic, time, platform = '抖音' } = req.body;
  if (!topic?.trim()) return res.status(400).json({ message: '请输入直播主题' });
  const prompt = `你是一位直播运营专家，请为以下直播生成完整的预热推广文案。

直播主题：${topic.trim()}
开播时间：${time?.trim() || '待定'}
直播平台：${platform}

请输出：
【直播预告短视频文案】（发布在${platform}的预热视频文案，含标题+正文+话题标签）

【倒计时系列文案】
- 开播前3天预告文案
- 开播前1天预告文案
- 开播当天早上预热文案
- 开播前1小时催场文案

【评论区置顶话术】（直播间引流的置顶评论）
【私信预热话术】（发给老粉丝的预热私信）
【直播间开场白】（进入直播间后的开场话术）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '直播预热文案');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/goods-script — 带货脚本（5积分）
router.post('/goods-script', auth, async (req, res) => {
  const { product, price, sellingPoints, platform = '抖音' } = req.body;
  if (!product?.trim()) return res.status(400).json({ message: '请输入商品信息' });
  const prompt = `你是一位顶级带货主播和短视频带货专家，请为以下商品创作一套完整的带货脚本。

商品名称：${product.trim()}
商品价格：${price?.trim() || '未提供'}
核心卖点：${sellingPoints?.trim() || '请根据商品名称推断'}
发布平台：${platform}

请输出完整带货脚本：

【短视频带货脚本（60秒）】
开场钩子（0-5秒）：
痛点引入（5-15秒）：
产品展示（15-40秒）：
价格促单（40-55秒）：
行动号召（55-60秒）：

【直播带货话术】
产品介绍话术（200字）：
逼单促销话术（100字）：
处理价格异议话术（100字）：
限时紧迫感话术（50字）：

【商品详情文案】（适合橱窗/详情页的200字产品描述）
【用户评价模板】（5条真实感强的好评模板）
【核心卖点提炼】（3个最打动人的卖点，每个一句话）`;
  try {
    const result = await callText(prompt, 5, req.user.id, '带货脚本');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/live-sales — 直播带货话术（5积分）
router.post('/live-sales', auth, async (req, res) => {
  const { product, price, duration = '2小时' } = req.body;
  if (!product?.trim()) return res.status(400).json({ message: '请输入商品信息' });
  const prompt = `你是一位顶级直播带货主播，请为以下商品生成一套完整的直播带货全流程话术。

商品：${product.trim()}
价格：${price?.trim() || '未提供'}
直播时长：${duration}

请输出完整直播带货话术：

【开场话术】（前5分钟，暖场+引流+建立信任）

【产品介绍话术】（详细介绍产品，突出卖点和使用场景）

【互动话术】（每隔10分钟的互动设计，保持直播间活跃）

【逼单话术】（制造紧迫感，促进下单）
- 限时话术：
- 限量话术：
- 价格对比话术：
- 从众心理话术：

【处理异议话术】
- 太贵了：
- 效果不好怎么办：
- 我再想想：
- 别家更便宜：

【福利发放话术】（发优惠券/抽奖/送礼品的话术）

【结尾留存话术】（下播前留住粉丝、预告下次直播）`;
  try {
    const result = await callText(prompt, 5, req.user.id, '直播带货话术');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/cover-copy — 封面文案生成（1积分）
router.post('/cover-copy', auth, async (req, res) => {
  const { topic, style = '冲击力强' } = req.body;
  if (!topic?.trim()) return res.status(400).json({ message: '请输入视频主题' });
  const prompt = `你是一位短视频封面文案专家，请为以下视频主题生成10个高点击率的封面文案。

视频主题：${topic.trim()}
文案风格：${style}

要求：
1. 每条文案控制在10字以内
2. 要有强烈的视觉冲击力和点击欲望
3. 可以使用数字、疑问、反转、悬念等技巧
4. 适合直接印在封面图上
5. 覆盖不同风格：数字冲击型、疑问悬念型、情感共鸣型、利益驱动型

直接输出10条封面文案，每条一行，前面加序号。`;
  try {
    const result = await callText(prompt, 1, req.user.id, '封面文案生成');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/platform-adapt — 多平台适配改写（2积分）
router.post('/platform-adapt', auth, async (req, res) => {
  const { content, from = '抖音', targets } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: '请输入原始文案' });
  const targetList = targets || ['小红书', '视频号', '快手'];
  const prompt = `你是一位多平台内容运营专家，请将以下${from}文案改写为适合其他平台的版本。

原始文案（${from}风格）：
${content.trim()}

请分别改写为以下平台的版本：
${targetList.map(t => `
【${t}版本】
（根据${t}平台特点和用户习惯进行改写，包含适合该平台的标题、正文和话题标签）`).join('')}

改写要求：
- 小红书：加emoji、口语化、种草感强、配图建议
- 抖音：开头强钩子、节奏快、互动引导
- 视频号：偏正式、适合中年用户、有深度
- 快手：接地气、真实感、下沉市场风格
- B站：详细、有深度、弹幕互动设计`;
  try {
    const result = await callText(prompt, 2, req.user.id, '多平台适配改写');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/seo-keywords — SEO关键词提取（1积分）
router.post('/seo-keywords', auth, async (req, res) => {
  const { content, platform = '抖音' } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: '请输入文案内容' });
  const prompt = `你是一位${platform}平台SEO优化专家，请从以下内容中提取和扩展最优搜索关键词。

内容：${content.trim()}
目标平台：${platform}

请输出：
【核心关键词】（5个最重要的搜索关键词，搜索量大）
【长尾关键词】（10个精准长尾词，竞争小转化高）
【相关搜索词】（10个用户可能搜索的相关词）
【关键词布局建议】（如何在标题、文案、评论中布局这些关键词）
【搜索流量预估】（各关键词的搜索热度评级：高/中/低）
【优化后标题建议】（含关键词的3个优化标题）`;
  try {
    const result = await callText(prompt, 1, req.user.id, 'SEO关键词提取');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/data-insight — 发布数据解读（2积分）
router.post('/data-insight', auth, async (req, res) => {
  const { likes, comments, favorites, completionRate, rate3s, platform = '抖音', niche = '' } = req.body;
  const prompt = `你是一位${platform}数据分析专家，请根据以下视频数据给出深度分析和优化建议。

视频数据：
- 点赞数：${likes || 0}
- 评论数：${comments || 0}
- 收藏数：${favorites || 0}
- 完播率：${completionRate || 0}%
- 3秒完播率：${rate3s || 0}%
- 账号领域：${niche || '未提供'}
- 发布平台：${platform}

请输出：
【数据健康度评估】（综合评分1-10分，及评级：优秀/良好/一般/需改进）
【各指标分析】
- 点赞率分析：（结合行业均值评估）
- 完播率分析：（完播率说明了什么问题）
- 互动率分析：（评论/收藏比例是否健康）
【核心问题诊断】（数据反映出的1-3个主要问题）
【优化建议】
- 提升完播率的具体方法
- 提升互动率的具体方法
- 提升点赞收藏的具体方法
【下一条视频建议】（基于此次数据，下一条视频应该怎么做）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '发布数据解读');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/title-ab — 标题A/B测试（2积分）
router.post('/title-ab', auth, async (req, res) => {
  const { title, platform = '抖音' } = req.body;
  if (!title?.trim()) return res.status(400).json({ message: '请输入原始标题' });
  const prompt = `你是一位${platform}爆款标题专家，请对以下标题进行A/B测试优化，生成多个变体并分析各自优劣。

原始标题：${title.trim()}
目标平台：${platform}

请输出：

【原始标题分析】
- 优点：
- 不足：
- 预估点击率：低/中/高

【A/B测试变体】（生成5个不同方向的变体标题）

变体A（数字冲击型）：
- 标题：
- 核心技巧：
- 预估点击率：

变体B（疑问悬念型）：
- 标题：
- 核心技巧：
- 预估点击率：

变体C（情感共鸣型）：
- 标题：
- 核心技巧：
- 预估点击率：

变体D（利益驱动型）：
- 标题：
- 核心技巧：
- 预估点击率：

变体E（反转对比型）：
- 标题：
- 核心技巧：
- 预估点击率：

【推荐使用】（最推荐哪个变体，原因是什么）
【测试建议】（如何进行实际A/B测试）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '标题AB测试');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/wechat-moments — 朋友圈文案（1积分）
router.post('/wechat-moments', auth, async (req, res) => {
  const { product, goal = '产品推广', style = '自然真实' } = req.body;
  if (!product?.trim()) return res.status(400).json({ message: '请输入产品或主题' });
  const prompt = `你是一位擅长朋友圈营销的自媒体运营专家，请为以下内容生成5条自然不硬广的朋友圈文案。

产品/主题：${product.trim()}
推广目标：${goal}
文案风格：${style}

要求：
1. 以第一人称真实体验感受为主，不像广告
2. 融入生活场景，让人感同身受
3. 结尾自然引导互动或咨询，不强硬推销
4. 每条100字以内，配图建议一并给出
5. 五条风格各异：生活感悟型/产品体验型/朋友推荐型/问题解决型/成果展示型
6. 每条用"---"分隔`;
  try {
    const result = await callText(prompt, 1, req.user.id, '朋友圈文案');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/article-to-scripts — 长文转短视频脚本（3积分）
router.post('/article-to-scripts', auth, async (req, res) => {
  const { article, count = '3' } = req.body;
  if (!article?.trim()) return res.status(400).json({ message: '请输入文章内容' });
  const prompt = `你是一位专业的短视频内容策划，请将以下长文章拆解为${count}条独立的短视频脚本。

原文内容：
${article.trim()}

要求：
1. 每条脚本可以独立成片，不依赖其他视频
2. 每条脚本60秒左右（约250字口播）
3. 保留原文核心观点，用口语化方式重新表达
4. 每条脚本包含：【标题】【开场钩子】【主体内容】【结尾引导】
5. 脚本之间用"===第X条==="分隔
6. 最后给出【系列发布建议】（发布顺序和间隔）`;
  try {
    const result = await callText(prompt, 3, req.user.id, '长文转短视频脚本');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/content-score — 内容质量评分（1积分）
router.post('/content-score', auth, async (req, res) => {
  const { content, type = '短视频文案', platform = '抖音' } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: '请输入内容' });
  const prompt = `你是一位${platform}平台的内容质量评审专家，请对以下${type}进行全面评分和改进建议。

内容：
${content.trim()}

请按以下维度评分（每项1-10分）并给出详细分析：

【综合评分】：X/10
【各维度评分】
- 标题吸引力：X/10（分析原因）
- 开头钩子：X/10（分析原因）
- 内容价值：X/10（分析原因）
- 语言表达：X/10（分析原因）
- 互动引导：X/10（分析原因）
- 平台适配度：X/10（分析原因）

【主要优点】（3条）
【核心问题】（3条）
【改进建议】（具体可执行的3个改进方向）
【优化版本】（根据建议直接给出一个优化后的版本）`;
  try {
    const result = await callText(prompt, 1, req.user.id, '内容质量评分');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/subtitle-polish — 字幕文案优化（1积分）
router.post('/subtitle-polish', auth, async (req, res) => {
  const { subtitle } = req.body;
  if (!subtitle?.trim()) return res.status(400).json({ message: '请输入字幕内容' });
  const prompt = `你是一位专业的短视频字幕编辑，请对以下字幕进行全面优化。

原始字幕：
${subtitle.trim()}

请输出优化后的字幕，要求：
1. 修正错别字和语法错误
2. 优化断句，让每句话更自然流畅
3. 在适当位置加入表情符号增强表达（不要过多）
4. 强调词用【】标注，停顿用…标注
5. 删除口头禅（嗯、啊、那个、就是说等）
6. 保持原意不变，只优化表达方式

【优化后字幕】：
（直接输出优化后的完整字幕）

【修改说明】：
（简要说明主要修改了哪些地方）`;
  try {
    const result = await callText(prompt, 1, req.user.id, '字幕文案优化');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/style-rewrite — 风格迁移改写（2积分）
router.post('/style-rewrite', auth, async (req, res) => {
  const { content, targetStyle } = req.body;
  if (!content?.trim() || !targetStyle?.trim()) return res.status(400).json({ message: '请输入内容和目标风格' });
  const prompt = `你是一位擅长模仿各种写作风格的文案专家，请将以下内容改写为指定风格。

原始内容：
${content.trim()}

目标风格：${targetStyle.trim()}

要求：
1. 深度模仿目标风格的语言习惯、句式结构、情绪表达
2. 保留原内容的核心信息和观点
3. 让读者感觉就是该风格博主写的
4. 输出3个不同程度的改写版本（轻度/中度/深度），用"---"分隔
5. 每个版本前标注改写程度和主要风格特征`;
  try {
    const result = await callText(prompt, 2, req.user.id, '风格迁移改写');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/community-sop — 私域社群运营方案（3积分）
router.post('/community-sop', auth, async (req, res) => {
  const { niche, goal = '转化付费', size = '100人以内' } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入账号领域' });
  const prompt = `你是一位私域社群运营专家，请为以下账号设计完整的社群运营 SOP。

账号领域：${niche.trim()}
社群目标：${goal}
社群规模：${size}

请输出完整社群运营方案：

【社群定位】（社群价值主张和差异化）
【入群欢迎流程】
- 入群欢迎语（自动回复）
- 群规设计
- 新人破冰话术

【日常运营节奏】（每天/每周的内容安排）
- 早安话术
- 日常内容推送
- 互动活动设计
- 晚间总结

【活跃度维护方案】
- 每周固定活动（3个）
- 沉默用户唤醒策略
- 群内KOL培养方法

【转化节奏设计】
- 信任建立期（1-7天）
- 价值输出期（7-14天）
- 转化促单期（14天后）
- 具体转化话术

【危机处理预案】（负面评价/退群/投诉的处理方式）`;
  try {
    const result = await callText(prompt, 3, req.user.id, '私域社群运营方案');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/knowledge-product — 知识付费产品设计（3积分）
router.post('/knowledge-product', auth, async (req, res) => {
  const { niche, audience = '普通用户', budget = '中等' } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入领域' });
  const prompt = `你是一位知识付费产品设计专家，请为以下领域设计完整的知识付费产品体系。

领域：${niche.trim()}
目标用户：${audience}
用户预算：${budget}

请输出完整产品设计方案：

【产品矩阵设计】（从低到高的产品梯队）
- 免费引流产品（吸引潜在用户）
- 低价入门产品（9.9-99元，建立信任）
- 核心付费产品（99-999元，主要收入）
- 高端服务产品（999元+，高价值用户）

【核心产品详细设计】
- 产品名称和定位
- 课程/训练营结构（目录大纲）
- 核心卖点（3个）
- 定价策略和理由
- 交付方式

【销售文案框架】
- 产品标题
- 痛点描述
- 解决方案
- 价值证明
- 价格锚定
- 行动号召

【推广策略】（如何通过短视频/直播推广该产品）
【定价建议】（参考市场行情的具体定价建议）`;
  try {
    const result = await callText(prompt, 3, req.user.id, '知识付费产品设计');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/series-plan — 系列内容规划（2积分）
router.post('/series-plan', auth, async (req, res) => {
  const { niche, seriesType = '30天挑战', platform = '抖音' } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入账号领域' });
  const prompt = `你是一位内容IP策划专家，请为以下账号设计一个完整的系列内容IP。

账号领域：${niche.trim()}
系列类型：${seriesType}
目标平台：${platform}

请输出完整系列内容规划：

【系列IP设计】
- 系列名称（有记忆点，易传播）
- 系列定位和核心价值
- 目标受众
- 差异化亮点

【内容结构设计】
- 系列集数/期数规划
- 每集内容框架（固定结构）
- 开篇集内容（第1集详细策划）
- 结尾集设计（如何收尾和引导下一系列）

【详细内容清单】（列出每集的具体主题和核心内容）

【传播设计】
- 系列话题标签
- 每集固定互动设计
- 粉丝参与机制
- 跨平台联动方案

【变现设计】（如何在系列中自然植入变现）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '系列内容规划');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/topic-bank — 选题库生成（3积分）
router.post('/topic-bank', auth, async (req, res) => {
  const { niche, platform = '抖音' } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入账号领域' });
  const prompt = `你是一位${platform}内容策划专家，请为以下账号一次性生成50个高质量选题，并进行分类评级。

账号领域：${niche.trim()}
目标平台：${platform}

请按以下分类输出50个选题：

【爆款潜力选题】（10个，预估高流量）
（每个选题格式：序号. 选题标题 | 内容类型 | 爆款理由）

【干货知识选题】（10个，建立专业形象）
（每个选题格式：序号. 选题标题 | 核心知识点 | 目标人群）

【情感共鸣选题】（10个，提升粉丝粘性）
（每个选题格式：序号. 选题标题 | 情绪触发点 | 互动引导）

【热点借势选题】（10个，蹭流量）
（每个选题格式：序号. 选题标题 | 借势热点 | 结合方式）

【变现转化选题】（10个，促进销售）
（每个选题格式：序号. 选题标题 | 植入产品/服务 | 转化方式）

【TOP10推荐】（从以上50个中选出最值得优先做的10个，说明理由）`;
  try {
    const result = await callText(prompt, 3, req.user.id, '选题库生成');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/monthly-review — 月度运营复盘（3积分）
router.post('/monthly-review', auth, async (req, res) => {
  const { data, niche, platform = '抖音' } = req.body;
  if (!data?.trim()) return res.status(400).json({ message: '请输入本月运营数据' });
  const prompt = `你是一位${platform}运营数据分析专家，请根据以下数据生成完整的月度运营复盘报告。

账号领域：${niche?.trim() || '未提供'}
本月数据：
${data.trim()}

请输出完整月度复盘报告：

【本月核心数据总结】
- 关键指标完成情况
- 与上月对比分析
- 行业均值对比

【本月亮点内容分析】
- 表现最好的内容类型
- 爆款内容的共同特征
- 可复制的成功经验

【本月问题诊断】
- 表现不佳的内容分析
- 流量下滑的可能原因
- 需要改进的3个核心问题

【下月运营策略】
- 内容方向调整建议
- 发布频率和时间优化
- 重点突破方向

【下月目标设定】（基于本月数据的合理目标）
【行动计划】（下月前两周的具体执行计划）`;
  try {
    const result = await callText(prompt, 3, req.user.id, '月度运营复盘');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/growth-diagnose — 涨粉瓶颈诊断（3积分）
router.post('/growth-diagnose', auth, async (req, res) => {
  const { situation, niche, platform = '抖音' } = req.body;
  if (!situation?.trim()) return res.status(400).json({ message: '请描述当前账号状态' });
  const prompt = `你是一位${platform}账号增长专家，请根据以下账号状态诊断涨粉瓶颈并给出突破方案。

账号领域：${niche?.trim() || '未提供'}
当前状态描述：
${situation.trim()}

请输出完整诊断报告：

【账号健康度评估】（综合评分1-10分）

【瓶颈类型诊断】
（判断属于以下哪种瓶颈，并详细分析原因）
- 内容质量瓶颈
- 定位不清晰瓶颈
- 算法推流瓶颈
- 竞争激烈瓶颈
- 粉丝流失瓶颈
- 变现过早瓶颈

【核心问题TOP3】（最需要解决的3个问题，按优先级排序）

【突破方案】（针对每个核心问题的具体解决方案）

【7天快速行动计划】（每天具体做什么）

【30天目标预期】（执行方案后的合理预期）
【风险提示】（执行过程中需要注意的事项）`;
  try {
    const result = await callText(prompt, 3, req.user.id, '涨粉瓶颈诊断');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/brand-proposal — 品牌合作提案（2积分）
router.post('/brand-proposal', auth, async (req, res) => {
  const { accountInfo, brandType, cooperation = '视频植入' } = req.body;
  if (!accountInfo?.trim()) return res.status(400).json({ message: '请输入账号信息' });
  const prompt = `你是一位自媒体商务合作专家，请根据以下账号信息生成一份专业的品牌合作提案。

账号信息：${accountInfo.trim()}
目标品牌类型：${brandType?.trim() || '通用品牌'}
合作形式：${cooperation}

请输出完整品牌合作提案：

【媒体资料包】
- 账号基本信息（定位/粉丝量/主要平台）
- 粉丝画像（年龄/性别/地域/消费能力）
- 内容特色和优势
- 历史合作案例（如有）

【合作方案设计】
- 合作形式详述
- 内容创作方案
- 曝光预估数据
- 交付物清单

【报价方案】（给出合理的报价区间和依据）

【合作优势】（为什么选择与你合作的3个理由）

【合作流程】（从洽谈到交���的完整流程）

【联系方式模板】（专业的商务联系邮件模板）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '品牌合作提案');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/bilibili-article — B站专栏文章（3积分）
router.post('/bilibili-article', auth, async (req, res) => {
  const { topic, style = '深度分析' } = req.body;
  if (!topic?.trim()) return res.status(400).json({ message: '请输入文章主题' });
  const prompt = `你是一位B站专栏创作者，请为以下主题创作一篇完整的B站专栏文章。

主题：${topic.trim()}
文章风格：${style}

请按以下格式输出：

【文章标题】（吸引B站用户点击，含关键词）

【封面图建议】（描述封面图内容和风格）

【文章正文】（1500-2000字，要求：）
- 开头有吸引力，让读者想继续看
- 分段清晰，每段有小标题
- 内容有深度，有独特见解
- 适当加入数据、案例、对比
- 语言风格符合B站用户习惯（可以稍微二次元/网络用语）
- 结尾引导评论互动

【互动设计】
- 文末提问（引导评论的问题）
- 弹幕互动设计（适合加弹幕的时间点和内容）

【话题标签】（10个相关标签）
【推荐专栏分区】`;
  try {
    const result = await callText(prompt, 3, req.user.id, 'B站专栏文章');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/podcast-script — 播客脚本（2积分）
router.post('/podcast-script', auth, async (req, res) => {
  const { topic, duration = '30', hosts = '1', style = '对话访谈' } = req.body;
  if (!topic?.trim()) return res.status(400).json({ message: '请输入播客主题' });
  const prompt = `你是一位专业的播客节目策划，请为以下主题创作完整的播客脚本。

主题：${topic.trim()}
时长：约${duration}分钟
主持人数：${hosts}人
节目风格：${style}

请输出完整播客脚本：

【节目信息】
- 节目名称
- 本期主题
- 核心听点（3个）

【节目结构】（时间分配）

【详细脚本】
开场（前3分钟）：
（主持人台词，含节目介绍、本期预告）

主体内容（中间${parseInt(duration)-6}分钟）：
（按话题分段，含：话题引入/核心内容/案例/观点碰撞）

广告植入（如需，约1分钟）：
（自然植入的广告话术）

结尾（最后3分钟）：
（总结/金句/下期预告/订阅引导）

【节目金句】（3-5句适合做封面/宣传的金句）
【配套文案】（发布时的节目简介，200字）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '播客脚本');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/fan-funnel — 粉丝转化漏斗（3积分）
router.post('/fan-funnel', auth, async (req, res) => {
  const { niche, product, platform = '抖音' } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入账号领域' });
  const prompt = `你是一位自媒体商业化专家，请为以下账号设计完整的粉丝转化漏斗。

账号领域：${niche.trim()}
变现产品/服务：${product?.trim() || '待定'}
主要平台：${platform}

请输出完整转化漏斗设计：

【漏斗总览】
陌生人 → 路人粉 → 铁杆粉 → 付费用户 → 复购用户

【各阶段策略】

第一层：陌生人→路人粉（引流）
- 触达渠道
- 内容钩子设计
- 关注理由

第二层：路人粉→铁杆粉（留存）
- 价值输出策略
- 粉丝粘性设计
- 信任建立方式

第三层：铁杆粉→付费用户（转化）
- 转化时机判断
- 产品/服务设计
- 转化话术

第四层：付费用户→复购用户（复购）
- 服务体验设计
- 复购触发机制
- 口碑裂变设计

【关键转化节点】（每个阶段最重要的1个动作）
【数据监控指标】（每个阶段需要追踪的核心指标）
【常见流失原因及对策】`;
  try {
    const result = await callText(prompt, 3, req.user.id, '粉丝转化漏斗');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// 使用 Puppeteer 下载视频（绕过 Cloudflare）
async function downloadVideo(url, filename) {
  const filePath = path.join(AITOOLS_DIR, filename);

  try {
    console.log('[downloadVideo] Starting Puppeteer download:', url);

    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();

    // 监听响应，获取视频数据
    let videoBuffer = null;
    page.on('response', async (response) => {
      const responseUrl = response.url();
      if (responseUrl === url && response.status() === 200) {
        try {
          videoBuffer = await response.buffer();
          console.log('[downloadVideo] Captured video buffer:', videoBuffer.length, 'bytes');
        } catch (e) {
          console.error('[downloadVideo] Failed to get buffer:', e.message);
        }
      }
    });

    // 访问视频 URL
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });

    await browser.close();

    if (!videoBuffer || videoBuffer.length === 0) {
      throw new Error('Failed to capture video data');
    }

    // 写入文件
    fs.writeFileSync(filePath, videoBuffer);
    console.log('[downloadVideo] File saved:', filePath);

    // 返回相对路径
    return path.relative(UPLOAD_DIR, filePath).replace(/\\/g, '/');

  } catch (err) {
    console.error('[downloadVideo] Download error:', err);
    throw err;
  }
}

module.exports = router;

// POST /api/aitools/hook-design — 钩子设计器（1积分）
router.post('/hook-design', auth, async (req, res) => {
  const { topic, type = '悬念型' } = req.body;
  if (!topic?.trim()) return res.status(400).json({ message: '请输入视频主题' });
  const prompt = `你是一位短视频开场钩子专家，请为以下主题生成10个高效的视频开场钩子（前3秒）。

视频主题：${topic.trim()}
钩子类型偏好：${type}

请按以下10种类型各生成1个钩子：
1. 【悬念型】制造好奇心，让人想看下去
2. 【痛点型】直击用户痛点，引发共鸣
3. 【数字型】用具体数字制造冲击
4. 【反常识型】颠覆认知，出乎意料
5. 【提问型】直接问观众，引发思考
6. 【故事型】用一句话开启故事
7. 【利益型】直接说出观看收益
8. 【对比型】before/after强烈对比
9. 【紧迫型】制造时间紧迫感
10. 【共鸣型】说出观众心里话

每个钩子控制在15字以内，直接可用，后面标注适用场景。`;
  try {
    const result = await callText(prompt, 1, req.user.id, '钩子设计器');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/ending-design — 结尾引导设计（1积分）
router.post('/ending-design', auth, async (req, res) => {
  const { topic, goal = '引导关注' } = req.body;
  if (!topic?.trim()) return res.status(400).json({ message: '请输入视频主题' });
  const prompt = `你是一位短视频结尾设计专家，请为以下视频生成10条高转化的结尾引导话术。

视频主题：${topic.trim()}
引导目标：${goal}

请按以下类型各生成2条结尾话术：
【关注引导】（自然引导用户关注）
【评论引导】（引发用户评论互动）
【转发引导】（鼓励用户分享转发）
【购买引导】（引导用户购买/咨询）
【私信引导】（引导用户发私信）

要求：
1. 语言自然，不生硬
2. 每条控制在30字以内
3. 结合视频主题，不显突兀
4. 给出配套的互动问题或行动指令`;
  try {
    const result = await callText(prompt, 1, req.user.id, '结尾引导设计');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/pain-point — 痛点挖掘（2积分）
router.post('/pain-point', auth, async (req, res) => {
  const { audience, niche } = req.body;
  if (!audience?.trim()) return res.status(400).json({ message: '请输入目标人群' });
  const prompt = `你是一位用户心理研究专家，请深度挖掘以下目标人群的痛点、痒点和爽点。

目标人群：${audience.trim()}
内容领域：${niche?.trim() || '通用'}

请输出完整的用户需求地图：

【核心痛点】（最深层的问题和困扰，5个）
每个痛点格式：痛点描述 | 情绪强度（高/中/低）| 触发场景

【表层痒点】（用户想要但不紧迫的需求，5个）
每个痒点格式：痒点描述 | 满足方式 | 内容切入角度

【爽点设计】（能让用户立刻爽到的内容设计，5个）
每个爽点格式：爽点描述 | 内容形式 | 预期反应

【用户内心独白】（用第一人称写出用户的真实心声，3段）

【内容创作建议】（基于以上分析，给出5个最有爆款潜力的内容方向）

【禁忌雷区】（该人群最反感的内容类型，3个）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '痛点挖掘');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/comment-topic — 评论区话题设计（1积分）
router.post('/comment-topic', auth, async (req, res) => {
  const { topic, platform = '抖音' } = req.body;
  if (!topic?.trim()) return res.status(400).json({ message: '请输入视频主题' });
  const prompt = `你是一位${platform}评论区运营专家，请为以下视频设计能引爆评论区的话题和互动设计。

视频主题：${topic.trim()}
目标平台：${platform}

请输出：
【置顶评论话题】（5条能引发大量回复的置顶评论）
- 投票类：（让用户选A或B）
- 争议类：（引发讨论的观点）
- 提问类：（让用户分享经历）
- 共鸣类：（说出用户心声）
- 挑战类：（发起互动挑战）

【评论区互动设计】
- 最佳互动问题（3个，预计回复率最高）
- 争议话题设计（1个，能引发正反讨论）
- 彩蛋设计（隐藏在评论区的福利/彩蛋）

【评论区运营节奏】
- 发布后1小时内：如何快速积累评论
- 发布后24小时：如何维持评论热度
- 高赞评论引导：如何引导出高质量评论`;
  try {
    const result = await callText(prompt, 1, req.user.id, '评论区话题设计');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/user-testimonial — 用户证言模板（1积分）
router.post('/user-testimonial', auth, async (req, res) => {
  const { product, result: userResult, audience = '普通用户' } = req.body;
  if (!product?.trim()) return res.status(400).json({ message: '请输入产品或服务' });
  const prompt = `你是一位擅长用户故事写作的营销专家，请为以下产品生成10条真实感强的用户证言模板。

产品/服务：${product.trim()}
用户成果：${userResult?.trim() || '使用后效果明显改善'}
目标用户群：${audience}

请生成10条不同类型的用户证言，每条包含：
- 用户背景（简短描述，增加真实感）
- 使用前状态（痛点描述）
- 使用过程（简短）
- 使用后成果（具体数据/变化）
- 推荐语（自然真诚）

类型覆盖：
1-3条：数据型（有具体数字）
4-6条：故事型（有情节转折）
7-8条：对比型（before/after）
9-10条：情感型（情感共鸣）

要求：真实自然，避免夸大，每条100字以内。`;
  try {
    const result = await callText(prompt, 1, req.user.id, '用户证言模板');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/ai-continue — AI续写（2积分）
router.post('/ai-continue', auth, async (req, res) => {
  const { content, style = '保持原风格' } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: '请输入开头内容' });
  const prompt = `你是一位专业的内容创作者，请根据以下开头续写完整内容。

已有内容：
${content.trim()}

续写风格：${style}

要求：
1. 无缝衔接，风格一致，读者感觉不到断点
2. 续写内容是原内容的2-3倍长度
3. 保持原有的语气、节奏和表达习惯
4. 内容完整，有清晰的结尾
5. 输出3个不同方向的续写版本，用"===版本X==="分隔
6. 每个版本前标注续写方向（如：深度展开型/情节转折型/总结升华型）`;
  try {
    const result = await callText(prompt, 2, req.user.id, 'AI续写');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/viral-elements — 爆款元素提取（2积分）
router.post('/viral-elements', auth, async (req, res) => {
  const { contents } = req.body;
  if (!contents?.trim()) return res.status(400).json({ message: '请输入多条爆款内容' });
  const prompt = `你是一位爆款内容研究专家，请分析以下多条爆款内容，提炼共同规律和可复用公式。

爆款内容集合：
${contents.trim()}

请输出深度分析报告：

【共同爆款元素】（这些内容共有的核心要素，5-8个）

【标题规律】（标题的共同写法和技巧）

【内容结构公式】（可复用的内容框架）

【情绪触发规律】（触发了哪些共同情绪）

【关键词规律】（高频出现的词汇和表达）

【可复用写作公式】（提炼出3个直接可套用的模板）
模板格式：[公式名称] + [公式结构] + [填空示例]

【适用领域】（这套公式最适合哪些内容领域）

【实战建议】（如何用这些规律创作下一条爆款）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '爆款元素提取');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/content-expand — 内容扩写（1积分）
router.post('/content-expand', auth, async (req, res) => {
  const { content, targetLength = '300字', style = '保持原风格' } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: '请输入需要扩写的内容' });
  const prompt = `你是一位专业文案扩写专家，请将以下简短内容扩写为${targetLength}的完整版本。

原始内容：
${content.trim()}

扩写风格：${style}
目标字数：${targetLength}

要求：
1. 保留原内容的核心观点和关键信息
2. 通过增加细节、案例、数据、场景描述来扩充内容
3. 逻辑清晰，层次分明
4. 语言流畅自然，不显堆砌
5. 直接输出扩写后的完整内容`;
  try {
    const result = await callText(prompt, 1, req.user.id, '内容扩写');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/content-compress — 内容压缩（1积分）
router.post('/content-compress', auth, async (req, res) => {
  const { content, versions = '50字/100字/200字' } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: '请输入需要压缩的内容' });
  const prompt = `你是一位专业文案压缩专家，请将以下内容压缩为不同字数的版本，适配不同平台需求。

原始内容：
${content.trim()}

请输出以下版本：
【50字版本】（适合封面文案/标题）
【100字版本】（适合抖音/快手简介）
【200字版本】（适合小红书/视频号）
【完整精简版】（删除冗余，保留核心，不限字数）

要求：
1. 每个版本都要保留最核心的信息
2. 语言精炼，每个字都有价值
3. 不同版本风格可以略有调整以适配平台`;
  try {
    const result = await callText(prompt, 1, req.user.id, '内容压缩');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/fan-portrait — 粉丝画像分析（2积分）
router.post('/fan-portrait', auth, async (req, res) => {
  const { accountInfo, platform = '抖音' } = req.body;
  if (!accountInfo?.trim()) return res.status(400).json({ message: '请输入账号信息' });
  const prompt = `你是一位${platform}用户研究专家，请根据以下账号信息推断粉丝画像并给出针对性运营建议。

账号信息：${accountInfo.trim()}
目标平台：${platform}

请输出完整粉丝画像报告：

【核心粉丝画像】
- 年龄分布：
- 性别比例：
- 地域分布：
- 职业构成：
- 消费能力：
- 活跃时间：

【粉丝心理特征】
- 关注动机（为什么关注你）
- 内容偏好（喜欢看什么类型）
- 互动习惯（如何与内容互动）
- 消费决策特点

【粉丝需求分析】
- 核心需求（3个）
- 潜在需求（3个）
- 未被满足的需求（机会点）

【针对性运营建议】
- 内容策略调整（5条）
- 互动方式优化（3条）
- 变现路径建议（3条）
- 发布时间优化

【粉丝分层运营】（如何对不同层级粉丝差异化运营）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '粉丝画像分析');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/cold-start — 冷启动方案（3积分）
router.post('/cold-start', auth, async (req, res) => {
  const { niche, platform = '抖音', background = '普通人' } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入账号领域' });
  const prompt = `你是一位${platform}账号冷启动专家，请为以下新账号制定详细的前30天冷启动计划。

账号领域：${niche.trim()}
目标平台：${platform}
创作者背景：${background}

请输出完整冷启动方案：

【账号基础搭建】（第1-3天）
- 账号名称建议（3个）
- 头像和简介优化
- 账号标签设置
- 初始内容规划

【第一周计划】（第1-7天）
- 每天发布内容主题
- 内容形式建议
- 互动策略
- 关键动作清单

【第二周计划】（第8-14天）
- 根据第一周数据调整方向
- 重点突破策略
- 涨粉加速方法

【第三四周计划】（第15-30天）
- 内容矩阵建立
- 粉丝互动深化
- 初步变现准备

【关键成功指标】（每周应达到的数据目标）
【常见踩坑预警】（新号最容易犯的5个错误）
【快速起号技巧】（3个能快速获得第一批粉丝的方法）`;
  try {
    const result = await callText(prompt, 3, req.user.id, '冷启动方案');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/growth-activity — 涨粉活动策划（2积分）
router.post('/growth-activity', auth, async (req, res) => {
  const { niche, platform = '抖音', type = '转发抽奖' } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入账号领域' });
  const prompt = `你是一位${platform}涨粉活动策划专家，请为以下账号策划一场高效的涨粉活动。

账号领域：${niche.trim()}
目标平台：${platform}
活动类型：${type}

请输出完整活动策划方案：

【活动概述】
- 活动名称（有记忆点）
- 活动主题和核心卖点
- 预期涨粉目标

【活动规则设计】
- 参与门槛（关注/转发/评论等）
- 奖品设置（与账号定位匹配）
- 活动时间安排
- 获奖规则

【活动文案】
- 活动发布文案（含话题标签）
- 置顶评论话术
- 私信通知模板

【推广方案】
- 活动预热（提前3天）
- 活动期间维护
- 活动结束收尾

【防刷机制】（防止虚假参与的措施）
【效果预估】（预计参与人数和涨粉数量）
【复盘指标】（活动结束后如何评估效果）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '涨粉活动策划');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/pricing-strategy — 定价策略分析（2积分）
router.post('/pricing-strategy', auth, async (req, res) => {
  const { product, cost, market } = req.body;
  if (!product?.trim()) return res.status(400).json({ message: '请输入产品信息' });
  const prompt = `你是一位定价策略专家，请为以下产品制定完整的定价策略。

产品/服务：${product.trim()}
成本参考：${cost?.trim() || '未提供'}
市场情况：${market?.trim() || '未提供'}

请输出完整定价策略报告：

【市场定价参考】（同类产品的市场价格区间）

【定价策略建议】
- 推荐定价：X元（详细理由）
- 最低定价：X元（保本线）
- 最高定价：X元（溢价空间）

【心理定价技巧】
- 价格锚点设计（如何让目标价格显得超值）
- 价格呈现方式（如何展示价格更有吸引力）
- 套餐组合建议（如何通过套餐提升客单价）

【价格梯队设计】（基础版/标准版/高级版的定价和权益）

【促销定价策略】
- 首发优惠方案
- 限时折扣设计
- 老客户优惠

【涨价策略】（如何在不流失客户的情况下涨价）
【竞争应对】（竞品降价时如何应对）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '定价策略分析');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/sales-page — 销售页文案（3积分）
router.post('/sales-page', auth, async (req, res) => {
  const { product, price, audience, pain } = req.body;
  if (!product?.trim()) return res.status(400).json({ message: '请输入产品信息' });
  const prompt = `你是一位顶级销售文案专家，请为以下产品创作完整的销售落地页文案。

产品/服务：${product.trim()}
定价：${price?.trim() || '待定'}
目标用户：${audience?.trim() || '通用用户'}
核心痛点：${pain?.trim() || '请根据产品推断'}

请按以下结构输出完整销售页文案：

【主标题】（一句话抓住注意力）
【副标题】（补充说明价值主张）

【痛点共鸣区】（描述用户现状和痛苦，引发强烈共鸣）

【解决方案介绍】（介绍产品如何解决问题）

【核心价值点】（3-5个最重要的卖点，每个配说明）

【产品详情】（详细介绍产品内容/功能）

【用户证言区】（3条真实感强的用户反馈）

【价格展示区】（价格锚定+超值感营造）

【FAQ常见问题】（5个最常见的购买顾虑及解答）

【紧迫感设计】（限时/限量/涨价等促单元素）

【行动号召】（最终购买引导文案）`;
  try {
    const result = await callText(prompt, 3, req.user.id, '销售页文案');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/promo-campaign — 限时活动策划（2积分）
router.post('/promo-campaign', auth, async (req, res) => {
  const { product, occasion = '双11', platform = '抖音' } = req.body;
  if (!product?.trim()) return res.status(400).json({ message: '请输入产品信息' });
  const prompt = `你是一位电商促销活动策划专家，请为以下产品策划${occasion}促销活动方案。

产品/服务：${product.trim()}
促销节点：${occasion}
主要平台：${platform}

请输出完整促销活动方案：

【活动主题】（有创意的活动名称和主题）

【活动时间规划】
- 预热期（活动前X天）
- 爆发期（活动当天）
- 返场期（活动后X天）

【优惠方案设计】
- 主力优惠（最吸引人的折扣/赠品）
- 阶梯优惠（满减/买赠等）
- 限时闪购设计

【内容营销方案】
- 预热视频内容（3条）
- 活动当天内容（2条）
- 直播方案（如适用）

【推广文案】
- 活动主文案
- 短视频标题（5个）
- 朋友圈文案（3条）

【数据目标】（销售额/转化率等目标设定）
【风险预案】（活动期间可能出现的问题及应对）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '限时活动策划');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/member-system — 会员体系设计（3积分）
router.post('/member-system', auth, async (req, res) => {
  const { niche, product } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入账号领域' });
  const prompt = `你是一位会员体系设计专家，请为以下账号设计完整的粉丝会员体系。

账号领域：${niche.trim()}
主要产品/服务：${product?.trim() || '待定'}

请输出完整会员体系设计方案：

【会员体系概述】（设计理念和核心价值）

【会员等级设计】（建议3-5个等级）
每个等级包含：
- 等级名称（有创意，符合账号调性）
- 升级条件（消费金额/互动次数等）
- 专属权益（具体可执行的权益）
- 视觉标识建议

【积分体系设计】
- 积分获取方式（购买/互动/分享等）
- 积分消耗方式（兑换/抵扣等）
- 积分有效期设置

【会员专属内容】（不同等级可获取的专属内容）

【会员运营方案】
- 新会员欢迎流程
- 会员日活动设计
- 会员升级激励
- 流失会员召回

【技术实现建议】（如何在现有平台实现会员管理）
【变现预估】（会员体系预计带来的收入增长）`;
  try {
    const result = await callText(prompt, 3, req.user.id, '会员体系设计');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/content-matrix — 内容矩阵规划（3积分）
router.post('/content-matrix', auth, async (req, res) => {
  const { mainNiche, platform = '抖音', accountCount = '3' } = req.body;
  if (!mainNiche?.trim()) return res.status(400).json({ message: '请输入主账号领域' });
  const prompt = `你是一位自媒体矩阵运营专家，请为以下主账号设计${accountCount}个矩阵账号的差异化布局方案。

主账号领域：${mainNiche.trim()}
主要平台：${platform}
矩阵账号数量：${accountCount}个

请输出完整矩阵账号规划：

【矩阵策略概述】（为什么要做矩阵，核心逻辑）

【主账号定位】（主账号的核心定位和职责）

【矩阵账号设计】（每个账号详细规划）
账号X：
- 账号定位（与主账号的差异化）
- 目标人群（细分人群）
- 内容方向（具体内容类型）
- 与主账号的协同方式
- 变现路径

【账号间协同机制】
- 内容互推策略
- 流量互导方案
- 统一品牌调性

【运营资源分配】（人力/时间/内容的分配建议）
【矩阵变现设计】（矩阵整体的变现路径）
【风险控制】（矩阵运营的注意事项）`;
  try {
    const result = await callText(prompt, 3, req.user.id, '内容矩阵规划');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/contrast-script — 对比反转脚本（2积分）
router.post('/contrast-script', auth, async (req, res) => {
  const { topic, type = 'before-after' } = req.body;
  if (!topic?.trim()) return res.status(400).json({ message: '请输入视频主题' });
  const prompt = `你是一位擅长对比反转内容的短视频创作专家，请为以下主题创作3个高冲击力的对比反转脚本。

视频主题：${topic.trim()}
对比类型：${type}

请输出3个不同角度的对比反转脚本：

【脚本一：before/after型】
- 开场（展示"之前"的状态，引发共鸣）
- 转折（发现/学到/改变了什么）
- 结果（展示"之后"的惊人变化）
- 结尾钩子

【脚本二：认知反转型】
- 开场（展示普遍错误认知）
- 反转（揭示真相，颠覆认知）
- 干货（正确做法）
- 结尾引导

【脚本三：情绪反转型】
- 开场（制造低谷情绪）
- 转折（意外的转机）
- 高潮（情绪爆发点）
- 升华结尾

每个脚本包含：画面描述、台词/字幕、时间节点（总60秒内）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '对比反转脚本');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/emotion-words — 情绪词库生成（1积分）
router.post('/emotion-words', auth, async (req, res) => {
  const { topic, emotion = '共鸣感动' } = req.body;
  if (!topic?.trim()) return res.status(400).json({ message: '请输入主题' });
  const prompt = `你是一位情绪化写作专家，请为以下主题生成高情绪感染力的词汇库和句式模板。

主题：${topic.trim()}
目标情绪：${emotion}

请输出：

【高情绪词汇库】
- 动词（20个，有力量感）
- 形容词（20个，有画面感）
- 名词（10个，有共鸣感）

【情绪句式模板】（每类5个）
- 开场钩子句式
- 痛点描述句式
- 情绪爆发句式
- 共鸣引导句式
- 行动号召句式

【情绪递进结构】（如何在内容中逐步推高情绪）

【禁用词汇】（会破坏情绪的词汇，5个）

【实战示例】（用以上词汇和句式写一段100字的示例文案）`;
  try {
    const result = await callText(prompt, 1, req.user.id, '情绪词库生成');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/translate-adapt — 多语言翻译适配（2积分）
router.post('/translate-adapt', auth, async (req, res) => {
  const { content, targetLang = '英语', platform = 'TikTok' } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: '请输入需要翻译的内容' });
  const prompt = `你是一位国际化内容运营专家，请将以下中文内容翻译并适配为${targetLang}版本，适合在${platform}平台发布。

原始内容：
${content.trim()}

目标语言：${targetLang}
目标平台：${platform}

请输出：

【直译版本】（忠实原文的翻译）

【本地化适配版本】（根据${targetLang}用户习惯和${platform}平台特点重新创作）
- 标题（适合${platform}的标题风格）
- 正文（本地化表达，符合当地文化）
- 话题标签（${targetLang}热门相关标签）

【文化适配说明】（哪些内容做了本地化调整，原因是什么）

【发布建议】（在${platform}发布的注意事项和优化建议）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '多语言翻译适配');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// ===== AI命理哲学工具 =====

// POST /api/aitools/bazi — 八字分析（3积分）
router.post('/bazi', auth, async (req, res) => {
  const { birthdate, birthtime = '不详', gender = '男' } = req.body;
  if (!birthdate?.trim()) return res.status(400).json({ message: '请输入出生日期' });
  const prompt = `你是一位精通中国传统命理学的大师，请根据以下信息进行八字命盘分析。

出生日期：${birthdate.trim()}
出生时辰：${birthtime}
性别：${gender}

请输出：

【八字命盘】
- 年柱、月柱、日柱、时柱（天干地支）
- 五行分布（金木水火土各几个）
- 日主强弱分析

【命格特征】
- 命格类型（如：从强格、普通格等）
- 用神与忌神
- 性格特点（3-5条）

【人生运势】
- 事业方向建议
- 财运分析
- 感情婚姻
- 健康注意事项

【流年运势】（近3年）

【开运建议】
- 幸运颜色、数字、方位
- 适合佩戴的饰品
- 生活调整建议

注：以上分析仅供参考，命运掌握在自己手中。`;
  try {
    const result = await callText(prompt, 3, req.user.id, '八字分析');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/tarot — 塔罗占卜（2积分）
router.post('/tarot', auth, async (req, res) => {
  const { question, spread = '三张牌阵' } = req.body;
  if (!question?.trim()) return res.status(400).json({ message: '请输入占卜问题' });
  const prompt = `你是一位专业的塔罗牌占卜师，请为以下问题进行塔罗牌解读。

占卜问题：${question.trim()}
牌阵：${spread}

请随机抽取对应数量的塔罗牌（从78张标准韦特塔罗牌中），并进行详细解读：

【抽到的牌】
（列出每张牌的名称、正逆位）

【牌面解读】
（每张牌的含义及在此问题中的指向）

【综合解读】
（结合所有牌给出整体分析和建议）

【行动建议】
（基于塔罗指引，给出3条具体可行的建议）

注：塔罗占卜仅供娱乐参考，请理性看待。`;
  try {
    const result = await callText(prompt, 2, req.user.id, '塔罗占卜');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/fengshui — 风水布局建议（2积分）
router.post('/fengshui', auth, async (req, res) => {
  const { space, purpose = '居家', issue = '' } = req.body;
  if (!space?.trim()) return res.status(400).json({ message: '请描述空间情况' });
  const prompt = `你是一位精通风水学的专家，请根据以下信息给出风水布局建议。

空间描述：${space.trim()}
用途：${purpose}
主要问题/诉求：${issue || '整体运势提升'}

请从以下角度给出专业建议：

【空间风水分析】
- 整体格局评估
- 主要风水问题点

【五行调和建议】
- 缺失五行的补充方法
- 颜色搭配建议

【功能区布局】
- 财位布置
- 文昌位（学习/事业）
- 桃花位（感情）
- 健康位

【开运摆件建议】
- 推荐摆件及摆放位置
- 禁忌事项

【简易改善方案】（低成本可操作）

注：风水建议仅供参考，实际效果因人而异。`;
  try {
    const result = await callText(prompt, 2, req.user.id, '风水布局建议');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/zodiac — 星座运势（1积分）
router.post('/zodiac', auth, async (req, res) => {
  const { sign, period = '本周' } = req.body;
  if (!sign?.trim()) return res.status(400).json({ message: '请选择星座' });
  const prompt = `你是一位专业的星座运势分析师，请为${sign}分析${period}运势。

【综合运势】（★评分 1-5星）

【事业学业】
- 运势分析
- 本${period === '本周' ? '周' : period === '本月' ? '月' : '年'}重点提示
- 行动建议

【财运】
- 财运走势
- 投资理财建议
- 偏财运提示

【感情】
- 单身者：桃花运势
- 恋爱中：感情走向
- 已婚者：家庭和谐度

【健康】
- 需要注意的健康问题
- 养生建议

【幸运提示】
- 幸运日：
- 幸运色：
- 幸运数字：
- 贵人星座：

【本${period === '本周' ? '周' : period === '本月' ? '月' : '年'}关键词】（3个词）`;
  try {
    const result = await callText(prompt, 1, req.user.id, '星座运势');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/name-analysis — 姓名测算（2积分）
router.post('/name-analysis', auth, async (req, res) => {
  const { name, gender = '男', birthdate = '' } = req.body;
  if (!name?.trim()) return res.status(400).json({ message: '请输入姓名' });
  const prompt = `你是一位精通姓名学的命理专家，请对以下姓名进行全面测算分析。

姓名：${name.trim()}
性别：${gender}
${birthdate ? `出生日期：${birthdate}` : ''}

请从以下维度进行分析：

【姓名基本信息】
- 笔画数（天格、人格、地格、外格、总格）
- 五行属性
- 阴阳配置

【三才五格分析】
- 天格含义
- 人格（主运）含义
- 地格（前运）含义
- 外格（社交运）含义
- 总格（后运）含义

【综合评分】（满分100分）
- 事业运：__分
- 财运：__分
- 感情运：__分
- 健康运：__分
- 综合评分：__分

【性格特征】（根据姓名分析）

【人生运势走向】

【姓名优缺点总结】

注：姓名测算仅供参考娱乐，不构成任何决策依据。`;
  try {
    const result = await callText(prompt, 2, req.user.id, '姓名测算');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// ===== 外贸运营专用AI工具 =====

// POST /api/aitools/trade-email — 外贸邮件生成（2积分）
router.post('/trade-email', auth, async (req, res) => {
  const { purpose, product = '', customerInfo = '', tone = '专业正式' } = req.body;
  if (!purpose?.trim()) return res.status(400).json({ message: '请输入邮件目的' });
  const prompt = `你是一位资深外贸业务员，请根据以下信息撰写一封专业的外贸邮件。

邮件目的：${purpose.trim()}
产品/服务：${product || '未指定'}
客户信息：${customerInfo || '潜在客户'}
邮件风格：${tone}

请输出：

【邮件主题】（Subject Line，吸引眼球）

【邮件正文】（英文）
（包含：开场白、主体内容、行动号召、结尾）

【中文翻译】

【发送建议】
- 最佳发送时间
- 跟进策略
- 注意事项`;
  try {
    const result = await callText(prompt, 2, req.user.id, '外贸邮件生成');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/product-desc — 外贸产品描述（2积分）
router.post('/product-desc', auth, async (req, res) => {
  const { product, features = '', targetMarket = '欧美市场' } = req.body;
  if (!product?.trim()) return res.status(400).json({ message: '请输入产品名称' });
  const prompt = `你是一位专业的外贸产品文案专家，请为以下产品撰写适合国际市场的产品描述。

产品名称：${product.trim()}
产品特点：${features || '请根据产品名称推断'}
目标市场：${targetMarket}

请输出：

【产品标题】（英文，适合亚马逊/速卖通/独立站）

【简短描述】（英文，50词以内）

【详细描述】（英文，200-300词）
- 产品亮点（Bullet Points，5条）
- 使用场景
- 目标人群

【关键词】（SEO关键词，10个）

【中文对照】（以上内容的中文版本）

【平台优化建议】（针对${targetMarket}的发布建议）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '外贸产品描述');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/inquiry-reply — 询盘回复（2积分）
router.post('/inquiry-reply', auth, async (req, res) => {
  const { inquiry, product = '', companyInfo = '' } = req.body;
  if (!inquiry?.trim()) return res.status(400).json({ message: '请输入客户询盘内容' });
  const prompt = `你是一位经验丰富的外贸业务员，请根据客户询盘内容撰写专业的回复邮件。

客户询盘：${inquiry.trim()}
我方产品：${product || '根据询盘内容判断'}
公司信息：${companyInfo || '专业外贸公司'}

请输出：

【询盘分析】
- 客户需求要点
- 客户类型判断（贸易商/终端用户/采购商）
- 潜在痛点

【回复邮件】（英文）
- 主题行
- 正文（专业、有针对性、包含行动号召）

【中文翻译】

【报价策略建议】
- 是否直接报价
- 报价注意事项
- 后续跟进计划`;
  try {
    const result = await callText(prompt, 2, req.user.id, '询盘回复');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/trade-negotiation — 外贸谈判话术（2积分）
router.post('/trade-negotiation', auth, async (req, res) => {
  const { scenario, issue = '', position = '卖方' } = req.body;
  if (!scenario?.trim()) return res.status(400).json({ message: '请描述谈判场景' });
  const prompt = `你是一位资深外贸谈判专家，请为以下谈判场景提供专业话术和策略。

谈判场景：${scenario.trim()}
核心问题：${issue || '价格/交期/质量'}
我方立场：${position}

请输出：

【场景分析】
- 谈判要点
- 对方可能的立场和诉求
- 我方优劣势

【谈判话术】（英文+中文对照）

开场白：
价格谈判话术：
处理异议话术：
促成成交话术：
僵局破解话术：

【谈判策略】
- 底线设定建议
- 让步策略
- 成交信号识别

【注意事项】（文化差异/禁忌）`;
  try {
    const result = await callText(prompt, 2, req.user.id, '外贸谈判话术');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/customs-code — 海关编码查询助手（1积分）
router.post('/customs-code', auth, async (req, res) => {
  const { product } = req.body;
  if (!product?.trim()) return res.status(400).json({ message: '请输入产品名称' });
  const prompt = `你是一位专业的外贸报关专家，请为以下产品提供海关编码（HS Code）查询建议。

产品：${product.trim()}

请输出：

【可能的HS编码】（列出2-3个最可能的编码）
- 编码：
- 描述：
- 适用条件：

【推荐编码】及理由

【进出口注意事项】
- 常见关税税率（中国出口到主要市场）
- 是否需要特殊许可证
- 常见报关问题

【建议】
- 如何确认正确编码
- 建议咨询专业报关行

注：HS编码仅供参考，实际申报请以海关官方数据库为准。`;
  try {
    const result = await callText(prompt, 1, req.user.id, '海关编码查询');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/market-analysis — 海外市场分析（3积分）
router.post('/market-analysis', auth, async (req, res) => {
  const { product, targetCountry } = req.body;
  if (!product?.trim() || !targetCountry?.trim()) return res.status(400).json({ message: '请输入产品和目标市场' });
  const prompt = `你是一位专业的国际市场分析师，请对以下产品在目标市场的前景进行分析。

产品：${product.trim()}
目标市场：${targetCountry.trim()}

请输出：

【市场概况】
- 市场规模（估算）
- 增长趋势
- 主要消费群体

【竞争格局】
- 主要竞争对手（本土品牌+国际品牌）
- 中国产品的竞争优势/劣势
- 市场空白点

【进入门槛】
- 认证要求（CE/FCC/FDA等）
- 法规限制
- 关税情况

【渠道分析】
- 主流销售渠道（线上/线下）
- 推荐平台（亚马逊/独立站/本土电商）
- 分销商/代理商寻找建议

【营销建议】
- 本地化策略
- 定价建议
- 推广渠道

【风险提示】`;
  try {
    const result = await callText(prompt, 3, req.user.id, '海外市场分析');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/ip-design — IP形象设计（2积分）
router.post('/ip-design', auth, async (req, res) => {
  const { niche, platform, style } = req.body;
  if (!niche?.trim()) return res.status(400).json({ message: '请输入账号定位' });
  const prompt = `你是一位专业的个人IP打造顾问，请为以下账号设计完整的IP形象方案。

账号定位：${niche.trim()}
目标平台：${platform || '抖音'}
IP风格：${style || '专业权威'}

请输出：

【IP定位】
- 核心标签（3个关键词）
- 目标受众画像
- 差异化优势

【人设设计】
- 昵称建议（3个方案）
- 个人简介（50字以内）
- 标志性口头禅/开场白

【视觉形象】
- 头像风格建议
- 主色调推荐
- 封面模板风格

【内容人设】
- 内容主线（3个方向）
- 固定栏目设计
- 互动风格

【变现路径】
- 短期变现方式
- 长期IP价值`;
  try {
    const result = await callText(prompt, 2, req.user.id, 'IP形象设计');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/resume-polish — 简历优化（2积分）
router.post('/resume-polish', auth, async (req, res) => {
  const { content, job, focus } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: '请输入简历内容' });
  const prompt = `你是一位专业的简历优化顾问，请对以下简历进行优化。

目标岗位：${job?.trim() || '未指定'}
优化方向：${focus || '突出成果数据'}

原始简历：
${content.trim()}

请输出优化后的完整简历内容，要求：
1. 保留原有信息框架，不编造虚假经历
2. 按优化方向重点改进
3. 用数据量化成果（如"提升转化率30%"）
4. 关键词与目标岗位匹配
5. 语言简洁有力，避免空话套话

直接输出优化后的简历，不需要解释说明。`;
  try {
    const result = await callText(prompt, 2, req.user.id, '简历优化');
    res.json({ result });
  } catch (e) {
    if (e.code === 'QUOTA_EXCEEDED') return res.status(403).json({ message: e.message, code: 'QUOTA_EXCEEDED' });
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: e.message || 'AI 调用失败' });
  }
});

// POST /api/aitools/chat — AI员工聊天流式输出（1积分/次，游客限2轮）
router.post('/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ message: '请输入消息内容' });

  // 支持 JWT 登录 或 API Key 游客认证
  const userId = verifyToken(req);
  if (!userId) {
    return res.status(401).json({ message: '请先登录或输入 API Key 后再使用 AI 功能', code: 'LOGIN_REQUIRED', needLogin: true, needApiKey: true });
  }
  // AI 调用费用由 api.yunjunet.cn USD 余额承担，不再扣积分

  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const GW_URL = process.env.AI_GATEWAY_URL || 'http://localhost:3021';
    const GW_SECRET = process.env.INTERNAL_API_SECRET || '';
    const { pickModel: pickChatModel } = require('yunjunet-common/backend-core/ai/model-router');
    const chatPicked = await pickChatModel('simple');
    const apiUrl = `${GW_URL}/v1/internal/chat/completions`;

    const messages = [
      {
        role: 'system',
        content: '你是一位专业的AI员工，短视频运营专家。请用自然、口语化的纯文本格式回复，不要使用任何 Markdown 格式（如 **加粗**、# 标题、- 列表符号等）。直接用换行和自然的语言组织内容，像同事交流一样。'
      },
      ...history.slice(-10),
      { role: 'user', content: message.trim() }
    ];

    const bodyData = { model: chatPicked.model, messages, stream: true };

    const upstream = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': GW_SECRET, 'X-User-Id': String(userId) },
      body: JSON.stringify(bodyData),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      throw new Error(`API 调用失败: ${upstream.status} ${errText}`);
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留不完整的最后一行

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data:')) continue;

        try {
          const json = JSON.parse(trimmed.slice(5).trim());
          // chat/completions 流式格式
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) sendEvent({ delta });
        } catch {}
      }
    }

    sendEvent({ done: true });
    res.end();

    // 更新任务进度
    const { updateTaskProgress } = require('./tasks');
    if (!isGuest && userId) {
      await updateTaskProgress(userId, 'newbie_first_ai', 1);
      await updateTaskProgress(userId, 'daily_use_ai', 1);
    }
  } catch (e) {
    if (!isGuest && userId) {
      await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [cost, userId]);
      await addQuotaLog(userId, cost, 'AI员工失败退还');
    }
    sendEvent({ error: e.message || 'AI 调用失败' });
    res.end();
  }
});

// 游客工具函数已移至顶部 require('../utils/aitoolsShared')

// POST /api/aitools/employee-meeting — AI员工会议（每轮5积分，最多10轮，游客可体验5轮）
router.post('/employee-meeting', async (req, res) => {
  const { topic, question, round = 1, history = [] } = req.body;
  if (!question?.trim()) return res.status(400).json({ message: '请输入问题' });
  if (round > 10) return res.status(400).json({ message: '已达到最大轮次（10轮）' });

  // 获取客户端IP
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                   req.headers['x-real-ip'] ||
                   req.connection.remoteAddress ||
                   req.socket.remoteAddress;

  // 支持 JWT 登录 或 API Key 游客认证
  const userId = verifyToken(req);

  if (!userId) {
    return res.status(401).json({
      message: '请先登录或输入 API Key 后再使用 AI 功能',
      code: 'LOGIN_REQUIRED',
      needLogin: true,
      needApiKey: true,
    });
  }
  // AI 调用费用由 api.yunjunet.cn USD 余额承担，不再扣积分

  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // 定义5个AI员工角色
  const employees = [
    {
      name: '张策划',
      role: '内容策划师',
      getPrompt: (topic, question, round, history) => {
        let prompt = `你是张策划，一位资深的短视频内容策划师。你擅长选题策划、热点分析、用户画像分析、内容定位。

会议主题：${topic}
当前问题（第${round}轮）：${question}`;

        if (history.length > 0) {
          prompt += `\n\n前面几轮的讨论内容：\n${history.map(h => `问题：${h.question}\n你的回答：${h.responses['张策划'] || '未发言'}`).join('\n\n')}`;
        }

        prompt += `\n\n请针对当前问题，从内容策划的角度给出专业建议。

要求：
1. 用第一人称"我"发言，体现个人风格
2. 如果是后续轮次，要结合前面的讨论内容
3. 语气专业但不失亲和力
4. 给出3-5个具体可执行的建议
5. 控制在200字以内
6. 不要使用Markdown格式，用纯文本自然换行`;

        return prompt;
      }
    },
    {
      name: '李文案',
      role: '文案编辑',
      getPrompt: (topic, question, round, history) => {
        let prompt = `你是李文案，一位创意文案编辑。你擅长撰写吸引人的标题、文案、脚本，善于用文字打动人心。

会议主题：${topic}
当前问题（第${round}轮）：${question}`;

        if (history.length > 0) {
          prompt += `\n\n前面几轮的讨论内容：\n${history.map(h => `问题：${h.question}\n你的回答：${h.responses['李文案'] || '未发言'}`).join('\n\n')}`;
        }

        prompt += `\n\n刚才张策划已经发言。现在请你从文案创作的角度给出建议。

要求：
1. 用第一人称"我"发言
2. 如果是后续轮次，要结合前面的讨论和新的思考
3. 语气生动活泼，富有创意
4. 提供2-3个具体的文案示例
5. 控制在200字以内
6. 不要使用Markdown格式，用纯文本自然换行`;

        return prompt;
      }
    },
    {
      name: '王数据',
      role: '数据分析师',
      getPrompt: (topic, question, round, history) => {
        let prompt = `你是王数据，一位数据分析师。你擅长用户行为分析、数据洞察、效果评估，习惯用数据说话。

会议主题：${topic}
当前问题（第${round}轮）：${question}`;

        if (history.length > 0) {
          prompt += `\n\n前面几轮的讨论内容：\n${history.map(h => `问题：${h.question}\n你的回答：${h.responses['王数据'] || '未发言'}`).join('\n\n')}`;
        }

        prompt += `\n\n前面张策划和李文案已经发言。现在请你从数据分析的角度给出建议。

要求：
1. 用第一人称"我"发言
2. 如果是后续轮次，要基于前面的数据分析进行深化
3. 语气理性客观，注重数据和逻辑
4. 提供2-3个关键数据指标
5. 控制在200字以内
6. 不要使用Markdown格式，用纯文本自然换行`;

        return prompt;
      }
    },
    {
      name: '赵剪辑',
      role: '视频剪辑师',
      getPrompt: (topic, question, round, history) => {
        let prompt = `你是赵剪辑，一位视频剪辑师。你擅长镜头语言、节奏把控、视觉效果、剪辑技巧。

会议主题：${topic}
当前问题（第${round}轮）：${question}`;

        if (history.length > 0) {
          prompt += `\n\n前面几轮的讨论内容：\n${history.map(h => `问题：${h.question}\n你的回答：${h.responses['赵剪辑'] || '未发言'}`).join('\n\n')}`;
        }

        prompt += `\n\n前面几位同事已经发言。现在请你从视频制作的角度给出建议。

要求：
1. 用第一人称"我"发言
2. 如果是后续轮次，要结合前面的视觉建议进行补充
3. 语气专业，注重视觉呈现
4. 提供2-3个具体的剪辑技巧
5. 控制在200字以内
6. 不要使用Markdown格式，用纯文本自然换行`;

        return prompt;
      }
    },
    {
      name: '刘总监',
      role: '运营总监',
      getPrompt: (topic, question, round, history) => {
        let prompt = `你是刘总监，运营总监。你擅长整体把控、资源协调、战略规划，负责做最终决策。

会议主题：${topic}
当前问题（第${round}轮）：${question}`;

        if (history.length > 0) {
          prompt += `\n\n前面几轮的讨论内容：\n${history.map(h => `问题：${h.question}\n你的回答：${h.responses['刘总监'] || '未发言'}`).join('\n\n')}`;
        }

        prompt += `\n\n前面4位同事（张策划、李文案、王数据、赵剪辑）已经发言。现在请你作为总监做总结性发言。

要求：
1. 用第一人称"我"发言
2. 如果是后续轮次，要基于前面的总结进行战略调整
3. 语气稳重有力，体现领导风范
4. 综合前面同事的建议，给出行动计划
5. 控制在250字以内
6. 不要使用Markdown格式，用纯文本自然换行`;

        return prompt;
      }
    }
  ];

  try {
    const MTG_GW_URL = process.env.AI_GATEWAY_URL || 'http://localhost:3021';
    const MTG_SECRET = process.env.INTERNAL_API_SECRET || '';
    const { pickModel: pickMtgModel } = require('yunjunet-common/backend-core/ai/model-router');
    const mtgPicked = await pickMtgModel('medium');
    const apiUrl = `${MTG_GW_URL}/v1/internal/chat/completions`;
    const modelName = mtgPicked.model;

    // 记录本轮各员工的回复
    const currentRoundResponses = {};

    // 依次调用每个员工
    for (let i = 0; i < employees.length; i++) {
      const employee = employees[i];

      // 通知前端：员工开始发言
      sendEvent({
        type: 'employee_start',
        name: employee.name,
        role: employee.role
      });

      try {
        const prompt = employee.getPrompt(topic, question, round, history);

        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Secret': MTG_SECRET,
            'X-User-Id': String(userId),
          },
          body: JSON.stringify({
            model: modelName,
            messages: [{ role: 'user', content: prompt }],
            stream: true,
            max_tokens: 500,
            temperature: 0.8
          })
        });

        if (!response.ok) {
          throw new Error(`员工 ${employee.name} 调用失败`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let employeeResponse = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            if (trimmed === 'data: [DONE]') continue;

            try {
              const json = JSON.parse(trimmed.slice(5));
              const delta = json.choices?.[0]?.delta?.content;
              if (delta) {
                employeeResponse += delta;
                sendEvent({ type: 'delta', delta });
              }
            } catch (e) {
              // 忽略解析错误
            }
          }
        }

        // 保存员工回复
        currentRoundResponses[employee.name] = employeeResponse;

        // 通知前端：员工发言结束
        sendEvent({ type: 'employee_end', name: employee.name });

        // 短暂延迟
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (empError) {
        console.error(`Employee ${employee.name} error:`, empError);
        sendEvent({
          type: 'delta',
          delta: `\n[${employee.name}暂时无法发言，已跳过]`
        });
        sendEvent({ type: 'employee_end', name: employee.name });
      }
    }

    // 更新历史记录
    const updatedHistory = [...history, {
      round,
      question,
      responses: currentRoundResponses
    }];

    // 本轮结束
    sendEvent({
      type: 'round_complete',
      round,
      history: updatedHistory
    });

    res.end();

  } catch (e) {
    // 只有注册用户才需要退还积分
    if (!isGuest && userId) {
      await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [5, userId]);
      await addQuotaLog(userId, 5, `AI员工会议-第${round}轮失败退还`);
    }
    sendEvent({ error: e.message || 'AI 调用失败' });
    res.end();
  }
});

// POST /api/aitools/smart-parse — 智能解析混合内容（用于AI视频）
router.post('/smart-parse', auth, async (req, res) => {
  const { content, deep_analysis, duration = 10 } = req.body;

  if (!content?.trim()) {
    return res.status(400).json({ message: '请输入内容' });
  }

  const text = content.trim();

  // 提取链接的正则表达式
  const urlPatterns = [
    // 元宝链接（腾讯AI助手，用于视频号内容分析）
    /(https?:\/\/yb\.tencent\.com\/[^\s]+)/gi,
    // 标准 HTTP/HTTPS 链接
    /(https?:\/\/[^\s]+)/gi,
    // 短链接（如 v.douyin.com）
    /((?:v\.)?(?:douyin|kuaishou|xiaohongshu|xhslink)\.com\/[^\s]+)/gi,
    // 微信链接
    /(weixin\.qq\.com\/[^\s]+)/gi,
    /(channels\.weixin\.qq\.com\/[^\s]+)/gi,
  ];

  let extractedLink = null;

  // 尝试提取链接
  for (const pattern of urlPatterns) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      // 取第一个匹配的链接
      extractedLink = matches[0];
      // 清理链接末尾可能的标点符号
      extractedLink = extractedLink.replace(/[。，、；：！？）】》"'\s]+$/, '');
      break;
    }
  }

  if (!extractedLink) {
    return res.status(400).json({ message: '未能从内容中提取到有效链接' });
  }

  // 如果链接不包含协议，添加 https://
  if (!extractedLink.startsWith('http')) {
    extractedLink = 'https://' + extractedLink;
  }

  const result = {
    link: extractedLink
  };

  // 如果启用深度分析，调用豆包AI生成视频脚本
  if (deep_analysis) {
    if (!DOUBAO_API_KEY) {
      return res.json({ ...result, script: null, error: 'AI服务未配置' });
    }

    try {
      // 验证 duration 参数
      const validDuration = [5, 10].includes(parseInt(duration)) ? parseInt(duration) : 10;

      const scriptPrompt = `基于以下社媒内容，生成一个AI视频脚本：

原始内容：
${text}

链接：${extractedLink}

要求：
- 时长：${validDuration}秒
- 脚本要简洁有力，适合短视频
- 包含镜头描述和台词

格式：
【镜头】描述
【台词】内容

直接输出脚本，不要其他内容。`;

      const scriptArkBaseUrl = await getArkBaseUrl();
      const scriptTextModel = await getTextModel();
      const response = await fetch(`${scriptArkBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${DOUBAO_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: scriptTextModel,
          messages: [{ role: 'user', content: scriptPrompt }],
          max_tokens: 300,
          temperature: 0.8
        })
      });

      if (response.ok) {
        const data = await response.json();
        result.script = data.choices[0]?.message?.content?.trim() || null;
      } else {
        result.script = null;
        result.error = 'AI脚本生成失败';
      }
    } catch (error) {
      console.error('[AI脚本生成失败]', error.message);
      result.script = null;
      result.error = 'AI脚本生成失败';
    }
  }

  res.json(result);
});

// ========== 视频模型厂商适配器 ==========

// 豆包视频生成
async function callDoubaoVideo(prompt, duration, apiKey) {
  const videoRateLimitErr = await arkRateLimiter.consume();
  if (videoRateLimitErr) throw videoRateLimitErr;

  const arkBaseUrl = await getArkBaseUrl();
  const videoModel = await getVideoModel();
  const createRes = await fetch(`${arkBaseUrl}/contents/generations/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: videoModel,
      content: [{ type: 'text', text: `${prompt} --duration ${duration} --camerafixed false` }],
    }),
  });
  if (!createRes.ok) throw new Error(`豆包API错误(${createRes.status}): ${await createRes.text()}`);
  const task = await createRes.json();

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`${arkBaseUrl}/contents/generations/tasks/${task.id}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const pollData = await pollRes.json();
    if (pollData.status === 'succeeded') return pollData.content?.video_url;
    if (pollData.status === 'failed') throw new Error(`视频生成失败: ${pollData.error?.message || ''}`);
  }
  throw new Error('视频生成超时');
}

// 快手可灵视频生成
async function callKlingVideo(prompt, duration, accessKey, secretKey) {
  const crypto = require('crypto');
  const timestamp = Date.now();
  const sign = crypto.createHmac('sha256', secretKey).update(`${accessKey}${timestamp}`).digest('hex');

  const createRes = await fetch('https://api.klingai.com/v1/videos/text2video', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Access-Key': accessKey,
      'X-Timestamp': timestamp.toString(),
      'X-Signature': sign,
    },
    body: JSON.stringify({ prompt, duration: duration === 10 ? 'standard' : 'fast', aspect_ratio: '16:9' }),
  });
  if (!createRes.ok) throw new Error(`可灵API错误(${createRes.status}): ${await createRes.text()}`);
  const task = await createRes.json();

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`https://api.klingai.com/v1/videos/${task.data.task_id}`, {
      headers: {
        'X-Access-Key': accessKey,
        'X-Timestamp': Date.now().toString(),
        'X-Signature': crypto.createHmac('sha256', secretKey).update(`${accessKey}${Date.now()}`).digest('hex'),
      },
    });
    const pollData = await pollRes.json();
    if (pollData.data.status === 'succeed') return pollData.data.works[0]?.resource.resource;
    if (pollData.data.status === 'failed') throw new Error('可灵视频生成失败');
  }
  throw new Error('可灵视频生成超时');
}

// 智谱CogVideoX视频生成
async function callZhipuVideo(prompt, apiKey) {
  const createRes = await fetch('https://open.bigmodel.cn/api/paas/v4/videos/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'cogvideox', prompt }),
  });
  if (!createRes.ok) throw new Error(`智谱API错误(${createRes.status}): ${await createRes.text()}`);
  const task = await createRes.json();

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`https://open.bigmodel.cn/api/paas/v4/async-result/${task.id}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const pollData = await pollRes.json();
    if (pollData.task_status === 'SUCCESS') return pollData.video_result[0]?.url;
    if (pollData.task_status === 'FAIL') throw new Error('智谱视频生成失败');
  }
  throw new Error('智谱视频生成超时');
}

// 阿里通义万象视频生成
async function callWanxVideo(prompt, apiKey) {
  const createRes = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/text2video/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({ model: 'wanx-v2.1-t2v', input: { prompt } }),
  });
  if (!createRes.ok) throw new Error(`通义API错误(${createRes.status}): ${await createRes.text()}`);
  const task = await createRes.json();

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${task.output.task_id}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const pollData = await pollRes.json();
    if (pollData.output.task_status === 'SUCCEEDED') return pollData.output.results[0]?.url;
    if (pollData.output.task_status === 'FAILED') throw new Error('通义视频生成失败');
  }
  throw new Error('通义视频生成超时');
}

// 腾讯混元视频生成
async function callHunyuanVideo(prompt, secretId, secretKey) {
  const crypto = require('crypto');
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ Prompt: prompt });
  const canonicalRequest = `POST\n/\n\ncontent-type:application/json\nhost:hunyuan.tencentcloudapi.com\n\ncontent-type;host\n${crypto.createHash('sha256').update(payload).digest('hex')}`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
  const signature = crypto.createHmac('sha256', `TC3${secretKey}`).update(stringToSign).digest('hex');

  const createRes = await fetch('https://hunyuan.tencentcloudapi.com', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `TC3-HMAC-SHA256 Credential=${secretId}/${new Date().toISOString().split('T')[0]}/hunyuan/tc3_request, SignedHeaders=content-type;host, Signature=${signature}`,
      'X-TC-Action': 'SubmitVideoGenerationJob',
      'X-TC-Timestamp': timestamp.toString(),
      'X-TC-Version': '2023-09-01',
    },
    body: payload,
  });
  if (!createRes.ok) throw new Error(`混元API错误(${createRes.status}): ${await createRes.text()}`);
  const task = await createRes.json();

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch('https://hunyuan.tencentcloudapi.com', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TC-Action': 'DescribeVideoGenerationJob',
        'X-TC-Timestamp': Math.floor(Date.now() / 1000).toString(),
      },
      body: JSON.stringify({ JobId: task.Response.JobId }),
    });
    const pollData = await pollRes.json();
    if (pollData.Response.Status === 'Success') return pollData.Response.VideoUrl;
    if (pollData.Response.Status === 'Failed') throw new Error('混元视频生成失败');
  }
  throw new Error('混元视频生成超时');
}

// Sora2 视频生成（GrsAI第三方API）
async function callSora2Video(prompt, duration, apiKey) {
  // 提交任务到GrsAI
  const createRes = await fetch('https://grsai.dakka.com.cn/v1/video/sora-video', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'sora-2',
      prompt: prompt,
      duration: duration,
      aspectRatio: '16:9',
      webHook: '-1'
    })
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Sora2 API错误(${createRes.status}): ${errText}`);
  }

  const task = await createRes.json();
  const taskId = task.data?.id || task.id;

  // 轮询等待结果（最多10分钟，每10秒一次）
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 10000));

    const pollRes = await fetch('https://grsai.dakka.com.cn/v1/draw/result', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ id: taskId })
    });

    if (!pollRes.ok) continue;

    const pollData = await pollRes.json();
    const status = pollData.data?.status;
    console.log(`[sora2] poll ${i + 1}: status=${status}`);

    if (status === 'succeeded') {
      return pollData.data?.results?.[0]?.url || pollData.data?.result_url;
    }

    if (status === 'failed') {
      throw new Error(`Sora2视频生成失败: ${pollData.data?.error || ''}`);
    }
  }

  throw new Error('Sora2视频生成超时');
}

// Sora2 视频去水印（GrsAI第三方API）
async function callSora2RemoveWatermark(videoUrl, apiKey) {
  // 提交去水印任务到GrsAI
  const createRes = await fetch('https://grsai.dakka.com.cn/v1/video/remove-watermark', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      videoUrl: videoUrl,
      model: 'sora-2'
    })
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Sora2去水印API错误(${createRes.status}): ${errText}`);
  }

  const task = await createRes.json();
  const taskId = task.data?.id || task.id;

  // 轮询等待结果（最多10分钟，每10秒一次）
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 10000));

    const pollRes = await fetch('https://grsai.dakka.com.cn/v1/draw/result', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ id: taskId })
    });

    if (!pollRes.ok) continue;

    const pollData = await pollRes.json();
    const status = pollData.data?.status;
    console.log(`[sora2-remove-watermark] poll ${i + 1}: status=${status}`);

    if (status === 'succeeded') {
      return pollData.data?.results?.[0]?.url || pollData.data?.result_url;
    }

    if (status === 'failed') {
      throw new Error(`Sora2去水印失败: ${pollData.data?.error || ''}`);
    }
  }

  throw new Error('Sora2去水印超时');
}

async function callVeo3Video(prompt, apiKey) {
  // 提交任务到GrsAI Veo3.1
  const createRes = await fetch('https://api.grsai.com/v1/video/sora-video', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'veo-3.1',
      prompt: prompt,
      webhook: '-1'
    })
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Veo3.1 API错误(${createRes.status}): ${errText}`);
  }

  const task = await createRes.json();
  const taskId = task.task_id || task.id;

  // 轮询等待结果（最多10分钟，每10秒一次）
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 10000));

    const pollRes = await fetch(`https://api.grsai.com/v1/video/sora-video/${taskId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    if (!pollRes.ok) continue;

    const pollData = await pollRes.json();
    console.log(`[veo3] poll ${i + 1}: status=${pollData.status}`);

    if (pollData.status === 'completed' || pollData.status === 'succeeded') {
      return pollData.video_url || pollData.url || pollData.output?.url;
    }

    if (pollData.status === 'failed' || pollData.status === 'error') {
      throw new Error(`Veo3.1视频生成失败: ${pollData.error || pollData.message || ''}`);
    }
  }

  throw new Error('Veo3.1视频生成超时');
}

// POST /api/aitools/ai-video — AI视频生成（积分可配置，仅限注册用户）
router.post('/ai-video', auth, async (req, res) => {
  const { prompt, duration = 5 } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ message: '请输入视频描述' });

  // 从 settings 读取配置，默认使用智谱视觉模型
  const model = await getSetting('ai_video_model') || 'cogvideox';
  const cost = parseInt(await getSetting('ai_video_cost') || '5');

  const quota = await ensureQuota(req.user.id);
  if (quota.extra_quota < cost) {
    return res.status(403).json({ message: `积分不足，需要 ${cost} 积分，当前 ${quota.extra_quota} 积分`, code: 'QUOTA_EXCEEDED' });
  }
  await db.query('UPDATE user_quota SET extra_quota = extra_quota - ? WHERE user_id = ?', [cost, req.user.id]);
  await addQuotaLog(req.user.id, -cost, 'AI视频生成');

  try {
    let videoUrl = null;

    // 根据模型分发到不同厂商
    if (model.includes('doubao') || model.includes('seedance')) {
      const apiKey = await getSetting('doubao_video_api_key') || DOUBAO_API_KEY;
      if (!apiKey) throw new Error('豆包API密钥未配置，请联系管理员');
      videoUrl = await callDoubaoVideo(prompt.trim(), duration, apiKey);
    } else if (model.includes('kling')) {
      const accessKey = await getSetting('kling_access_key') || KLING_ACCESS_KEY;
      const secretKey = await getSetting('kling_secret_key') || KLING_SECRET_KEY;
      if (!accessKey || !secretKey) throw new Error('可灵API密钥未配置，请联系管理员');
      videoUrl = await callKlingVideo(prompt.trim(), duration, accessKey, secretKey);
    } else if (model.includes('cogvideo') || model.includes('zhipu')) {
      const apiKey = await getSetting('zhipu_api_key') || ZHIPU_API_KEY;
      if (!apiKey) throw new Error('智谱API密钥未配置，请联系管理员');
      videoUrl = await callZhipuVideo(prompt.trim(), apiKey);
    } else if (model.includes('wanx') || model.includes('dashscope')) {
      const apiKey = await getSetting('dashscope_api_key') || DASHSCOPE_API_KEY;
      if (!apiKey) throw new Error('通义API密钥未配置，请联系管理员');
      videoUrl = await callWanxVideo(prompt.trim(), apiKey);
    } else if (model.includes('hunyuan') || model.includes('tencent')) {
      const secretId = await getSetting('tencent_secret_id') || TENCENT_SECRET_ID;
      const secretKey = await getSetting('tencent_secret_key') || TENCENT_SECRET_KEY;
      if (!secretId || !secretKey) throw new Error('腾讯云API密钥未配置，请联系管理员');
      videoUrl = await callHunyuanVideo(prompt.trim(), secretId, secretKey);
    } else if (model.includes('sora2') || model.includes('sora-2')) {
      const apiKey = await getSetting('sora2_api_key') || SORA2_API_KEY;
      if (!apiKey) throw new Error('Sora2 API密钥未配置，请联系管理员');
      videoUrl = await callSora2Video(prompt.trim(), duration, apiKey);
    } else if (model.includes('veo3') || model.includes('veo-3')) {
      const apiKey = await getSetting('veo3_api_key') || VEO3_API_KEY;
      if (!apiKey) throw new Error('Veo3.1 API密钥未配置，请联系管理员');
      videoUrl = await callVeo3Video(prompt.trim(), apiKey);
    } else {
      throw new Error('不支持的视频模型');
    }

    res.json({ url: videoUrl });
  } catch (e) {
    await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [cost, req.user.id]);
    await addQuotaLog(req.user.id, cost, 'AI视频生成失败退还');
    res.status(500).json({ message: e.message || 'AI视频生成失败' });
  }
});

// GET /api/aitools/video-config — 获取视频生成配置（积分消耗）
router.get('/video-config', async (req, res) => {
  const cost = parseInt(await getSetting('ai_video_cost') || '5');
  res.json({ cost });
});

// POST /api/aitools/sora2-remove-watermark — Sora2视频去水印（5积分/次）
router.post('/sora2-remove-watermark', auth, async (req, res) => {
  const { videoUrl } = req.body;
  if (!videoUrl?.trim()) return res.status(400).json({ message: '请提供Sora2视频链接' });

  const cost = parseInt(await getSettingCached('cost_sora2_watermark', '5')) || 5; // hardcoded default: 5
  const quota = await ensureQuota(req.user.id);
  if (quota.extra_quota < cost) {
    return res.status(403).json({
      message: `积分不足，需要 ${cost} 积分，当前 ${quota.extra_quota} 积分`,
      code: 'QUOTA_EXCEEDED'
    });
  }

  await db.query('UPDATE user_quota SET extra_quota = extra_quota - ? WHERE user_id = ?', [cost, req.user.id]);
  await addQuotaLog(req.user.id, -cost, 'Sora2视频去水印');

  try {
    const apiKey = await getSetting('sora2_api_key') || SORA2_API_KEY;
    if (!apiKey) {
      await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [cost, req.user.id]);
      await addQuotaLog(req.user.id, cost, 'Sora2去水印失败退还');
      return res.status(500).json({ message: 'Sora2 API密钥未配置，请联系管理员' });
    }

    const cleanVideoUrl = await callSora2RemoveWatermark(videoUrl.trim(), apiKey);
    res.json({ url: cleanVideoUrl });
  } catch (e) {
    await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [cost, req.user.id]);
    await addQuotaLog(req.user.id, cost, 'Sora2去水印失败退还');
    res.status(500).json({ message: e.message || 'Sora2视频去水印失败' });
  }
});

// POST /api/aitools/sora2-remove-watermark-local — Sora2视频去水印（本地服务，5积分/次）
// 使用 SoraWatermarkCleaner (https://github.com/linkedlist771/SoraWatermarkCleaner)
router.post('/sora2-remove-watermark-local', auth, async (req, res) => {
  const { videoUrl, cleanerType = 'lama' } = req.body;
  if (!videoUrl?.trim()) return res.status(400).json({ message: '请提供Sora2视频链接' });

  const cost = parseInt(await getSettingCached('cost_sora2_watermark', '5')) || 5; // hardcoded default: 5
  const quota = await ensureQuota(req.user.id);
  if (quota.extra_quota < cost) {
    return res.status(403).json({
      message: `积分不足，需要 ${cost} 积分，当前 ${quota.extra_quota} 积分`,
      code: 'QUOTA_EXCEEDED'
    });
  }

  await db.query('UPDATE user_quota SET extra_quota = extra_quota - ? WHERE user_id = ?', [cost, req.user.id]);
  await addQuotaLog(req.user.id, -cost, 'Sora2视频去水印(本地)');

  try {
    // 获取本地 SoraWatermarkCleaner API 配置
    const localApiUrl = await getSetting('sora_wm_api_url') || process.env.SORA_WM_API_URL || 'http://localhost:5344';

    // 1. 下载视频
    console.log('[sora-wm-local] Downloading video from:', videoUrl.trim());
    const videoRes = await fetch(videoUrl.trim());
    if (!videoRes.ok) {
      throw new Error(`视频下载失败: ${videoRes.status}`);
    }
    const videoBuffer = await videoRes.arrayBuffer();

    // 2. 提交去水印任务到 SoraWatermarkCleaner
    const FormData = (await import('form-data')).default;
    const formData = new FormData();
    formData.append('video', Buffer.from(videoBuffer), {
      filename: 'video.mp4',
      contentType: 'video/mp4'
    });

    const submitUrl = `${localApiUrl}/api/v1/submit_remove_task?cleaner_type=${cleanerType}`;
    console.log('[sora-wm-local] Submitting task to:', submitUrl);

    const submitRes = await fetch(submitUrl, {
      method: 'POST',
      body: formData,
      headers: formData.getHeaders()
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text();
      throw new Error(`提交任务失败(${submitRes.status}): ${errText}`);
    }

    const submitData = await submitRes.json();
    const taskId = submitData.task_id;
    console.log('[sora-wm-local] Task submitted:', taskId);

    // 3. 轮询等待结果（最多10分钟，每5秒一次）
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 5000));

      const statusRes = await fetch(`${localApiUrl}/api/v1/get_results?remove_task_id=${taskId}`);
      if (!statusRes.ok) continue;

      const statusData = await statusRes.json();
      console.log(`[sora-wm-local] poll ${i + 1}: status=${statusData.status}, progress=${statusData.progress || 0}%`);

      if (statusData.status === 'FINISHED') {
        // 返回下载链接
        const downloadUrl = `${localApiUrl}/api/v1/download/${taskId}`;
        return res.json({
          url: downloadUrl,
          task_id: taskId,
          cleaner_type: cleanerType
        });
      }

      if (statusData.status === 'ERROR') {
        throw new Error(`去水印失败: ${statusData.error || '未知错误'}`);
      }
    }

    throw new Error('去水印超时（10分钟）');

  } catch (e) {
    console.error('[sora-wm-local] Error:', e);
    await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [cost, req.user.id]);
    await addQuotaLog(req.user.id, cost, 'Sora2去水印(本地)失败退还');
    res.status(500).json({ message: e.message || 'Sora2视频去水印(本地)失败' });
  }
});

// POST /api/aitools/ai-3d — 3D生成（5积分/次）图生3D，需要传图片URL
router.post('/ai-3d', auth, async (req, res) => {
  const { imageUrl, meshquality = 'high', fileformat = 'obj' } = req.body;
  if (!imageUrl?.trim()) return res.status(400).json({ message: '请提供图片URL' });

  const cost = parseInt(await getSettingCached('cost_3d_generate', '5')) || 5; // hardcoded default: 5
  const quota = await ensureQuota(req.user.id);
  if (quota.extra_quota < cost) {
    return res.status(403).json({ message: `积分不足，需要 ${cost} 积分，当前 ${quota.extra_quota} 积分`, code: 'QUOTA_EXCEEDED' });
  }
  await db.query('UPDATE user_quota SET extra_quota = extra_quota - ? WHERE user_id = ?', [cost, req.user.id]);
  await addQuotaLog(req.user.id, -cost, 'AI 3D生成');

  const d3RateLimitErr = await arkRateLimiter.consume();
  if (d3RateLimitErr) {
    await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [cost, req.user.id]);
    await addQuotaLog(req.user.id, cost, 'AI 3D生成失败退还');
    return res.status(429).json({ message: d3RateLimitErr.message, code: 'ARK_RATE_LIMITED', retryAfter: d3RateLimitErr.retryAfter });
  }

  const arkBaseUrl3d = await getArkBaseUrl();
  try {
    const createRes = await fetch(`${arkBaseUrl3d}/contents/generations/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DOUBAO_API_KEY}` },
      body: JSON.stringify({
        model: await get3DModel(),
        content: [
          { type: 'text', text: ` --meshquality ${meshquality} --fileformat ${fileformat}` },
          { type: 'image_url', image_url: { url: imageUrl.trim() } },
        ],
      }),
    });
    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error('[ai-3d] create error:', createRes.status, errText);
      await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [cost, req.user.id]);
      await addQuotaLog(req.user.id, cost, 'AI 3D生成失败退还');
      return res.status(500).json({ message: `3D任务提交失败(${createRes.status}): ${errText}` });
    }
    const task = await createRes.json();
    const taskId = task.id;

    // 轮询等待结果（最多150秒，每5秒一次）
    let resultUrl = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollRes = await fetch(`${arkBaseUrl3d}/contents/generations/tasks/${taskId}`, {
        headers: { 'Authorization': `Bearer ${DOUBAO_API_KEY}` },
      });
      const pollData = await pollRes.json();
      console.log(`[ai-3d] poll ${i + 1}: status=${pollData.status}`);
      if (pollData.status === 'succeeded') {
        resultUrl = pollData.content?.[0]?.url || pollData.content?.[0]?.file_url || '';
        break;
      }
      if (pollData.status === 'failed') {
        await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [cost, req.user.id]);
        await addQuotaLog(req.user.id, cost, 'AI 3D生成失败退还');
        return res.status(500).json({ message: `3D生成失败: ${pollData.error?.message || ''}` });
      }
    }
    if (!resultUrl) {
      await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [cost, req.user.id]);
      await addQuotaLog(req.user.id, cost, 'AI 3D生成超时退还');
      return res.status(500).json({ message: '3D生成超时，积分已退还' });
    }
    res.json({ url: resultUrl });
  } catch (e) {
    res.status(500).json({ message: e.message || 'AI 3D生成失败' });
  }
});

// 辅助函数：根据宽高比生成图片
async function callImageWithSize(prompt, aspectRatio, apiKey) {
  const imgSizeRateLimitErr = await arkRateLimiter.consume();
  if (imgSizeRateLimitErr) throw imgSizeRateLimitErr;

  // 豆包图片模型只支持正方形，暂时都使用2048x2048
  // TODO: 后续可以通过裁剪或其他方式支持不同宽高比
  const size = '2048x2048';

  const arkBaseUrlImg = await getArkBaseUrl();
  const imageModelName = await getImageModel();
  const response = await fetch(`${arkBaseUrlImg}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: imageModelName, prompt, size, n: 1 }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`图片生成失败: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.data?.[0]?.url || '';
}

// POST /api/aitools/ai-comic — AI漫剧生成（25积分）
router.post('/ai-comic', auth, async (req, res) => {
  const { theme, aspect_ratio = '9:16' } = req.body;

  if (!theme?.trim()) {
    return res.status(400).json({ message: '请输入漫剧主题' });
  }

  // 验证宽高比参数
  if (!['9:16', '16:9'].includes(aspect_ratio)) {
    return res.status(400).json({ message: '宽高比只支持 9:16 或 16:9' });
  }

  const cost = parseInt(await getSettingCached('cost_comic_generate', '25')) || 25; // hardcoded default: 25
  const quota = await ensureQuota(req.user.id);

  if (quota.extra_quota < cost) {
    return res.status(403).json({
      message: `积分不足，需要 ${cost} 积分，当前 ${quota.extra_quota} 积分`,
      code: 'QUOTA_EXCEEDED'
    });
  }

  // 扣除积分
  await db.query('UPDATE user_quota SET extra_quota = extra_quota - ? WHERE user_id = ?', [cost, req.user.id]);
  await addQuotaLog(req.user.id, -cost, 'AI漫剧生成');

  try {
    const apiKey = DOUBAO_API_KEY;
    if (!apiKey) {
      throw new Error('豆包API密钥未配置，请联系管理员');
    }

    const zhipuKey = await getSetting('zhipu_api_key') || ZHIPU_API_KEY;
    if (!zhipuKey) {
      throw new Error('智谱API密钥未配置，请联系管理员');
    }

    // 步骤1: 生成剧本（使用豆包文字模型）
    console.log('[ai-comic] 步骤1: 生成剧本...');
    const scriptPrompt = `请为主题"${theme}"创建一个短漫剧剧本。

要求：
1. 包含2-3个主要角色，每个角色有清晰的外貌特征描述
2. 包含3-4个关键分镜场景
3. 每个分镜包含：场景描述、角色动作、对话内容
4. 剧情要有起承转合，适合短视频呈现

输出格式（严格按照此格式）：
【角色设定】
角色1: [名字] - [外貌特征详细描述]
角色2: [名字] - [外貌特征详细描述]

【分镜脚本】
分镜1: [场景描述] - [角色动作] - [对话]
分镜2: [场景描述] - [角色动作] - [对话]
分镜3: [场景描述] - [角色动作] - [对话]

直接输出剧本，不要其他内容。`;

    const comicArkBaseUrl = await getArkBaseUrl();
    const comicTextModel = await getTextModel();
    const scriptRes = await fetch(`${comicArkBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: comicTextModel,
        messages: [{ role: 'user', content: scriptPrompt }],
        max_tokens: 1000,
        temperature: 0.8
      })
    });

    if (!scriptRes.ok) {
      throw new Error('剧本生成失败');
    }

    const scriptData = await scriptRes.json();
    const script = scriptData.choices?.[0]?.message?.content || '';

    if (!script) {
      throw new Error('剧本生成失败：返回内容为空');
    }

    console.log('[ai-comic] 剧本生成成功');

    // 解析剧本，提取角色和分镜
    const characterMatch = script.match(/【角色设定】([\s\S]*?)【分镜脚本】/);
    const storyboardMatch = script.match(/【分镜脚本】([\s\S]*)/);

    if (!characterMatch || !storyboardMatch) {
      throw new Error('剧本格式解析失败');
    }

    const charactersText = characterMatch[1].trim();
    const storyboardText = storyboardMatch[1].trim();

    // 提取角色描述
    const characterLines = charactersText.split('\n').filter(line => line.trim());
    const characters = [];

    for (const line of characterLines) {
      const match = line.match(/角色\d+:\s*(.+?)\s*-\s*(.+)/);
      if (match) {
        characters.push({
          name: match[1].trim(),
          description: match[2].trim()
        });
      }
    }

    // 步骤2: 生成角色形象（使用豆包图片模型）
    console.log('[ai-comic] 步骤2: 生成角色形象...');
    const characterImages = [];

    for (let i = 0; i < Math.min(characters.length, 3); i++) {
      const char = characters[i];
      const charPrompt = `漫画风格角色设计：${char.description}。高质量，细节丰富，专业插画`;

      try {
        const imageUrl = await callImageWithSize(charPrompt, aspect_ratio, apiKey);
        characterImages.push({
          name: char.name,
          description: char.description,
          image_url: imageUrl
        });
        console.log(`[ai-comic] 角色 ${char.name} 生成成功`);
      } catch (error) {
        console.error(`[ai-comic] 角色 ${char.name} 生成失败:`, error.message);
        // 继续生成其他角色
      }
    }

    // 提取分镜描述
    const storyboardLines = storyboardText.split('\n').filter(line => line.trim() && line.includes('分镜'));
    const storyboards = [];

    for (const line of storyboardLines) {
      const match = line.match(/分镜\d+:\s*(.+)/);
      if (match) {
        storyboards.push(match[1].trim());
      }
    }

    // 步骤3: 生成分镜图片（使用豆包图片模型）
    console.log('[ai-comic] 步骤3: 生成分镜图片...');
    const storyboardImages = [];

    for (let i = 0; i < Math.min(storyboards.length, 4); i++) {
      const scene = storyboards[i];
      const scenePrompt = `漫画分镜：${scene}。电影级构图，动态感强，漫画风格，高质量`;

      try {
        const imageUrl = await callImageWithSize(scenePrompt, aspect_ratio, apiKey);
        storyboardImages.push({
          scene_number: i + 1,
          description: scene,
          image_url: imageUrl
        });
        console.log(`[ai-comic] 分镜 ${i + 1} 生成成功`);
      } catch (error) {
        console.error(`[ai-comic] 分镜 ${i + 1} 生成失败:`, error.message);
      }
    }

    // 步骤4: 生成分镜视频（使用智谱视觉模型，只生成第一个分镜）
    console.log('[ai-comic] 步骤4: 生成分镜视频...');
    let videoUrl = null;

    if (storyboards.length > 0) {
      const firstScene = storyboards[0];
      const videoPrompt = `${firstScene}。电影级画面，流畅动作`;

      try {
        videoUrl = await callZhipuVideo(videoPrompt, zhipuKey);
        console.log('[ai-comic] 视频生成成功');
      } catch (error) {
        console.error('[ai-comic] 视频生成失败:', error.message);
        // 视频生成失败不影响整体结果
      }
    }

    // 返回完整结果
    res.json({
      script,
      characters: characterImages,
      storyboards: storyboardImages,
      video_url: videoUrl,
      aspect_ratio
    });

  } catch (error) {
    console.error('[ai-comic] 生成失败:', error.message);
    // 退还积分
    await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [cost, req.user.id]);
    await addQuotaLog(req.user.id, cost, 'AI漫剧生成失败退还');
    res.status(500).json({ message: error.message || 'AI漫剧生成失败' });
  }
});

// POST /api/aitools/sora2-page-remove-watermark — Sora2页面链接去水印（自动提取视频URL，5积分/次）
router.post('/sora2-page-remove-watermark', auth, async (req, res) => {
  const { pageUrl, cleanerType = 'lama' } = req.body;
  if (!pageUrl?.trim()) return res.status(400).json({ message: '请提供Sora2页面链接' });

  // 验证是否为 Sora 页面链接
  if (!pageUrl.includes('sora.chatgpt.com')) {
    return res.status(400).json({ message: '请提供有效的Sora页面链接（sora.chatgpt.com）' });
  }

  const cost = parseInt(await getSettingCached('cost_sora2_watermark', '5')) || 5; // hardcoded default: 5
  const quota = await ensureQuota(req.user.id);
  if (quota.extra_quota < cost) {
    return res.status(403).json({
      message: `积分不足，需要 ${cost} 积分，当前 ${quota.extra_quota} 积分`,
      code: 'QUOTA_EXCEEDED'
    });
  }

  await db.query('UPDATE user_quota SET extra_quota = extra_quota - ? WHERE user_id = ?', [cost, req.user.id]);
  await addQuotaLog(req.user.id, -cost, 'Sora2页面去水印(本地)');

  let browser = null;
  try {
    console.log('[sora-page-wm] Extracting video URL from:', pageUrl);

    // 使用 Puppeteer 提取视频 URL
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();

    // 设置用户代理
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    let videoUrl = null;

    // 监听网络请求，捕获视频 URL
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('.mp4') || url.includes('video')) {
        console.log('[sora-page-wm] Found video URL:', url);
        videoUrl = url;
      }
    });

    // 访问页面
    await page.goto(pageUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // 等待视频加载（使用 setTimeout 替代已废弃的 waitForTimeout）
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 尝试从页面中提取视频 URL 和文案
    let pageText = null;
    if (!videoUrl) {
      const extracted = await page.evaluate(() => {
        // 查找 video 标签
        const videoElement = document.querySelector('video');
        if (videoElement && videoElement.src) {
          return videoElement.src;
        }

        // 查找 source 标签
        const sourceElement = document.querySelector('video source');
        if (sourceElement && sourceElement.src) {
          return sourceElement.src;
        }

        // 从页面内容中搜索 mp4 链接
        const bodyText = document.body.innerHTML;
        const mp4Match = bodyText.match(/https:\/\/[^"'\s]+\.mp4[^"'\s]*/);
        if (mp4Match) {
          return mp4Match[0];
        }

        return null;
      });
      videoUrl = extracted;
    }

    // 提取页面文案
    pageText = await page.evaluate(() => {
      // 尝试从多个位置提取文案
      let text = '';

      // 1. 尝试获取描述性文本（可能是标题下方的内容）
      const candidates = [
        // 标题旁边的描述
        document.querySelector('[class*="description"]')?.textContent,
        document.querySelector('[class*="desc"]')?.textContent,
        // 段落文本
        document.querySelector('p')?.textContent,
        // Meta描述
        document.querySelector('meta[name="description"]')?.getAttribute('content'),
        // 文本区域
        document.querySelector('[role="textbox"]')?.textContent,
        document.querySelector('textarea')?.textContent,
        // 可能的评论区域
        document.querySelector('[class*="comment"]')?.textContent,
      ];

      // 选择最长的非空文本
      for (const t of candidates) {
        if (t && t.trim().length > text.length) {
          text = t.trim();
        }
      }

      // 如果还是太短，尝试获取页面标题
      if (text.length < 10) {
        text = document.title;
      }

      return text || '';
    });

    if (pageText && pageText.length > 500) {
      pageText = pageText.substring(0, 500) + '...';
    }

    await browser.close();
    browser = null;

    if (!videoUrl) {
      throw new Error('无法从页面中提取视频URL，请确保链接有效');
    }

    console.log('[sora-page-wm] Extracted video URL:', videoUrl);

    // 获取本地 SoraWatermarkCleaner API 配置
    const localApiUrl = await getSetting('sora_wm_api_url') || process.env.SORA_WM_API_URL || 'http://localhost:5344';

    // 下载视频
    console.log('[sora-page-wm] Downloading video from:', videoUrl);
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) {
      throw new Error(`视频下载失败: ${videoRes.status}`);
    }
    const videoBuffer = await videoRes.arrayBuffer();

    // 提交去水印任务到 SoraWatermarkCleaner
    const FormData = (await import('form-data')).default;
    const formData = new FormData();
    formData.append('video', Buffer.from(videoBuffer), {
      filename: 'video.mp4',
      contentType: 'video/mp4'
    });

    const submitUrl = `${localApiUrl}/api/v1/submit_remove_task?cleaner_type=${cleanerType}`;
    console.log('[sora-page-wm] Submitting task to:', submitUrl);

    const submitRes = await fetch(submitUrl, {
      method: 'POST',
      body: formData,
      headers: formData.getHeaders()
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text();
      throw new Error(`提交任务失败(${submitRes.status}): ${errText}`);
    }

    const submitData = await submitRes.json();
    const taskId = submitData.task_id;
    console.log('[sora-page-wm] Task submitted:', taskId);

    // 轮询等待结果（最多10分钟，每5秒一次）
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 5000));

      const statusRes = await fetch(`${localApiUrl}/api/v1/get_results?remove_task_id=${taskId}`);
      if (!statusRes.ok) continue;

      const statusData = await statusRes.json();
      console.log(`[sora-page-wm] poll ${i + 1}: status=${statusData.status}, progress=${statusData.progress || 0}%`);

      if (statusData.status === 'FINISHED') {
        const downloadUrl = `${localApiUrl}/api/v1/download/${taskId}`;
        return res.json({
          url: downloadUrl,
          task_id: taskId,
          cleaner_type: cleanerType,
          extracted_video_url: videoUrl,
          page_text: pageText
        });
      }

      if (statusData.status === 'ERROR') {
        throw new Error(`去水印失败: ${statusData.error || '未知错误'}`);
      }
    }

    throw new Error('去水印超时（10分钟）');

  } catch (e) {
    console.error('[sora-page-wm] Error:', e);
    if (browser) {
      await browser.close();
    }
    await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [cost, req.user.id]);
    await addQuotaLog(req.user.id, cost, 'Sora2页面去水印(本地)失败退还');
    res.status(500).json({ message: e.message || 'Sora2页面去水印失败' });
  }
});

// ========== 去水印功能（调用第三方服务）==========
// 去水印服务 API Key
const WATERMARK_API_KEY = 'han1234'; // kept as fallback default

// 去水印接口（使用第三方API解析+本地获取文案）
router.post('/remove-watermark', auth, async (req, res) => {
  const { url } = req.body;

  if (!url || !url.trim()) {
    return res.status(400).json({ message: '请输入视频链接' });
  }

  try {
    const trimmedUrl = url.trim();
    console.log('[remove-watermark] Processing:', trimmedUrl);

    // 1. 检查缓存
    const [cached] = await db.query(
      'SELECT * FROM watermark_cache WHERE original_url = ? ORDER BY created_at DESC LIMIT 1',
      [trimmedUrl]
    );

    let videoUrl, pageText = '';
    let fromCache = false;

    if (cached.length > 0 && cached[0].success) {
      console.log('[remove-watermark] Cache hit:', trimmedUrl);
      videoUrl = cached[0].video_url;
      pageText = cached[0].page_text || '';
      fromCache = true;
    } else {
      console.log('[remove-watermark] Cache miss, calling API:', trimmedUrl);

      // 调用解析接口获取视频URL
      const response = await fetch('https://s2mw.opensora2.cn/api/parse-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${await getSettingCached('watermark_api_key', WATERMARK_API_KEY)}`
        },
        body: JSON.stringify({ url: trimmedUrl })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const errorMsg = errData.message || `请求失败: ${response.status}`;

        // 记录失败到缓存
        await db.query(
          'INSERT INTO watermark_cache (original_url, success, error_message) VALUES (?, FALSE, ?)',
          [trimmedUrl, errorMsg]
        );

        throw new Error(errorMsg);
      }

      const data = await response.json();

      videoUrl = data.video_url || data.download_link;
      if (!data.success || !videoUrl) {
        const errorMsg = data.message || '解析失败';

        // 记录失败到缓存
        await db.query(
          'INSERT INTO watermark_cache (original_url, success, error_message) VALUES (?, FALSE, ?)',
          [trimmedUrl, errorMsg]
        );

        throw new Error(errorMsg);
      }

      console.log('[remove-watermark] Video URL:', videoUrl);

      // 2. 使用Puppeteer提取页面文案
      try {
        const puppeteer = require('puppeteer');
        const browser = await puppeteer.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        await page.goto(trimmedUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 3000));

        pageText = await page.evaluate(() => {
          let text = '';
          const candidates = [
            document.querySelector('[class*="description"]')?.textContent,
            document.querySelector('[class*="desc"]')?.textContent,
            document.querySelector('p')?.textContent,
            document.querySelector('meta[name="description"]')?.getAttribute('content'),
            document.querySelector('[role="textbox"]')?.textContent,
            document.querySelector('textarea')?.textContent,
            document.querySelector('[class*="comment"]')?.textContent,
            document.querySelector('h1')?.nextElementSibling?.textContent,
          ];
          for (const t of candidates) {
            if (t && t.trim().length > text.length) text = t.trim();
          }
          if (text.length < 10) text = document.title;
          return text || '';
        });

        if (pageText && pageText.length > 500) {
          pageText = pageText.substring(0, 500) + '...';
        }

        // 检测是否是安全提示页面
        if (pageText.includes('security service') || pageText.includes('Cloudflare') || pageText.includes('online attacks')) {
          pageText = '';
          console.log('[remove-watermark] Page text ignored (security page detected)');
        }

        await browser.close();
        console.log('[remove-watermark] Page text extracted, length:', pageText.length);
      } catch (e) {
        console.log('[remove-watermark] Failed to extract page text:', e.message);
      }

      // 记录成功到缓存
      await db.query(
        'INSERT INTO watermark_cache (original_url, video_url, page_text, success) VALUES (?, ?, ?, TRUE)',
        [trimmedUrl, videoUrl, pageText]
      );

      console.log('[remove-watermark] Cached new result');
    }

    // 如果指定了download_to_local参数，下载视频到本地
    let localVideoPath = null;
    let aiDescription = '';
    if (req.body.download_to_local) {
      try {
        const filename = `watermark-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.mp4`;
        localVideoPath = await downloadVideo(videoUrl, filename);
        console.log('[remove-watermark] Video downloaded locally:', localVideoPath);

        // 如果没有文案，分析视频内容
        if (!pageText || pageText.trim().length === 0) {
          console.log('[remove-watermark] No text found, analyzing video content...');
          const videoFullPath = path.join(UPLOAD_DIR, localVideoPath);
          aiDescription = await analyzeVideoContent(videoFullPath);
          if (aiDescription) {
            pageText = aiDescription;
            console.log('[remove-watermark] AI generated description:', aiDescription.substring(0, 50) + '...');
          }
        }
      } catch (e) {
        console.error('[remove-watermark] Failed to download video locally:', e.message);
      }
    }

    res.json({
      success: true,
      video_url: videoUrl,
      pageText: pageText,
      local_video_url: localVideoPath ? `/uploads/${localVideoPath}` : null,
      from_cache: fromCache,
      ai_generated: aiDescription ? true : false
    });

  } catch (e) {
    console.error('[remove-watermark] Error:', e);
    res.status(500).json({ message: e.message || '去水印失败' });
  }
});

// 使用 Puppeteer 下载视频（绕过 Cloudflare）
async function downloadVideo(url, filename) {
  const filePath = path.join(AITOOLS_DIR, filename);

  try {
    console.log('[downloadVideo] Starting Puppeteer download:', url);

    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();

    // 监听响应，获取视频数据
    let videoBuffer = null;
    page.on('response', async (response) => {
      const responseUrl = response.url();
      if (responseUrl === url && response.status() === 200) {
        try {
          videoBuffer = await response.buffer();
          console.log('[downloadVideo] Captured video buffer:', videoBuffer.length, 'bytes');
        } catch (e) {
          console.error('[downloadVideo] Failed to get buffer:', e.message);
        }
      }
    });

    // 访问视频 URL
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });

    await browser.close();

    if (!videoBuffer || videoBuffer.length === 0) {
      throw new Error('Failed to capture video data');
    }

    // 写入文件
    fs.writeFileSync(filePath, videoBuffer);
    console.log('[downloadVideo] File saved:', filePath);

    // 返回相对路径
    return path.relative(UPLOAD_DIR, filePath).replace(/\\/g, '/');

  } catch (err) {
    console.error('[downloadVideo] Download error:', err);
    throw err;
  }
}

module.exports = router;
