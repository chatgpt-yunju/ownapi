const router = require('express').Router();
const db = require('../config/db');
const { auth } = require('../middleware/auth');
const { getSettingCached } = require('./quota');
const axios = require('axios');
const arkRateLimiter = require('../utils/arkRateLimiter');
require('dotenv').config();

function todayCST() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

// 从数据库获取分类列表
async function getCategories() {
  const [rows] = await db.query('SELECT name FROM categories ORDER BY id');
  return rows.map(r => r.name);
}

// 平台列表
const PLATFORMS = {
  domestic: ['视频号', '抖音', '小红书', '快手'],
  international: ['TikTok', 'Instagram', 'YouTube', 'Facebook', 'LinkedIn']
};

// 链接解析：识别平台
function parsePlatform(link) {
  const url = link.toLowerCase();

  // 国内平台
  if (url.includes('weixin.qq.com') || url.includes('channels.weixin')) return '视频号';
  if (url.includes('douyin.com')) return '抖音';
  if (url.includes('xiaohongshu.com') || url.includes('xhslink.com')) return '小红书';
  if (url.includes('kuaishou.com')) return '快手';

  // 国外平台
  if (url.includes('tiktok.com')) return 'TikTok';
  if (url.includes('instagram.com')) return 'Instagram';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'YouTube';
  if (url.includes('facebook.com') || url.includes('fb.com')) return 'Facebook';
  if (url.includes('linkedin.com')) return 'LinkedIn';

  return null;
}

// 运行时迁移：添加 platform 字段
(async () => {
  try {
    await db.query(`
      ALTER TABLE benchmark_submissions
      ADD COLUMN platform VARCHAR(32) DEFAULT NULL
    `);
    console.log('[Benchmark] 添加 platform 字段成功');
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') {
      console.error('[Benchmark] 添加 platform 字段失败:', e.message);
    }
  }
})();

// 运行时迁移：添加 analysis 和 script 字段
(async () => {
  try {
    await db.query(`
      ALTER TABLE benchmark_submissions
      ADD COLUMN analysis TEXT DEFAULT NULL
    `);
    console.log('[Benchmark] 添加 analysis 字段成功');
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') {
      console.error('[Benchmark] 添加 analysis 字段失败:', e.message);
    }
  }

  try {
    await db.query(`
      ALTER TABLE benchmark_submissions
      ADD COLUMN script TEXT DEFAULT NULL
    `);
    console.log('[Benchmark] 添加 script 字段成功');
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') {
      console.error('[Benchmark] 添加 script 字段失败:', e.message);
    }
  }
})();

// POST /api/benchmark/submit — 用户投稿对标素材
router.post('/submit', auth, async (req, res) => {
  const { social_link, reason, category, platform, analysis, script } = req.body;

  // 参数验证
  if (!social_link?.trim()) {
    return res.status(400).json({ message: '请输入社媒链接' });
  }
  if (!reason?.trim()) {
    return res.status(400).json({ message: '请输入投稿原因' });
  }

  // 验证分类是否有效
  const categories = await getCategories();
  if (!category || !categories.includes(category)) {
    return res.status(400).json({ message: '请选择有效的分类' });
  }

  // 验证平台是否有效
  const allPlatforms = [...PLATFORMS.domestic, ...PLATFORMS.international];
  if (!platform || !allPlatforms.includes(platform)) {
    return res.status(400).json({ message: '请选择有效的平台' });
  }

  const link = social_link.trim();
  const reasonText = reason.trim();

  // 链接格式验证（支持国内外平台）
  const validDomains = [
    'douyin.com', 'kuaishou.com', 'xiaohongshu.com', 'xhslink.com',
    'weixin.qq.com', 'channels.weixin',
    'tiktok.com', 'instagram.com', 'youtube.com', 'youtu.be',
    'facebook.com', 'fb.com', 'linkedin.com'
  ];
  const isValidLink = validDomains.some(domain => link.includes(domain));
  if (!isValidLink) {
    return res.status(400).json({
      message: '请输入有效的社媒链接'
    });
  }

  // 检查今日投稿数量
  const today = todayCST();
  const [[{ count }]] = await db.query(
    'SELECT COUNT(*) as count FROM benchmark_submissions WHERE user_id = ? AND DATE(created_at) = ?',
    [req.user.id, today]
  );

  if (count >= 100) {
    return res.status(400).json({ message: '今日投稿已达上限（100个）' });
  }

  // 重复链接检测
  const [[existing]] = await db.query(
    'SELECT id, user_id FROM benchmark_submissions WHERE social_link = ?',
    [link]
  );

  if (existing) {
    if (existing.user_id === req.user.id) {
      return res.status(400).json({ message: '您已经投稿过这个链接了' });
    } else {
      return res.status(400).json({ message: '该链接已被其他用户投稿' });
    }
  }

  // 插入投稿记录
  await db.query(
    'INSERT INTO benchmark_submissions (user_id, social_link, reason, category, platform, analysis, script) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [req.user.id, link, reasonText, category, platform, analysis || null, script || null]
  );

  // 发放奖励积分
  await db.query(
    'INSERT INTO user_quota (user_id, extra_quota) VALUES (?, 1) ON DUPLICATE KEY UPDATE extra_quota = extra_quota + 1',
    [req.user.id]
  );

  const { addQuotaLog } = require('./quota');
  await addQuotaLog(req.user.id, 1, '对标素材投稿');

  res.json({
    message: '投稿成功，获得 1 积分！',
    remaining: 100 - count - 1
  });
});

// POST /api/benchmark/parse-link — 解析链接识别平台
router.post('/parse-link', auth, async (req, res) => {
  const { link } = req.body;

  if (!link?.trim()) {
    return res.status(400).json({ message: '请输入链接' });
  }

  const platform = parsePlatform(link.trim());

  if (!platform) {
    return res.status(400).json({ message: '无法识别平台，请检查链接是否正确' });
  }

  res.json({ platform });
});

// POST /api/benchmark/smart-parse — 智能解析混合内容
router.post('/smart-parse', auth, async (req, res) => {
  const { content, deep_analysis } = req.body;

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
  let isYuanbaoLink = false;

  // 尝试提取链接
  for (const pattern of urlPatterns) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      // 取第一个匹配的链接
      extractedLink = matches[0];
      // 清理链接末尾可能的标点符号
      extractedLink = extractedLink.replace(/[。，、；：！？）】》"'\s]+$/, '');

      // 检查是否为元宝链接
      if (extractedLink.includes('yb.tencent.com')) {
        isYuanbaoLink = true;
      }
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

  // 识别平台（元宝链接默认为视频号）
  let platform;
  if (isYuanbaoLink) {
    platform = '视频号';
  } else {
    platform = parsePlatform(extractedLink);
  }

  const result = {
    link: extractedLink,
    platform: platform || null
  };

  // 如果启用深度分析，调用豆包AI
  if (deep_analysis) {
    const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY;
    if (!DOUBAO_API_KEY) {
      return res.json({ ...result, analysis: null, script: null, error: 'AI服务未配置' });
    }

    try {
      const analysisPrompt = `作为短视频运营专家，请分析以下社媒内容的爆款理由：

原始内容：
${text}

链接：${extractedLink}
平台：${platform || '未知'}

请从以下角度分析（100-150字）：
1. 内容亮点和创意
2. 为什么能成为爆款
3. 值得学习的运营技巧

直接输出分析结果，不要其他内容。`;

      const scriptPrompt = `基于以下爆款内容，生成一个AI视频脚本：

原始内容：
${text}

要求：
- 时长：10秒
- 脚本要简洁有力，适合短视频
- 包含镜头描述和台词

格式：
【镜头】描述
【台词】内容

直接输出脚本，不要其他内容。`;

      const { callAI: benchCallAI } = require('../utils/aiGateway');
      const benchUserId = req.user?.id || 1;
      const [analysis, script] = await Promise.all([
        benchCallAI(analysisPrompt, { userId: benchUserId, tier: 'medium', max_tokens: 300, temperature: 0.7 }),
        benchCallAI(scriptPrompt, { userId: benchUserId, tier: 'medium', max_tokens: 300, temperature: 0.8 }),
      ]);

      result.analysis = analysis?.trim() || null;
      result.script = script?.trim() || null;
    } catch (error) {
      console.error('[AI深度分析失败]', error.message);
      result.analysis = null;
      result.script = null;
      result.error = 'AI分析失败';
    }
  }

  res.json(result);
});

// POST /api/benchmark/generate-reason — AI生成推荐原因
router.post('/generate-reason', auth, async (req, res) => {
  const { link, platform, category } = req.body;

  if (!link?.trim()) {
    return res.status(400).json({ message: '请提供链接' });
  }

  const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY;
  if (!DOUBAO_API_KEY) {
    return res.status(500).json({ message: 'AI服务未配置' });
  }

  try {
    const prompt = `作为短视频运营专家，请为以下对标素材生成推荐原因（50-100字）：

平台：${platform || '未知'}
分类：${category || '未知'}
链接：${link}

请从以下角度分析：
1. 内容质量和创意
2. 数据表现（如果能推测）
3. 值得学习的地方

直接输出推荐原因，不要其他内容。`;

    const { callAI: reasonCallAI } = require('../utils/aiGateway');
    const reason = (await reasonCallAI(prompt, { userId: req.user.id, tier: 'simple', max_tokens: 200, temperature: 0.7 }))?.trim();

    if (!reason) {
      return res.status(500).json({ message: 'AI生成失败，请重试' });
    }

    res.json({ reason });
  } catch (error) {
    console.error('[AI生成推荐原因失败]', error.message);
    res.status(500).json({ message: 'AI生成失败，请稍后重试' });
  }
});

// POST /api/benchmark/generate-video — AI生成视频（5积分/次，每日3次）
router.post('/generate-video', auth, async (req, res) => {
  const { script, duration = 3 } = req.body;

  if (!script?.trim()) {
    return res.status(400).json({ message: '请提供视频脚本' });
  }

  // 验证时长参数
  const validDurations = [3, 5, 10];
  if (!validDurations.includes(duration)) {
    return res.status(400).json({ message: '无效的视频时长，支持3/5/10秒' });
  }

  const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY;
  // Original: const DOUBAO_VIDEO_MODEL = 'doubao-seedance-1-0-lite-t2v-250428';
  const videoModel = await getSettingCached('doubao_video_model', 'doubao-seedance-1-0-lite-t2v-250428');

  if (!DOUBAO_API_KEY) {
    return res.status(500).json({ message: 'AI服务未配置' });
  }

  const cost = 5;
  const { ensureQuota, addQuotaLog } = require('./quota');

  try {
    // 检查今日生成次数（普通用户限制3次/天）
    const today = todayCST();
    const [[{ count }]] = await db.query(
      `SELECT COUNT(*) as count FROM quota_logs
       WHERE user_id = ? AND reason = 'AI视频生成' AND DATE(created_at) = ?`,
      [req.user.id, today]
    );

    const dailyLimit = 10;
    if (count >= dailyLimit) {
      return res.status(403).json({
        message: `今日视频生成次数已达上限（${dailyLimit}次），明天再来吧`,
        code: 'DAILY_LIMIT_EXCEEDED'
      });
    }

    // 检查积分
    const quota = await ensureQuota(req.user.id);
    if (quota.extra_quota < cost) {
      return res.status(403).json({
        message: `积分不足，需要 ${cost} 积分，当前 ${quota.extra_quota} 积分`,
        code: 'QUOTA_EXCEEDED'
      });
    }

    // 扣除积分
    await db.query('UPDATE user_quota SET extra_quota = extra_quota - ? WHERE user_id = ?', [cost, req.user.id]);
    await addQuotaLog(req.user.id, -cost, 'AI视频生成');

    // 提交视频生成任务（使用用户选择的时长）
    const rlErr = await arkRateLimiter.consume();
    if (rlErr) return res.status(429).json({ message: rlErr.message, code: 'ARK_RATE_LIMITED', retryAfter: rlErr.retryAfter });
    const videoArkBaseUrl = await getSettingCached('ark_base_url', 'https://ark.cn-beijing.volces.com/api/v3');
    const createRes = await axios.post(
      `${videoArkBaseUrl}/contents/generations/tasks`,
      {
        model: videoModel,
        content: [{ type: 'text', text: `${script.trim()} --duration ${duration} --camerafixed false` }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DOUBAO_API_KEY}`
        },
        timeout: 30000
      }
    );

    const task = createRes.data;
    const taskId = task.id;

    // 轮询等待结果（最多150秒，每5秒一次）
    let videoUrl = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 5000));

      const pollRes = await axios.get(
        `${videoArkBaseUrl}/contents/generations/tasks/${taskId}`,
        {
          headers: { 'Authorization': `Bearer ${DOUBAO_API_KEY}` }
        }
      );

      const pollData = pollRes.data;
      console.log(`[benchmark-video] poll ${i + 1}: status=${pollData.status}`);

      if (pollData.status === 'succeeded') {
        videoUrl = pollData.content?.video_url;
        break;
      }

      if (pollData.status === 'failed') {
        await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [cost, req.user.id]);
        await addQuotaLog(req.user.id, cost, 'AI视频生成失败退还');
        return res.status(500).json({ message: `视频生成失败: ${pollData.error?.message || '未知错误'}` });
      }
    }

    if (!videoUrl) {
      await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [cost, req.user.id]);
      await addQuotaLog(req.user.id, cost, 'AI视频生成超时退还');
      return res.status(500).json({ message: '视频生成超时，积分已退还' });
    }

    res.json({ url: videoUrl });
  } catch (error) {
    console.error('[AI视频生成失败]', error.message);
    // 如果是积分已扣除的情况，尝试退还
    try {
      await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [cost, req.user.id]);
      await addQuotaLog(req.user.id, cost, 'AI视频生成异常退还');
    } catch (refundError) {
      console.error('[积分退还失败]', refundError.message);
    }
    res.status(500).json({ message: error.response?.data?.message || 'AI视频生成失败，请稍后重试' });
  }
});

// GET /api/benchmark/my-submissions — 查看我的投稿
router.get('/my-submissions', auth, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  const [rows] = await db.query(
    `SELECT id, social_link, reason, category, platform, analysis, script, status, admin_note, created_at
     FROM benchmark_submissions
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [req.user.id, parseInt(limit), parseInt(offset)]
  );

  const [[{ total }]] = await db.query(
    'SELECT COUNT(*) as total FROM benchmark_submissions WHERE user_id = ?',
    [req.user.id]
  );

  res.json({
    list: rows,
    total,
    page: parseInt(page),
    limit: parseInt(limit)
  });
});

// GET /api/benchmark/categories — 获取分类列表
router.get('/categories', async (req, res) => {
  const categories = await getCategories();
  res.json(categories);
});

// GET /api/benchmark/today-count — 获取今日投稿数量
router.get('/today-count', auth, async (req, res) => {
  const today = todayCST();
  const [[{ count }]] = await db.query(
    'SELECT COUNT(*) as count FROM benchmark_submissions WHERE user_id = ? AND DATE(created_at) = ?',
    [req.user.id, today]
  );

  res.json({
    count,
    remaining: 100 - count
  });
});

// GET /api/benchmark/video-quota — 获取今日视频生成次数
router.get('/video-quota', auth, async (req, res) => {
  const today = todayCST();
  const [[{ count }]] = await db.query(
    `SELECT COUNT(*) as count FROM quota_logs
     WHERE user_id = ? AND reason = 'AI视频生成' AND DATE(created_at) = ?`,
    [req.user.id, today]
  );

  const dailyLimit = 10;
  res.json({
    used: count,
    remaining: Math.max(0, dailyLimit - count),
    limit: dailyLimit
  });
});

// ===== 管理员接口 =====

const { requireAdmin } = require('../middleware/auth');

// GET /api/benchmark/admin/list — 管理员查看所有投稿
router.get('/admin/list', auth, requireAdmin, async (req, res) => {
  const { page = 1, limit = 50, status, category } = req.query;
  const offset = (page - 1) * limit;

  let whereClause = '1=1';
  const params = [];

  if (status && ['pending', 'approved', 'rejected'].includes(status)) {
    whereClause += ' AND bs.status = ?';
    params.push(status);
  }

  if (category) {
    whereClause += ' AND bs.category = ?';
    params.push(category);
  }

  const [rows] = await db.query(
    `SELECT bs.id, bs.social_link, bs.reason, bs.category, bs.platform, bs.analysis, bs.script, bs.status, bs.admin_note, bs.created_at,
            u.username, u.id as user_id
     FROM benchmark_submissions bs
     LEFT JOIN users u ON bs.user_id = u.id
     WHERE ${whereClause}
     ORDER BY bs.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, parseInt(limit), parseInt(offset)]
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) as total FROM benchmark_submissions bs WHERE ${whereClause}`,
    params
  );

  res.json({
    list: rows,
    total,
    page: parseInt(page),
    limit: parseInt(limit)
  });
});

// POST /api/benchmark/admin/review/:id — 管理员审核投稿
router.post('/admin/review/:id', auth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status, admin_note } = req.body;

  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ message: '无效的审核状态' });
  }

  const [[submission]] = await db.query(
    'SELECT id FROM benchmark_submissions WHERE id = ?',
    [id]
  );

  if (!submission) {
    return res.status(404).json({ message: '投稿不存在' });
  }

  await db.query(
    'UPDATE benchmark_submissions SET status = ?, admin_note = ? WHERE id = ?',
    [status, admin_note || null, id]
  );

  res.json({ message: '审核成功' });
});

module.exports = router;
