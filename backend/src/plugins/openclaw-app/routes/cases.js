const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const mysql = require('mysql2/promise');
const router = express.Router();

const SCRIPT_DIR = path.join(__dirname, '../../openclaw-skill/scripts');

function getDB() {
  return mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'wechat_cms'
  });
}

/**
 * GET /api/cases
 * 分页查询赚钱案例，支持 platform / keyword 过滤
 */
router.get('/', async (req, res) => {
  const { platform, keyword, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

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

  const db = await getDB();
  try {
    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM openclaw_money_cases ${where}`,
      params
    );
    const [rows] = await db.execute(
      `SELECT * FROM openclaw_money_cases ${where} ORDER BY collected_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    // 查最新采集时间
    const [[lastRow]] = await db.execute(
      "SELECT MAX(collected_at) AS last_scraped FROM openclaw_money_cases"
    );

    res.json({
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      last_scraped: lastRow?.last_scraped || null,
      cases: rows
    });
  } finally {
    await db.end();
  }
});

/**
 * POST /api/cases/scrape
 * 手动触发一次全网采集并入库
 */
router.post('/scrape', (req, res) => {
  const limit = req.body.limit || 20;
  const command = `python3 ${SCRIPT_DIR}/scrape_money_cases.py all ${limit}`;

  exec(command, { timeout: 60000 }, async (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({ error: stderr || error.message });
    }

    let data;
    try {
      data = JSON.parse(stdout);
    } catch (e) {
      return res.status(500).json({ error: '解析脚本输出失败', raw: stdout.slice(0, 500) });
    }

    const cases = data.cases || [];
    if (cases.length === 0) {
      return res.json({ inserted: 0, stats: data.stats, message: '未采集到新案例' });
    }

    const db = await getDB();
    let inserted = 0;
    try {
      for (const c of cases) {
        if (!c.title) continue;
        // 按 title+platform 去重
        const [[existing]] = await db.execute(
          'SELECT id FROM openclaw_money_cases WHERE title = ? AND platform = ? LIMIT 1',
          [c.title.slice(0, 499), c.platform || 'other']
        );
        if (existing) continue;

        await db.execute(
          `INSERT INTO openclaw_money_cases (title, content, source_url, platform, author, income_keyword)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            (c.title || '').slice(0, 499),
            (c.content || '').slice(0, 2000),
            (c.source_url || '').slice(0, 999),
            c.platform || 'other',
            (c.author || '').slice(0, 99),
            (c.income_keyword || '').slice(0, 199)
          ]
        );
        inserted++;
      }
    } finally {
      await db.end();
    }

    res.json({ inserted, total_scraped: cases.length, stats: data.stats });
  });
});

module.exports = router;
