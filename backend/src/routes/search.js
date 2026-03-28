const router = require('express').Router();
const { getSettingCached } = require('./quota');
const db = require('../config/db');
const { optionalAuth } = require('../middleware/auth');
const arkRateLimiter = require('../utils/arkRateLimiter');
const PLANET_API = 'https://planet.opensora2.cn/api/planet';
const GATEWAY_URL = process.env.AI_GATEWAY_URL || 'http://localhost:3021';
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || '';

// 建表 & 迁移
db.query(`CREATE TABLE IF NOT EXISTS ai_search_usage (
  user_id VARCHAR(100) NOT NULL,
  usage_date DATE NOT NULL,
  count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_date)
) DEFAULT CHARSET=utf8mb4`).catch(() => {});
db.query('ALTER TABLE user_quota ADD COLUMN vip_tier INT NOT NULL DEFAULT 0').catch(() => {});

function todayCST() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

// 根据VIP套餐天数返回每日AI搜索限额
async function getAiSearchLimit(vipTier) {
  if (vipTier >= 365) return 100; // 年会员
  if (vipTier >= 90)  return 50;  // 季会员（含180天）
  if (vipTier >= 30)  return 20;  // 月会员
  if (vipTier >= 7)   return 10;  // 周会员
  const val = await getSettingCached('daily_free_quota', '3');
  return Math.max(1, parseInt(val) || 3);
}

// 检查每日AI搜索配额（不消耗，仅检查）
async function checkAiSearchQuota(req) {
  const today = todayCST();
  let userKey;
  let vipTier = 0;

  if (req.user) {
    userKey = `u_${req.user.id}`;
    const [[quota]] = await db.query(
      'SELECT vip_expires_at, vip_tier FROM user_quota WHERE user_id = ?',
      [req.user.id]
    ).catch(() => [[null]]);
    const vipActive = quota?.vip_expires_at && new Date(quota.vip_expires_at) > new Date();
    vipTier = vipActive ? (parseInt(quota?.vip_tier) || 0) : 0;
  } else {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
    userKey = `ip_${ip}`;
  }

  const limit = await getAiSearchLimit(vipTier);
  const [[usage]] = await db.query(
    'SELECT count FROM ai_search_usage WHERE user_id = ? AND usage_date = ?',
    [userKey, today]
  ).catch(() => [[null]]);

  const used = usage?.count || 0;
  if (used >= limit) {
    return { allowed: false, used, limit, isVip: vipTier > 0 };
  }

  return { allowed: true, used, limit, isVip: vipTier > 0, userKey, today };
}

// 成功后才消耗配额
async function consumeAiSearchQuota(userKey, today) {
  await db.query(
    'INSERT INTO ai_search_usage (user_id, usage_date, count) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE count = count + 1',
    [userKey, today]
  ).catch(() => {});
}

async function getArkBaseUrl() { return await getSettingCached('ark_base_url', 'https://ark.cn-beijing.volces.com/api/v3'); }
async function getTextModel() { return (await getSettingCached('ark_glm_endpoint', '')) || (await getSettingCached('doubao_text_model', 'glm-4-7-251222')); }

/**
 * 将用户查询拆分为多个搜索词（分组并行用）
 * 例："短视频运营技巧" → ["短视频运营技巧", "短视频", "运营技巧"]
 */
function splitKeywords(q) {
  const kws = new Set([q]);
  // 按空格/标点拆分
  q.split(/[\s,，。？！、；：]+/).forEach(w => w.length > 1 && kws.add(w));
  // 无空格且较长：前半/后半
  if (!q.includes(' ') && q.length > 4) {
    kws.add(q.slice(0, Math.ceil(q.length / 2)));
    kws.add(q.slice(Math.floor(q.length / 2)));
  }
  return [...kws].slice(0, 4); // 最多4组，控制并发数
}

/**
 * 并行搜索 planet 帖子，合并去重，按出现频率排序
 */
async function searchPlanetParallel(q) {
  const kws = splitKeywords(q);
  const hitCount = new Map(); // post.id → 命中次数

  // 分组并行请求
  const results = await Promise.allSettled(
    kws.map(kw =>
      fetch(`${PLANET_API}/posts?keyword=${encodeURIComponent(kw)}&limit=30`)
        .then(r => r.ok ? r.json() : [])
        .catch(() => [])
    )
  );

  const postMap = new Map(); // id → post 对象
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const posts = Array.isArray(r.value) ? r.value : (r.value.posts || r.value.data || []);
    for (const p of posts) {
      postMap.set(p.id, p);
      hitCount.set(p.id, (hitCount.get(p.id) || 0) + 1);
    }
  }

  // 按命中次数降序排列，返回全部结果
  return [...postMap.values()]
    .sort((a, b) => (hitCount.get(b.id) || 0) - (hitCount.get(a.id) || 0));
}

/**
 * 从数据库检索相关新闻（关键词匹配，无结果则取最新20条）
 */
async function fetchNewsFromDB(q) {
  const kws = splitKeywords(q);
  const likeConditions = kws.map(() => 'title LIKE ?').join(' OR ');
  const likeParams = kws.map(k => `%${k}%`);
  try {
    const [rows] = await db.query(
      `SELECT title, url, source, DATE_FORMAT(pub_date, '%Y-%m-%d') AS pub_date
       FROM ai_news
       WHERE (${likeConditions}) AND saved_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       ORDER BY saved_at DESC LIMIT 20`,
      likeParams
    );
    if (Array.isArray(rows) && rows.length) return rows;
    const [fallback] = await db.query(
      `SELECT title, url, source, DATE_FORMAT(pub_date, '%Y-%m-%d') AS pub_date
       FROM ai_news ORDER BY saved_at DESC LIMIT 20`
    );
    return Array.isArray(fallback) ? fallback : [];
  } catch {
    return [];
  }
}

/**
 * SSE 流转发辅助：逐块解析并发送 chunk 事件
 */
async function streamAiResponse(aiResp, send) {
  const reader = aiResp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const chunk = line.slice(6).trim();
      if (chunk === '[DONE]') continue;
      try {
        const text = JSON.parse(chunk).choices?.[0]?.delta?.content || '';
        if (text) send('chunk', { text });
      } catch {}
    }
  }
}

// GET /api/search/ai?q=xxx — 并行检索新闻+星球帖子，流式AI搜索 (SSE)
router.get('/ai', optionalAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ message: '请输入搜索内容' });
  if (!DOUBAO_API_KEY) return res.status(500).json({ message: 'AI 服务未配置' });

  const quotaCheck = await checkAiSearchQuota(req);
  if (!quotaCheck.allowed) {
    const quotaMsg = await getSettingCached('ai_search_quota_message', '今日免费体验次数已用完，开通VIP无限次搜索');
    const msg = quotaCheck.isVip
      ? `今日AI使用次数已达上限（${quotaCheck.limit}次/天），明日重置`
      : quotaMsg;
    return res.status(429).json({ message: msg, code: 'QUOTA_EXCEEDED', limit: quotaCheck.limit });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const searchUserId = String(req.user?.id || 1);
  const { pickModel } = require('yunjunet-common/backend-core/ai/model-router');

  try {
    // 并行：星球帖子 + 新闻 + AI配置
    const [posts, newsRows, systemPrompt, { model: aiModel }] = await Promise.all([
      searchPlanetParallel(q),
      fetchNewsFromDB(q),
      getSettingCached('search_ai_prompt',
        '你是一个AI短视频内容助手，专注于帮助用户查找和了解短视频素材、运营技巧和内容创作知识。请根据用户问题提供简洁、实用的回答。'),
      pickModel('medium'),
    ]);

    // 构建双上下文：星球帖子 + 新闻
    let context = '';
    if (posts.length) {
      context += '\n\n以下是星球社区相关帖子（引用格式：「见星球帖子[序号]」）：\n' +
        posts.map((p, i) => `[${i + 1}] ${p.title || ''} ${(p.content || '').slice(0, 100)}`).join('\n');
    }
    if (newsRows.length) {
      context += '\n\n以下是近期相关新闻（引用格式：「见新闻[序号]」）：\n' +
        newsRows.map((n, i) => `[${i + 1}] (${n.source || ''} ${n.pub_date || ''}) ${n.title}`).join('\n');
    }

    const aiResp = await fetch(`${GATEWAY_URL}/v1/internal/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET, 'X-User-Id': searchUserId },
      body: JSON.stringify({
        model: aiModel,
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt + context },
          { role: 'user', content: q },
        ],
      }),
    });

    if (!aiResp.ok) {
      const errBody = await aiResp.text().catch(() => '');
      console.error('[search] AI API error:', aiResp.status, errBody);
      send('error', { message: 'AI 服务调用失败' });
      return res.end();
    }

    await streamAiResponse(aiResp, send);
    await consumeAiSearchQuota(quotaCheck.userKey, quotaCheck.today);

    if (posts.length) send('posts', { posts });
    if (newsRows.length) send('news', { news: newsRows });
    send('done', {});
  } catch (e) {
    console.error('[search/ai]', e.message);
    try { send('error', { message: '搜索失败，请稍后重试' }); } catch {}
  } finally {
    res.end();
  }
});

// GET /api/search/planet?q=xxx — 仅星球帖子上下文，流式AI分析 (SSE)
router.get('/planet', optionalAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ message: '请输入搜索内容' });
  if (!INTERNAL_SECRET) return res.status(500).json({ message: 'AI 服务未配置' });

  const quotaCheck = await checkAiSearchQuota(req);
  if (!quotaCheck.allowed) {
    const quotaMsg = await getSettingCached('ai_search_quota_message', '今日免费体验次数已用完，开通VIP无限次搜索');
    const msg = quotaCheck.isVip
      ? `今日AI使用次数已达上限（${quotaCheck.limit}次/天），明日重置`
      : quotaMsg;
    return res.status(429).json({ message: msg, code: 'QUOTA_EXCEEDED', limit: quotaCheck.limit });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const planetUserId = String(req.user?.id || 1);
  const { pickModel: planetPickModel } = require('yunjunet-common/backend-core/ai/model-router');

  try {
    const [posts, { model: planetAiModel }] = await Promise.all([
      searchPlanetParallel(q),
      planetPickModel('medium'),
    ]);

    let context = posts.length
      ? '\n\n以下是星球社区相关帖子，请结合内容作答（引用格式：「见星球帖子[序号]」）：\n' +
        posts.map((p, i) => `[${i + 1}] ${p.title || ''} ${(p.content || '').slice(0, 150)}`).join('\n')
      : '';

    const systemPrompt = '你是AI星球社区的内容分析师，专注于从社区帖子中提炼有价值的内容和洞察。请根据用户问题，结合社区帖子给出简洁实用的回答，适时引用帖子。';

    const aiResp = await fetch(`${GATEWAY_URL}/v1/internal/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET, 'X-User-Id': planetUserId },
      body: JSON.stringify({
        model: planetAiModel,
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt + context },
          { role: 'user', content: q },
        ],
      }),
    });

    if (!aiResp.ok) {
      const errBody = await aiResp.text().catch(() => '');
      console.error('[search] AI API error:', aiResp.status, errBody);
      send('error', { message: 'AI 服务调用失败' });
      return res.end();
    }

    await streamAiResponse(aiResp, send);
    await consumeAiSearchQuota(quotaCheck.userKey, quotaCheck.today);

    if (posts.length) send('posts', { posts });
    send('done', {});
  } catch (e) {
    console.error('[search/planet]', e.message);
    try { send('error', { message: '搜索失败，请稍后重试' }); } catch {}
  } finally {
    res.end();
  }
});

// GET /api/search/yuqing?q=xxx — 舆情预测 (SSE)：基于AI新闻DB预测话题走向
router.get('/yuqing', optionalAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ message: '请输入搜索内容' });
  if (!INTERNAL_SECRET) return res.status(500).json({ message: 'AI 服务未配置' });

  const quotaCheck = await checkAiSearchQuota(req);
  if (!quotaCheck.allowed) {
    const quotaMsg = await getSettingCached('ai_search_quota_message', '今日免费体验次数已用完，开通VIP无限次搜索');
    const msg = quotaCheck.isVip
      ? `今日AI使用次数已达上限（${quotaCheck.limit}次/天），明日重置`
      : quotaMsg;
    return res.status(429).json({ message: msg, code: 'QUOTA_EXCEEDED', limit: quotaCheck.limit });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    // 从DB取最近7天相关新闻（最多30条）
    const kws = splitKeywords(q);
    const likeConditions = kws.map(() => 'title LIKE ?').join(' OR ');
    const likeParams = kws.map(k => `%${k}%`);
    const [rows] = await db.query(
      `SELECT title, url, source, DATE_FORMAT(pub_date, '%Y-%m-%d') AS pub_date
       FROM ai_news
       WHERE (${likeConditions}) AND saved_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       ORDER BY saved_at DESC LIMIT 30`,
      likeParams
    ).catch(async () => {
      // 如果关键词过滤无结果，取最新30条
      return db.query(
        `SELECT title, url, source, DATE_FORMAT(pub_date, '%Y-%m-%d') AS pub_date
         FROM ai_news ORDER BY saved_at DESC LIMIT 30`
      );
    });

    const newsRows = Array.isArray(rows) ? rows : [];

    // 若关键词过滤结果为空，补充最新30条
    let finalRows = newsRows;
    if (!finalRows.length) {
      const [fallback] = await db.query(
        `SELECT title, url, source, DATE_FORMAT(pub_date, '%Y-%m-%d') AS pub_date
         FROM ai_news ORDER BY saved_at DESC LIMIT 30`
      ).catch(() => [[]]);
      finalRows = Array.isArray(fallback) ? fallback : [];
    }

    const { pickModel: yuqingPickModel } = require('yunjunet-common/backend-core/ai/model-router');
    const { model: yuqingAiModel } = await yuqingPickModel('medium');
    const yuqingUserId = String(req.user?.id || 1);

    const newsContext = finalRows.length
      ? '以下是近期AI行业热点新闻：\n' + finalRows.map((n, i) =>
          `[${i + 1}] (${n.source || ''} ${n.pub_date || ''}) ${n.title}`
        ).join('\n')
      : '（暂无相关新闻数据）';

    const systemPrompt = `你是专业的AI行业舆情分析师。基于以下近期热点新闻，预测用户话题的可能走向与趋势。
分析要点：1）结合新闻热点判断话题的行业关注度；2）预测该话题近期最可能的发展方向（如技术突破、政策监管、商业落地等）；3）指出值得关注的风险或机会。适时引用新闻（格式：见新闻[序号]）。回答简洁实用，300字以内，中文。

${newsContext}`;

    const aiResp = await fetch(`${GATEWAY_URL}/v1/internal/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET, 'X-User-Id': yuqingUserId },
      body: JSON.stringify({
        model: yuqingAiModel,
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `请预测话题「${q}」的舆情走向` },
        ],
      }),
    });

    if (!aiResp.ok) {
      const errBody = await aiResp.text().catch(() => '');
      console.error('[search] AI API error:', aiResp.status, errBody);
      send('error', { message: 'AI 服务调用失败' });
      return res.end();
    }

    const reader = aiResp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const chunk = line.slice(6).trim();
        if (chunk === '[DONE]') continue;
        try {
          const text = JSON.parse(chunk).choices?.[0]?.delta?.content || '';
          if (text) send('chunk', { text });
        } catch {}
      }
    }

    await consumeAiSearchQuota(quotaCheck.userKey, quotaCheck.today);

    // 推送相关新闻列表
    if (finalRows.length) send('news', { news: finalRows });
    send('done', {});
  } catch (e) {
    console.error('[search/yuqing]', e.message);
    try { send('error', { message: '预测失败，请稍后重试' }); } catch {}
  } finally {
    res.end();
  }
});

module.exports = router;
