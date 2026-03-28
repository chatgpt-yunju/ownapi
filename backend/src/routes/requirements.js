const router = require('express').Router();
const db = require('../config/db');
const { auth } = require('../middleware/auth');
const { ensureQuota, addQuotaLog, getSetting, getSettingCached } = require('./quota');
const arkRateLimiter = require('../utils/arkRateLimiter');

const { callAI } = require('../utils/aiGateway');

// 初始化表
async function initTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS requirements (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      user_id      INT NOT NULL,
      title        VARCHAR(255) NOT NULL,
      description  TEXT NOT NULL,
      budget       VARCHAR(64),
      deadline     VARCHAR(64),
      contact      VARCHAR(255) NOT NULL,
      status       ENUM('open','closed') DEFAULT 'open',
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS bids (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      requirement_id INT NOT NULL,
      user_id        INT NOT NULL,
      content        TEXT NOT NULL,
      price          VARCHAR(64),
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_bid (requirement_id, user_id),
      FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS contact_unlocks (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      user_id        INT NOT NULL,
      requirement_id INT NOT NULL,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_unlock (user_id, requirement_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE
    )
  `);
}
initTables().catch(e => console.error('[requirements] 建表失败:', e.message));

// GET /api/requirements — 需求列表（隐藏联系方式）
router.get('/', auth, async (req, res) => {
  const [rows] = await db.query(
    `SELECT r.id, r.title, r.description, r.budget, r.deadline, r.status, r.created_at,
            u.username,
            (SELECT COUNT(*) FROM bids WHERE requirement_id = r.id) as bid_count
     FROM requirements r JOIN users u ON r.user_id = u.id
     ORDER BY r.created_at DESC`
  );
  res.json(rows);
});

// GET /api/requirements/:id — 需求详情（联系方式需解锁）
router.get('/:id', auth, async (req, res) => {
  const [[row]] = await db.query(
    `SELECT r.*, u.username FROM requirements r JOIN users u ON r.user_id = u.id WHERE r.id = ?`,
    [req.params.id]
  );
  if (!row) return res.status(404).json({ message: '需求不存在' });

  // 判断是否已解锁或是发布者本人
  const [[unlock]] = await db.query(
    'SELECT id FROM contact_unlocks WHERE user_id = ? AND requirement_id = ?',
    [req.user.id, req.params.id]
  );
  const isOwner = row.user_id === req.user.id;
  const unlocked = isOwner || !!unlock;

  const result = { ...row, contact: unlocked ? row.contact : null, unlocked };
  res.json(result);
});

// POST /api/requirements — 发布需求（积分可配置，默认1）
router.post('/', auth, async (req, res) => {
  const { title, description, budget, deadline, contact } = req.body;
  if (!title?.trim() || !description?.trim() || !contact?.trim()) {
    return res.status(400).json({ message: '标题、描述、联系方式不能为空' });
  }
  const cost = parseInt(await getSettingCached('cost_requirement_post', '1')) || 1; // hardcoded default: 1
  const quota = await ensureQuota(req.user.id);
  if (quota.extra_quota < cost) return res.status(403).json({ message: `积分不足，发布需求需要${cost}积分`, code: 'QUOTA_EXCEEDED' });
  await db.query('UPDATE user_quota SET extra_quota = extra_quota - ? WHERE user_id = ?', [cost, req.user.id]);
  await addQuotaLog(req.user.id, -cost, `发布需求「${title.trim()}」`);
  const [result] = await db.query(
    'INSERT INTO requirements (user_id, title, description, budget, deadline, contact) VALUES (?,?,?,?,?,?)',
    [req.user.id, title.trim(), description.trim(), budget || '', deadline || '', contact.trim()]
  );
  res.status(201).json({ id: result.insertId });
});

// POST /api/requirements/ai-generate — AI生成需求内容（免费，不扣积分）
router.post('/ai-generate', auth, async (req, res) => {
  const { keywords, type = '短视频制作', budget, deadline } = req.body;
  if (!keywords?.trim()) return res.status(400).json({ message: '请输入需求关键词' });
  const prompt = `你是一位专业的短视频外包需求撰写专家，请根据以下信息生成一份完整、专业的外包需求描述。

需求类型：${type}
关键词/简述：${keywords.trim()}
${budget ? `预算：${budget}` : ''}
${deadline ? `截止时间：${deadline}` : ''}

请输出：
【需求标题】（简洁明了，20字以内）：
【需求描述】（详细描述需求内容、要求、交付物，200字左右）：
【技能要求】（列出3-5项所需技能）：
【注意事项】（2-3条重要说明）：

直接输出内容，不要额外说明。`;
  try {
    const result = await callAI(prompt);
    res.json({ result });
  } catch (e) {
    if (e.code === 'ARK_RATE_LIMITED') return res.status(429).json({ message: e.message, code: 'ARK_RATE_LIMITED', retryAfter: e.retryAfter });
    res.status(500).json({ message: 'AI 生成失败，请稍后重试' });
  }
});

// GET /api/requirements/:id/bids — 查看投标列表（仅发布者）
router.get('/:id/bids', auth, async (req, res) => {
  const [[req_row]] = await db.query('SELECT user_id FROM requirements WHERE id = ?', [req.params.id]);
  if (!req_row) return res.status(404).json({ message: '需求不存在' });
  if (req_row.user_id !== req.user.id) return res.status(403).json({ message: '无权查看' });
  const [rows] = await db.query(
    `SELECT b.*, u.username FROM bids b JOIN users u ON b.user_id = u.id WHERE b.requirement_id = ? ORDER BY b.created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
});

// POST /api/requirements/:id/bid — 投标（免费，每天限10次）
router.post('/:id/bid', auth, async (req, res) => {
  const { content, price } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: '投标内容不能为空' });

  const [[req_row]] = await db.query('SELECT * FROM requirements WHERE id = ?', [req.params.id]);
  if (!req_row) return res.status(404).json({ message: '需求不存在' });
  if (req_row.status === 'closed') return res.status(400).json({ message: '该需求已关闭' });
  if (req_row.user_id === req.user.id) return res.status(400).json({ message: '不能对自己的需求投标' });

  // 每天限N次（可配置，默认10）
  const dailyBidLimit = parseInt(await getSettingCached('daily_bid_limit', '10')) || 10; // hardcoded default: 10
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const [[{ count }]] = await db.query(
    'SELECT COUNT(*) as count FROM bids WHERE user_id = ? AND DATE(created_at) = ?',
    [req.user.id, today]
  );
  if (count >= dailyBidLimit) return res.status(403).json({ message: `今日投标次数已达上限（${dailyBidLimit}次）`, code: 'BID_LIMIT' });

  try {
    await db.query(
      'INSERT INTO bids (requirement_id, user_id, content, price) VALUES (?,?,?,?)',
      [req.params.id, req.user.id, content.trim(), price || '']
    );
    res.status(201).json({ message: '投标成功' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: '您已对该需求投标' });
    throw e;
  }
});

// POST /api/requirements/:id/bid/ai-polish — AI润色投标内容（免费）
router.post('/:id/bid/ai-polish', auth, async (req, res) => {
  const { content, price } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: '请输入投标内容' });
  const [[req_row]] = await db.query('SELECT title, description FROM requirements WHERE id = ?', [req.params.id]);
  if (!req_row) return res.status(404).json({ message: '需求不存在' });

  const prompt = `你是一位专业的自由职业者，请帮我润色以下投标内容，使其更专业、更有说服力，更容易获得客户青睐。

需求标题：${req_row.title}
需求描述：${req_row.description}

我的投标内容：${content.trim()}
${price ? `报价：${price}` : ''}

要求：
1. 保留原意，但语言更专业流畅
2. 突出自身优势和对需求的理解
3. 增加可信度（如经验、案例等方向的表达）
4. 结尾加上诚意表达
5. 控制在200字以内
6. 直接输出润色后的内容，不要说明`;
  try {
    const result = await callAI(prompt);
    res.json({ result });
  } catch (e) {
    res.status(500).json({ message: 'AI 润色失败，请稍后重试' });
  }
});

// POST /api/requirements/:id/unlock — 解锁联系方式（消耗积分）
router.post('/:id/unlock', auth, async (req, res) => {
  const [[req_row]] = await db.query('SELECT * FROM requirements WHERE id = ?', [req.params.id]);
  if (!req_row) return res.status(404).json({ message: '需求不存在' });
  if (req_row.user_id === req.user.id) return res.json({ contact: req_row.contact });

  const [[existing]] = await db.query(
    'SELECT id FROM contact_unlocks WHERE user_id = ? AND requirement_id = ?',
    [req.user.id, req.params.id]
  );
  if (existing) return res.json({ contact: req_row.contact });

  const cost = parseInt(await getSettingCached('cost_requirement_unlock', '2')) || 2; // was: getSetting('unlock_contact_cost') || 2
  const quota = await ensureQuota(req.user.id);
  if (quota.extra_quota < cost) return res.status(403).json({ message: `积分不足，解锁联系方式需要${cost}积分`, code: 'QUOTA_EXCEEDED' });

  await db.query('UPDATE user_quota SET extra_quota = extra_quota - ? WHERE user_id = ?', [cost, req.user.id]);
  await addQuotaLog(req.user.id, -cost, `解锁需求「${req_row.title}」联系方式`);
  await db.query('INSERT INTO contact_unlocks (user_id, requirement_id) VALUES (?,?)', [req.user.id, req.params.id]);
  res.json({ contact: req_row.contact });
});

// PUT /api/requirements/:id — 编辑需求（管理员或发布者）
router.put('/:id', auth, async (req, res) => {
  const [[row]] = await db.query('SELECT * FROM requirements WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ message: '需求不存在' });

  const isAdmin = req.user.role === 'admin';
  const isOwner = row.user_id === req.user.id;
  if (!isAdmin && !isOwner) return res.status(403).json({ message: '无权操作' });

  const { title, description, budget, deadline, contact, status } = req.body;
  await db.query(
    'UPDATE requirements SET title=?, description=?, budget=?, deadline=?, contact=?, status=? WHERE id=?',
    [title || row.title, description || row.description, budget ?? row.budget, deadline ?? row.deadline, contact || row.contact, status || row.status, req.params.id]
  );
  res.json({ message: '更新成功' });
});

// DELETE /api/requirements/:id/admin — 管理员删除需求
router.delete('/:id/admin', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: '无权操作' });
  await db.query('DELETE FROM requirements WHERE id = ?', [req.params.id]);
  res.json({ message: '删除成功' });
});

// DELETE /api/requirements/:id — 关闭需求（仅发布者）
router.delete('/:id', auth, async (req, res) => {
  const [[row]] = await db.query('SELECT user_id FROM requirements WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ message: '需求不存在' });
  if (row.user_id !== req.user.id) return res.status(403).json({ message: '无权操作' });
  await db.query('UPDATE requirements SET status = ? WHERE id = ?', ['closed', req.params.id]);
  res.json({ message: '需求已关闭' });
});

module.exports = router;
