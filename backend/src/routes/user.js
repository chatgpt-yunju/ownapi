const router = require('express').Router();
const db = require('../config/db');

// 获取用户信息
router.get('/info', async (req, res) => {
  try {
    const [[quota]] = await db.query(
      'SELECT extra_quota, balance, vip_expires_at FROM user_quota WHERE user_id = ?',
      [req.user.id]
    );
    const [[keyCnt]] = await db.query(
      'SELECT COUNT(*) as cnt FROM openclaw_api_keys WHERE user_id = ? AND status = "active"',
      [req.user.id]
    );
    const [[todayUsage]] = await db.query(
      'SELECT COUNT(*) as calls, COALESCE(SUM(total_cost),0) as cost FROM openclaw_call_logs WHERE user_id = ? AND DATE(created_at) = CURDATE()',
      [req.user.id]
    );

    res.json({
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      balance: quota?.balance ?? 0,
      vip: req.user.vip,
      vip_expires_at: quota?.vip_expires_at,
      active_keys: keyCnt.cnt,
      today_calls: todayUsage.calls,
      today_cost: todayUsage.cost
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取信息失败' });
  }
});

// 获取余额
router.get('/balance', async (req, res) => {
  try {
    const [[quota]] = await db.query('SELECT balance FROM user_quota WHERE user_id = ?', [req.user.id]);
    res.json({ balance: quota?.balance ?? 0 });
  } catch (err) {
    res.status(500).json({ error: '获取余额失败' });
  }
});

module.exports = router;
