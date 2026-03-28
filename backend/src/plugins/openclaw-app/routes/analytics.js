const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const router = express.Router();

const SCRIPT_DIR = path.join(__dirname, '../../openclaw-skill/scripts');

/**
 * GET /api/analytics/articles
 * 获取文章数据统计
 */
router.get('/articles', (req, res) => {
  const accountId = req.query.accountId || 'default';
  const command = `python3 ${SCRIPT_DIR}/scrape_stats.py "${accountId}"`;

  exec(command, { timeout: 60000 }, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({ error: stderr || error.message });
    }

    try {
      const result = JSON.parse(stdout);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: '解析失败', raw: stdout });
    }
  });
});

/**
 * GET /api/analytics/summary
 * 获取数据总览
 */
router.get('/summary', (req, res) => {
  // TODO: 从数据库统计
  res.json({
    totalArticles: 0,
    totalViews: 0,
    totalLikes: 0,
    totalComments: 0,
    message: '数据库功能待实现'
  });
});

module.exports = router;
