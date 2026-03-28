const router = require('express').Router();
const { exec } = require('child_process');
const db = require('../../config/db');

const SCRIPT_PATH = '/home/ubuntu/study_yunjunet_cn/scripts/scrape_money_cases.py';
const MAX_SCRAPE_LIMIT = 50;
const SCRAPE_TIMEOUT = 90000;

// GET / — 分页查询赚钱案例
router.get('/', async (req, res) => {
  try {
    const { platform, keyword, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    let where = "WHERE status = 'active'";
    const params = [];

    if (platform && platform !== 'all') {
      where += ' AND platform = ?';
      params.push(platform);
    }
    if (keyword) {
      where += ' AND (title LIKE ? OR content LIKE ? OR income_keyword LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM openclaw_money_cases ${where}`, params
    );
    const [rows] = await db.query(
      `SELECT * FROM openclaw_money_cases ${where} ORDER BY collected_at DESC LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );
    const [[lastRow]] = await db.query(
      'SELECT MAX(collected_at) AS last_scraped FROM openclaw_money_cases'
    );

    res.json({ total, page: pageNum, limit: limitNum, last_scraped: lastRow?.last_scraped || null, cases: rows });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST /scrape — 手动触发全网采集
router.post('/scrape', (req, res) => {
  const limit = Math.min(MAX_SCRAPE_LIMIT, parseInt(req.body.limit) || 20);
  const command = `python3 ${SCRIPT_PATH} all ${limit}`;

  exec(command, { timeout: SCRAPE_TIMEOUT }, async (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({ message: stderr || error.message });
    }

    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      return res.status(500).json({ message: '解析脚本输出失败', raw: stdout.slice(0, 500) });
    }

    const cases = data.cases || [];
    if (cases.length === 0) {
      return res.json({ inserted: 0, stats: data.stats, message: '未采集到新案例' });
    }

    let inserted = 0;
    try {
      for (const c of cases) {
        if (!c.title) continue;
        const [[existing]] = await db.query(
          'SELECT id FROM openclaw_money_cases WHERE title = ? AND platform = ? LIMIT 1',
          [c.title.slice(0, 499), c.platform || 'other']
        );
        if (existing) continue;

        await db.query(
          `INSERT INTO openclaw_money_cases (title, content, source_url, platform, author, income_keyword)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            (c.title || '').slice(0, 499),
            (c.content || '').slice(0, 2000),
            (c.source_url || '').slice(0, 999),
            c.platform || 'other',
            (c.author || '').slice(0, 99),
            (c.income_keyword || '').slice(0, 199),
          ]
        );
        inserted++;
      }
    } catch (e) {
      return res.status(500).json({ message: '入库失败: ' + e.message, inserted });
    }

    res.json({ inserted, total_scraped: cases.length, stats: data.stats });
  });
});

// Cron: 每4小时自动采集
try {
  const cron = require('node-cron');
  cron.schedule('0 */4 * * *', () => {
    console.log('[study-cases] Cron: 开始采集全网赚钱案例...');
    exec(`python3 ${SCRIPT_PATH} all 20`, { timeout: SCRAPE_TIMEOUT }, (err, stdout) => {
      if (err) {
        console.error('[study-cases] Cron 采集失败:', err.message);
        return;
      }
      try {
        const data = JSON.parse(stdout);
        console.log(`[study-cases] Cron 采集完成，获取 ${data.stats?.total || 0} 条案例`);
      } catch {
        console.log('[study-cases] Cron 输出:', stdout.slice(0, 200));
      }
    });
  });
  console.log('[study-cases] Cron 已注册：每4小时自动采集');
} catch {
  console.warn('[study-cases] node-cron 未安装，跳过定时任务');
}

module.exports = router;
