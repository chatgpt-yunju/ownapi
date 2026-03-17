const router = require('express').Router();
const db = require('../config/db');

// 获取调用日志
router.get('/', async (req, res) => {
  const { page = 1, limit = 20, model, status, start_date, end_date } = req.query;
  const offset = (page - 1) * limit;
  const conditions = ['user_id = ?'];
  const params = [req.user.id];

  if (model) { conditions.push('model = ?'); params.push(model); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (start_date) { conditions.push('created_at >= ?'); params.push(start_date); }
  if (end_date) { conditions.push('created_at <= ?'); params.push(end_date + ' 23:59:59'); }

  const where = conditions.join(' AND ');

  try {
    const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM openclaw_call_logs WHERE ${where}`, params);
    const [logs] = await db.query(
      `SELECT id, model, prompt_tokens, completion_tokens, total_cost, status, error_message, ip, created_at, request_id
       FROM openclaw_call_logs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    );

    res.json({ logs, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取日志失败' });
  }
});

// 用量统计
router.get('/stats', async (req, res) => {
  try {
    const [[today]] = await db.query(
      'SELECT COUNT(*) as calls, COALESCE(SUM(total_cost),0) as cost, COALESCE(SUM(prompt_tokens+completion_tokens),0) as tokens FROM openclaw_call_logs WHERE user_id = ? AND DATE(created_at) = CURDATE()',
      [req.user.id]
    );
    const [[total]] = await db.query(
      'SELECT COUNT(*) as calls, COALESCE(SUM(total_cost),0) as cost, COALESCE(SUM(prompt_tokens+completion_tokens),0) as tokens FROM openclaw_call_logs WHERE user_id = ?',
      [req.user.id]
    );
    // 最近7天每日统计
    const [daily] = await db.query(
      `SELECT DATE(created_at) as date, COUNT(*) as calls, COALESCE(SUM(total_cost),0) as cost
       FROM openclaw_call_logs WHERE user_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       GROUP BY DATE(created_at) ORDER BY date`,
      [req.user.id]
    );

    res.json({ today, total, daily });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取统计失败' });
  }
});

module.exports = router;
