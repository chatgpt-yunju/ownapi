const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const router = express.Router();

const SCRIPT_DIR = path.join(__dirname, '../../openclaw-skill/scripts');

/**
 * POST /api/publish
 * 发布文章到微信公众号
 */
router.post('/', async (req, res) => {
  const { title, content, coverImage, accountId = 'default' } = req.body;

  if (!title || !content) {
    return res.status(400).json({ error: '缺少标题或内容' });
  }

  // 转义引号
  const escapedTitle = title.replace(/"/g, '\\"');
  const escapedContent = content.replace(/"/g, '\\"');

  let command = `python3 ${SCRIPT_DIR}/wechat_publish.py "${escapedTitle}" "${escapedContent}"`;

  if (coverImage) {
    command += ` "${coverImage}"`;
  }

  command += ` "${accountId}"`;

  console.log('执行命令:', command);

  exec(command, { maxBuffer: 1024 * 1024 * 10, timeout: 120000 }, (error, stdout, stderr) => {
    if (error) {
      console.error('发布失败:', stderr);
      return res.status(500).json({ error: stderr || error.message, stdout });
    }

    try {
      const result = JSON.parse(stdout.split('\n').pop());
      res.json(result);
    } catch (e) {
      res.json({ success: true, message: stdout });
    }
  });
});

/**
 * POST /api/publish/schedule
 * 定时发布文章
 */
router.post('/schedule', async (req, res) => {
  const { title, content, scheduledTime, accountId = 'default' } = req.body;

  if (!title || !content || !scheduledTime) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  // TODO: 保存到数据库，由 Cron 任务处理
  res.json({
    success: true,
    message: '定时任务已创建',
    scheduledTime,
    note: '数据库功能待实现'
  });
});

module.exports = router;
