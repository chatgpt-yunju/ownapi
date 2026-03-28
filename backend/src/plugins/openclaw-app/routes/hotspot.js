const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const router = express.Router();

const SCRIPT_DIR = path.join(__dirname, '../../openclaw-skill/scripts');

/**
 * GET /api/hotspots/weibo
 * 获取微博热搜
 */
router.get('/weibo', (req, res) => {
  const limit = req.query.limit || 10;
  const command = `python3 ${SCRIPT_DIR}/scrape_hotspot.py weibo ${limit}`;

  exec(command, (error, stdout, stderr) => {
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
 * GET /api/hotspots/baidu
 * 获取百度热榜
 */
router.get('/baidu', (req, res) => {
  const limit = req.query.limit || 10;
  const command = `python3 ${SCRIPT_DIR}/scrape_hotspot.py baidu ${limit}`;

  exec(command, (error, stdout, stderr) => {
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
 * GET /api/hotspots/all
 * 获取所有平台热点
 */
router.get('/all', (req, res) => {
  const limit = req.query.limit || 10;
  const command = `python3 ${SCRIPT_DIR}/scrape_hotspot.py all ${limit}`;

  exec(command, (error, stdout, stderr) => {
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

module.exports = router;
