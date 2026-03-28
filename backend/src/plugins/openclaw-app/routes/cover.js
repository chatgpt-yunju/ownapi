const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const router = express.Router();

const SCRIPT_DIR = path.join(__dirname, '../../openclaw-skill/scripts');

/**
 * POST /api/cover/generate
 * 生成封面图
 */
router.post('/generate', (req, res) => {
  const { title, style = 'professional' } = req.body;

  if (!title) {
    return res.status(400).json({ error: '缺少文章标题' });
  }

  const outputPath = path.join(__dirname, '../../openclaw-skill/screenshots', `cover_${Date.now()}`);
  const command = `python3 ${SCRIPT_DIR}/generate_cover.py "${title}" "${style}" "${outputPath}"`;

  exec(command, { timeout: 60000 }, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({ error: stderr || error.message });
    }

    try {
      const result = JSON.parse(stdout);
      res.json(result);
    } catch (e) {
      res.json({ success: true, message: stdout });
    }
  });
});

module.exports = router;
