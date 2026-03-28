const router = require('express').Router();
const { getSettingCached } = require('./quota');
const { GATEWAY_URL, INTERNAL_SECRET } = require('../utils/aiGateway');
const PLANET_API = 'http://localhost:3010/api/planet';

function splitKeywords(q) {
  const kws = new Set([q]);
  q.split(/[\s,，。？！、；：]+/).forEach(w => w.length > 1 && kws.add(w));
  if (!q.includes(' ') && q.length > 4) {
    kws.add(q.slice(0, Math.ceil(q.length / 2)));
    kws.add(q.slice(Math.floor(q.length / 2)));
  }
  return [...kws].slice(0, 4);
}

async function searchPlanetParallel(q) {
  const kws = splitKeywords(q);
  const hitCount = new Map();

  const results = await Promise.allSettled(
    kws.map(kw =>
      fetch(`${PLANET_API}/posts?keyword=${encodeURIComponent(kw)}&limit=30`)
        .then(r => r.ok ? r.json() : [])
        .catch(() => [])
    )
  );

  const postMap = new Map();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const posts = Array.isArray(r.value) ? r.value : (r.value.posts || r.value.data || []);
    for (const p of posts) {
      postMap.set(p.id, p);
      hitCount.set(p.id, (hitCount.get(p.id) || 0) + 1);
    }
  }

  return [...postMap.values()]
    .sort((a, b) => (hitCount.get(b.id) || 0) - (hitCount.get(a.id) || 0));
}

// GET /api/search/ai?q=xxx — SSE streaming AI search
router.get('/ai', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ message: '请输入搜索内容' });
  if (!INTERNAL_SECRET) return res.status(500).json({ message: 'AI 服务未配置' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const [posts, systemPrompt] = await Promise.all([
      searchPlanetParallel(q),
      getSettingCached('search_ai_prompt',
        '你是AI星球社区的智能助手，专注于帮助用户发现和了解社区中的优质内容、圈子和讨论。请根据用户问题提供简洁、实用的回答。'),
    ]);

    let context = '';
    if (posts.length) {
      context = '\n\n以下是星球社区中与该话题相关的帖子摘要，请结合内容作答，适时推荐（引用格式：「见星球帖子[序号]」）：\n' +
        posts.map((p, i) =>
          `[${i + 1}] ${p.title || ''} ${(p.content || '').slice(0, 100)}`
        ).join('\n');
    }

    if (posts.length) send('posts', { posts });

    const aiResp = await fetch(`${GATEWAY_URL}/v1/internal/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET,
        'X-User-Id': '1',
      },
      body: JSON.stringify({
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt + context },
          { role: 'user', content: q },
        ],
      }),
    });

    if (!aiResp.ok) {
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

    send('done', {});
  } catch (e) {
    console.error('[search/ai]', e.message);
    try { send('error', { message: '搜索失败，请稍后重试' }); } catch {}
  } finally {
    res.end();
  }
});

module.exports = router;
