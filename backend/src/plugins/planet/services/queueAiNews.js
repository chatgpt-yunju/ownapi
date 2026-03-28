// 自动将 AI新闻 加入定时发布队列（供 cron 调用）
const db = require('../../../config/db');
const bcrypt = require('bcryptjs');
const { ensureQuota } = require('../routes/quota');
const { rewriteContent, generateTitle } = require('./aiRewrite');

const AI_ZONGDONGYUAN_ID = 3; // 玩赚OpenClaw

async function getForbiddenWords() {
  try {
    const [[row]] = await db.query("SELECT value FROM settings WHERE `key` = 'forbidden_words'");
    if (!row) return [];
    return row.value.split(',').map(w => w.trim()).filter(Boolean);
  } catch { return []; }
}
function filterForbiddenWords(text, words) {
  if (!text || !words?.length) return text;
  let result = text;
  for (const word of words) result = result.split(word).join('');
  return result;
}
const { callAI } = require('../utils/aiGateway');

async function fetchArticleText(url) {
  const https = require('https');
  const http = require('http');
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: 8000
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchArticleText(res.headers.location));
        }
        if (res.statusCode !== 200) return resolve(null);
        res.setEncoding('utf8');
        let data = '';
        res.on('data', chunk => { data += chunk; if (data.length > 200000) req.destroy(); });
        res.on('end', () => {
          const text = data
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ').trim().slice(0, 3000);
          resolve(text || null);
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch (e) { resolve(null); }
  });
}

async function generateNickname() {
  try {
    const prompt = '生成一个有创意的中文昵称，2-4个字，要求：1.富有诗意或趣味性 2.不要使用常见名字 3.只返回昵称本身，不要其他内容';
    return await callAI(prompt, { userId: 1, max_tokens: 20 });
  } catch {
    return `用户${Date.now().toString().slice(-6)}`;
  }
}

// 检查定时队列数量，≤3 时自动入队一条最早的待处理AI新闻
async function autoQueueIfNeeded() {
  const [[{ cnt }]] = await db.query(
    "SELECT COUNT(*) as cnt FROM planet_posts WHERE publish_status = 'scheduled' AND review_status = 'approved'"
  );
  if (parseInt(cnt) > 3) return;

  // 找最早的未入队 claw/虾 相关AI新闻
  const [[news]] = await db.query(
    `SELECT id, title, url, source FROM ai_news
     WHERE queue_status = 'pending'
       AND (title LIKE '%claw%' OR title LIKE '%Claw%' OR title LIKE '%虾%')
     ORDER BY pub_date ASC LIMIT 1`
  );
  if (!news) return;

  console.log(`[auto-queue] 定时队列剩余${cnt}条，自动入队新闻: ${news.title}`);

  const articleText = await fetchArticleText(news.url);
  const content = articleText || `【${news.source}】${news.title}`;

  // 创建随机用户
  let postUserId;
  const tempNickname = `用户${Date.now().toString().slice(-6)}`;
  const randomUsername = 'user_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  const hashedPassword = await bcrypt.hash(Math.random().toString(36).substring(2, 15), 10);
  const [userResult] = await db.query(
    'INSERT INTO users (username, password, nickname, role) VALUES (?, ?, ?, ?)',
    [randomUsername, hashedPassword, tempNickname, 'user']
  );
  postUserId = userResult.insertId;
  await ensureQuota(postUserId);

  // 加入 AI总动员 圈子
  const [joinResult] = await db.query(
    'INSERT IGNORE INTO planet_members (circle_id, user_id) VALUES (?, ?)',
    [AI_ZONGDONGYUAN_ID, postUserId]
  );
  if (joinResult.affectedRows > 0) {
    await db.query('UPDATE planet_circles SET member_count = member_count + 1 WHERE id = ?', [AI_ZONGDONGYUAN_ID]);
  }

  // 插入定时帖子
  const [postResult] = await db.query(
    `INSERT INTO planet_posts
      (circle_id, user_id, post_type, title, content, link_url, link_title, publish_status, rewrite_status, review_status)
     VALUES (?, ?, 'link', '无标题', ?, ?, ?, 'scheduled', 'pending', 'approved')`,
    [AI_ZONGDONGYUAN_ID, postUserId, content, news.url, news.title]
  );
  const postId = postResult.insertId;
  await db.query('UPDATE planet_circles SET post_count = post_count + 1 WHERE id = ?', [AI_ZONGDONGYUAN_ID]);

  // 标记新闻已入队
  await db.query(
    'UPDATE ai_news SET queue_status = ?, queue_post_id = ? WHERE id = ?',
    ['queued', postId, news.id]
  );
  console.log(`[auto-queue] 帖子${postId}已创建，开始AI改写`);

  // 异步 AI改写+标题+昵称
  const [[circle]] = await db.query(
    'SELECT ai_rewrite_enabled, ai_rewrite_model FROM planet_circles WHERE id = ?',
    [AI_ZONGDONGYUAN_ID]
  );
  (async () => {
    try {
      let finalContent = content;
      let finalTitle = '无标题';
      let rewriteSuccess = false;
      if (circle?.ai_rewrite_enabled && circle.ai_rewrite_model) {
        try {
          const { content: rewritten, model } = await rewriteContent(content, circle.ai_rewrite_model);
          finalContent = rewritten.replace(
            /(?<!href=["'])(https?:\/\/[^\s<>"'）】\)]+)/g,
            '<a href="$1" target="_blank">$1</a>'
          );
          rewriteSuccess = true;
          console.log(`[auto-queue] 帖子${postId}已用${model}改写`);
        } catch (e) { console.error(`[auto-queue] 帖子${postId}改写失败:`, e.message); }
      }
      try {
        finalTitle = await generateTitle(finalContent);
        console.log(`[auto-queue] 帖子${postId}标题已生成: ${finalTitle}`);
      } catch (e) { console.error(`[auto-queue] 帖子${postId}生成标题失败:`, e.message); }
      try {
        const aiNickname = await generateNickname();
        await db.query('UPDATE users SET nickname = ? WHERE id = ?', [aiNickname, postUserId]);
      } catch (e) { console.error(`[auto-queue] 昵称生成失败:`, e.message); }
      const finalStatus = circle?.ai_rewrite_enabled ? (rewriteSuccess ? 'completed' : 'failed') : 'completed';
      const forbiddenWords = await getForbiddenWords();
      await db.query(
        'UPDATE planet_posts SET content = ?, title = ?, rewrite_status = ? WHERE id = ?',
        [filterForbiddenWords(finalContent, forbiddenWords), filterForbiddenWords(finalTitle, forbiddenWords), finalStatus, postId]
      );
      console.log(`[auto-queue] 帖子${postId}处理完成，状态: ${finalStatus}`);
    } catch (e) {
      console.error(`[auto-queue] 帖子${postId}异步处理失败:`, e.message);
      await db.query("UPDATE planet_posts SET rewrite_status = 'failed' WHERE id = ?", [postId]);
    }
  })();
}

module.exports = { autoQueueIfNeeded };
