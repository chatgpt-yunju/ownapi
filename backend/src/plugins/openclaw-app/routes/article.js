const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const router = express.Router();

const SCRIPT_DIR = path.join(__dirname, '../../openclaw-skill/scripts');

/**
 * POST /api/articles/generate
 * 生成文章内容
 */
router.post('/generate', async (req, res) => {
  const { topic, style = '专业', wordCount = 1000 } = req.body;

  if (!topic) {
    return res.status(400).json({ error: '缺少主题参数' });
  }

  const command = `python3 ${SCRIPT_DIR}/generate_content.py "${topic}" "${style}" ${wordCount}`;

  exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
    if (error) {
      console.error('生成失败:', stderr);
      return res.status(500).json({ error: stderr || error.message });
    }

    try {
      const result = JSON.parse(stdout);
      res.json(result);
    } catch (e) {
      res.json({ title: topic, content: stdout });
    }
  });
});

/**
 * POST /api/articles/generate-from-hotspot
 * 根据热点生成文章
 */
router.post('/generate-from-hotspot', async (req, res) => {
  const { hotspot, style = '专业' } = req.body;

  if (!hotspot) {
    return res.status(400).json({ error: '缺少热点参数' });
  }

  const command = `python3 ${SCRIPT_DIR}/generate_content.py --hotspot "${hotspot}" "${style}"`;

  exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({ error: stderr || error.message });
    }

    try {
      const result = JSON.parse(stdout);
      res.json(result);
    } catch (e) {
      res.json({ title: hotspot, content: stdout });
    }
  });
});

/**
 * GET /api/articles/list
 * 获取文章列表（从数据库）
 */
router.get('/list', async (req, res) => {
  // TODO: 从数据库查询
  res.json({
    articles: [],
    total: 0,
    message: '数据库功能待实现'
  });
});

module.exports = router;
