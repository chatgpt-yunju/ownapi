const router = require('express').Router();
const axios = require('axios');
const db = require('../config/db');
const { getSettingCached } = require('./quota');
const arkRateLimiter = require('../utils/arkRateLimiter');
const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY;

// 建表（首次启动自动创建）
db.query(`CREATE TABLE IF NOT EXISTS ai_news (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  url VARCHAR(500) NOT NULL UNIQUE,
  source VARCHAR(50),
  pub_date DATE,
  saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_source (source),
  INDEX idx_saved_at (saved_at)
) DEFAULT CHARSET=utf8mb4`).catch(() => {});

async function getArkBaseUrl() { return await getSettingCached('ark_base_url', 'https://ark.cn-beijing.volces.com/api/v3'); }
async function getTextModel() { return (await getSettingCached('ark_glm_endpoint', '')) || (await getSettingCached('doubao_text_model', 'glm-4-7-251222')); }

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);
}

// 内存缓存 30 分钟
let cache = { data: null, at: 0 };
const TTL = 30 * 60 * 1000;

function parseRss(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  for (const b of blocks) {
    const title = (b.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                   b.match(/<title>([\s\S]*?)<\/title>/))?.[1]?.trim();
    const rawLink = (b.match(/<link>([\s\S]*?)<\/link>/) ||
                     b.match(/<guid[^>]*>([\s\S]*?)<\/guid>/))?.[1]?.trim();
    const link = rawLink ? rawLink.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim() : rawLink;
    const date  = b.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim();
    if (title && link) items.push({ title, link, date });
  }
  return items;
}

const AI_KEYWORDS = /claw|openclaw|人工智能|大模型|LLM|ChatGPT|GPT|Gemini|Claude|机器学习|深度学习|神经网络|算法|智能|自动驾驶|AIGC|MCP|Agent|芯片|机器人|无人机/i;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = () => Math.floor(Math.random() * 1500) + 500; // 500-2000ms

async function fetchFeed(url) {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const referer = new URL(url).origin + '/';
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': ua,
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': referer,
        'Cache-Control': 'no-cache',
      },
      responseType: 'text',
    });
    return parseRss(data);
  } catch {
    return [];
  }
}

async function getNews() {
  if (cache.data && Date.now() - cache.at < TTL) return cache.data;

  const feeds = [
    'https://www.jiqizhixin.com/rss',         // 机器之心
    'https://36kr.com/feed',                  // 36氪
    'https://www.huxiu.com/rss/1.xml',        // 虎嗅
    'https://www.oschina.net/news/rss',       // 开源中国
    'https://www.ifanr.com/feed',             // 爱范儿
    'https://www.ithome.com/rss/',            // IT之家
    'https://sspai.com/feed',                 // 少数派
  ];

  const FEED_SOURCES = {
    'https://www.jiqizhixin.com/rss':  '机器之心',
    'https://36kr.com/feed':           '36氪',
    'https://www.huxiu.com/rss/1.xml': '虎嗅',
    'https://www.oschina.net/news/rss':'开源中国',
    'https://www.ifanr.com/feed':      '爱范儿',
    'https://www.ithome.com/rss/':     'IT之家',
    'https://sspai.com/feed':          '少数派',
  };

  // 顺序抓取 + 随机延迟，模拟人类浏览行为
  const all = [];
  for (let i = 0; i < feeds.length; i++) {
    if (i > 0) await sleep(randomDelay());
    const items = await fetchFeed(feeds[i]);
    const source = FEED_SOURCES[feeds[i]] || '';
    items.forEach(item => { item.source = source; });

    if (items.length > 0) {
      // 保存到数据库（忽略重复）
      const values = items.map(item => [
        item.title,
        item.link,
        source,
        item.date ? new Date(item.date).toISOString().slice(0, 10) : null,
      ]);
      db.query(
        'INSERT IGNORE INTO ai_news (title, url, source, pub_date) VALUES ?',
        [values]
      ).catch(() => {});
      all.push(...items);
    } else {
      // 抓取失败时从数据库读取历史记录
      try {
        const [rows] = await db.query(
          'SELECT title, url, source, DATE_FORMAT(pub_date, "%Y-%m-%d") AS date FROM ai_news WHERE source = ? ORDER BY saved_at DESC LIMIT 20',
          [source]
        );
        rows.forEach(row => { all.push({ title: row.title, link: row.url, source: row.source, date: row.date, fromDb: true }); });
      } catch {}
    }
  }

  const filtered = all.filter(item => AI_KEYWORDS.test(item.title));

  // 去重（按标题前20字）
  const seen = new Set();
  const unique = filtered.filter(item => {
    const key = item.title.slice(0, 20);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const news = unique.slice(0, 20).map(item => ({
    title: item.title
      .replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, '')  // 零宽字符
      .replace(/^[:：][a-z_]+[:：]\s*/i, '')              // :fire: 等 emoji 前缀
      .replace(/^\s*[:：][^\s]{1,20}[:：]\s*/, '')        // 中文冒号包裹的前缀
      .trim(),
    url: item.link,
    date: item.date ? new Date(item.date).toISOString().slice(0, 10) : '',
    source: item.source || '',
  })).filter(item => item.title.length > 0);

  cache = { data: news, at: Date.now() };
  return news;
}

// GET /api/news/ai
router.get('/ai', async (req, res) => {
  try {
    const news = await getNews();
    res.json(news);
  } catch (e) {
    res.status(500).json({ message: '获取新闻失败' });
  }
});

// GET /api/news/analyze?url=... — 流式分析新闻文章 (SSE)
router.get('/analyze', async (req, res) => {
  const url = (req.query.url || '').trim();
  if (!url) return res.status(400).json({ message: '缺少url参数' });
  if (!process.env.INTERNAL_API_SECRET) return res.status(500).json({ message: 'AI 服务未配置' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    let articleText = '';
    try {
      const { data } = await axios.get(url, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
        responseType: 'text',
      });
      articleText = stripHtml(data);
    } catch {
      articleText = '（无法获取文章正文，请根据链接标题进行分析）';
    }

    const GW_URL = process.env.AI_GATEWAY_URL || 'http://localhost:3021';
    const GW_SECRET = process.env.INTERNAL_API_SECRET || '';
    const { pickModel } = require('yunjunet-common/backend-core/ai/model-router');
    const picked = await pickModel('simple');

    const aiResp = await fetch(`${GW_URL}/v1/internal/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': GW_SECRET, 'X-User-Id': '1' },
      body: JSON.stringify({
        model: picked.model,
        stream: true,
        messages: [
          { role: 'system', content: '你是专业的AI新闻分析师。请对文章进行简洁分析：核心观点、关键信息、对AI行业的影响或意义。控制在300字以内，用中文回复。' },
          { role: 'user', content: `文章内容：\n${articleText}` },
        ],
      }),
    });

    if (!aiResp.ok) { send('error', { message: 'AI 分析失败' }); return res.end(); }

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
  } catch {
    send('error', { message: '分析失败，请稍后重试' });
  } finally {
    res.end();
  }
});

module.exports = router;
