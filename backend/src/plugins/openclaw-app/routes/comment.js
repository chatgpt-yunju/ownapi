const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const router = express.Router();

const SCRIPT_DIR = path.join(__dirname, '../../openclaw-skill/scripts');

/**
 * POST /api/comments/auto-reply
 * 自动回复评论
 */
router.post('/auto-reply', (req, res) => {
  const { accountId = 'default', dryRun = false } = req.body;

  let command = `python3 ${SCRIPT_DIR}/auto_reply.py "${accountId}"`;
  if (dryRun) command += ' --dry-run';

  exec(command, { timeout: 120000 }, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({ error: stderr || error.message });
    }

    try {
      const result = JSON.parse(stdout);
      res.json({ success: true, replies: result });
    } catch (e) {
      res.json({ success: true, message: stdout });
    }
  });
});

module.exports = router;
