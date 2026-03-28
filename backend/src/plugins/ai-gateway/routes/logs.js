const router = require('express').Router();
const db = require('../../../config/db');

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
      `SELECT id, model, prompt_tokens, completion_tokens, total_cost,
              billing_mode, charged_balance_type, charged_amount,
              status, error_message, ip, created_at, request_id
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
      `SELECT COUNT(*) as calls,
              COALESCE(SUM(total_cost),0) as cost,
              COALESCE(SUM(prompt_tokens+completion_tokens),0) as tokens,
              COALESCE(SUM(CASE WHEN charged_balance_type = 'quota' THEN charged_amount ELSE 0 END),0) as quota_cost,
              COALESCE(SUM(CASE WHEN charged_balance_type = 'wallet' THEN charged_amount ELSE 0 END),0) as wallet_cost
       FROM openclaw_call_logs
       WHERE user_id = ? AND DATE(created_at) = CURDATE()`,
      [req.user.id]
    );
    const [[total]] = await db.query(
      `SELECT COUNT(*) as calls,
              COALESCE(SUM(total_cost),0) as cost,
              COALESCE(SUM(prompt_tokens+completion_tokens),0) as tokens,
              COALESCE(SUM(CASE WHEN charged_balance_type = 'quota' THEN charged_amount ELSE 0 END),0) as quota_cost,
              COALESCE(SUM(CASE WHEN charged_balance_type = 'wallet' THEN charged_amount ELSE 0 END),0) as wallet_cost
       FROM openclaw_call_logs
       WHERE user_id = ?`,
      [req.user.id]
    );
    // 最近7天每日统计
    const [daily] = await db.query(
      `SELECT DATE(created_at) as date, COUNT(*) as calls, COALESCE(SUM(total_cost),0) as cost
       FROM openclaw_call_logs WHERE user_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       GROUP BY DATE(created_at) ORDER BY date`,
      [req.user.id]
    );

    res.json({
      today: {
        ...today,
        calls: Number(today.calls || 0),
        cost: Number(today.cost || 0),
        tokens: Number(today.tokens || 0),
        quota_cost: Number(today.quota_cost || 0),
        wallet_cost: Number(today.wallet_cost || 0),
      },
      total: {
        ...total,
        calls: Number(total.calls || 0),
        cost: Number(total.cost || 0),
        tokens: Number(total.tokens || 0),
        quota_cost: Number(total.quota_cost || 0),
        wallet_cost: Number(total.wallet_cost || 0),
      },
      daily,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取统计失败' });
  }
});

// 详细统计
router.get('/statistics', async (req, res) => {
  try {
    // 总体统计
    const [[total]] = await db.query(
      `SELECT
        COUNT(*) as total_calls,
        COALESCE(SUM(prompt_tokens + completion_tokens), 0) as total_tokens,
        COALESCE(SUM(total_cost), 0) as total_cost,
        COALESCE(AVG(total_cost), 0) as avg_cost,
        COALESCE(SUM(CASE WHEN charged_balance_type = 'quota' THEN charged_amount ELSE 0 END), 0) as quota_spend,
        COALESCE(SUM(CASE WHEN charged_balance_type = 'wallet' THEN charged_amount ELSE 0 END), 0) as wallet_spend
       FROM openclaw_call_logs
       WHERE user_id = ?`,
      [req.user.id]
    );

    // 模型使用分布
    const [models] = await db.query(
      `SELECT
        model,
        COUNT(*) as calls,
        COALESCE(SUM(total_cost), 0) as cost
       FROM openclaw_call_logs
       WHERE user_id = ?
       GROUP BY model
       ORDER BY calls DESC
       LIMIT 10`,
      [req.user.id]
    );

    // 近30天趋势
    const [trend] = await db.query(
      `SELECT
        DATE(created_at) as date,
        COUNT(*) as calls,
        COALESCE(SUM(prompt_tokens + completion_tokens), 0) as tokens,
        COALESCE(SUM(total_cost), 0) as cost,
        COALESCE(SUM(CASE WHEN charged_balance_type = 'quota' THEN charged_amount ELSE 0 END), 0) as quota_cost,
        COALESCE(SUM(CASE WHEN charged_balance_type = 'wallet' THEN charged_amount ELSE 0 END), 0) as wallet_cost
       FROM openclaw_call_logs
       WHERE user_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       GROUP BY DATE(created_at)
       ORDER BY date`,
      [req.user.id]
    );

    const [billingModes] = await db.query(
      `SELECT billing_mode, COUNT(*) as calls, COALESCE(SUM(charged_amount), 0) as amount
       FROM openclaw_call_logs
       WHERE user_id = ?
       GROUP BY billing_mode`,
      [req.user.id]
    );

    res.json({
      total_calls: Number(total.total_calls),
      total_tokens: Number(total.total_tokens),
      total_cost: Number(total.total_cost),
      avg_cost: Number(total.avg_cost),
      quota_spend: Number(total.quota_spend),
      wallet_spend: Number(total.wallet_spend),
      models: models.map(m => ({ ...m, calls: Number(m.calls), cost: Number(m.cost) })),
      trend: trend.map(t => ({
        ...t,
        calls: Number(t.calls),
        tokens: Number(t.tokens),
        cost: Number(t.cost),
        quota_cost: Number(t.quota_cost),
        wallet_cost: Number(t.wallet_cost),
      })),
      billing_modes: billingModes.map(item => ({
        billing_mode: item.billing_mode || 'token',
        calls: Number(item.calls || 0),
        amount: Number(item.amount || 0),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取详细统计失败' });
  }
});

module.exports = router;
