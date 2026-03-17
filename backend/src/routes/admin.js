const router = require('express').Router();
const db = require('../config/db');
const { adminOnly } = require('../middleware/auth');

router.use(adminOnly);

// 数据看板
router.get('/overview', async (req, res) => {
  try {
    const [[users]] = await db.query('SELECT COUNT(*) as total FROM users');
    const [[apiKeys]] = await db.query('SELECT COUNT(*) as total FROM openclaw_api_keys WHERE status = "active"');
    const [[todayCalls]] = await db.query(
      'SELECT COUNT(*) as calls, COALESCE(SUM(total_cost),0) as revenue FROM openclaw_call_logs WHERE DATE(created_at) = CURDATE()'
    );
    const [[totalCalls]] = await db.query(
      'SELECT COUNT(*) as calls, COALESCE(SUM(total_cost),0) as revenue FROM openclaw_call_logs'
    );
    const [recentLogs] = await db.query(
      `SELECT l.*, u.username FROM openclaw_call_logs l LEFT JOIN users u ON l.user_id = u.id ORDER BY l.created_at DESC LIMIT 20`
    );

    res.json({
      users: users.total,
      active_keys: apiKeys.total,
      today: { calls: todayCalls.calls, revenue: todayCalls.revenue },
      total: { calls: totalCalls.calls, revenue: totalCalls.revenue },
      recent_logs: recentLogs
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取概览失败' });
  }
});

// 用户列表
router.get('/users', async (req, res) => {
  const { page = 1, limit = 20, keyword } = req.query;
  const offset = (page - 1) * limit;
  try {
    let where = '1=1';
    const params = [];
    if (keyword) {
      where = 'u.username LIKE ?';
      params.push(`%${keyword}%`);
    }
    const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM users u WHERE ${where}`, params);
    const [users] = await db.query(
      `SELECT u.id, u.username, u.role, u.created_at, q.balance, q.extra_quota
       FROM users u LEFT JOIN user_quota q ON u.id = q.user_id
       WHERE ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    );
    res.json({ users, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取用户列表失败' });
  }
});

// 给用户充值余额
router.post('/charge', async (req, res) => {
  const { user_id, amount, description } = req.body;
  if (!user_id || !amount) return res.status(400).json({ error: '缺少参数' });

  try {
    await db.query('UPDATE user_quota SET balance = balance + ? WHERE user_id = ?', [amount, user_id]);
    await db.query(
      'INSERT INTO balance_logs (user_id, amount, type, description, created_at) VALUES (?, ?, "admin_charge", ?, NOW())',
      [user_id, amount, description || '管理员充值']
    );
    res.json({ message: `已充值 ¥${amount}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '充值失败' });
  }
});

// 模型管理 - 列表
router.get('/models', async (req, res) => {
  try {
    const [models] = await db.query('SELECT * FROM openclaw_models ORDER BY sort_order');
    res.json(models);
  } catch (err) {
    res.status(500).json({ error: '获取模型失败' });
  }
});

// 模型管理 - 更新价格/状态
router.put('/models/:id', async (req, res) => {
  const { input_price_per_1k, output_price_per_1k, status, upstream_endpoint, upstream_key } = req.body;
  try {
    await db.query(
      'UPDATE openclaw_models SET input_price_per_1k=?, output_price_per_1k=?, status=?, upstream_endpoint=?, upstream_key=? WHERE id=?',
      [input_price_per_1k, output_price_per_1k, status, upstream_endpoint || null, upstream_key || null, req.params.id]
    );
    res.json({ message: '已更新' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '更新失败' });
  }
});

// 模型管理 - 新增
router.post('/models', async (req, res) => {
  const { model_id, display_name, provider, input_price_per_1k, output_price_per_1k, upstream_endpoint, upstream_key } = req.body;
  try {
    await db.query(
      'INSERT INTO openclaw_models (model_id, display_name, provider, input_price_per_1k, output_price_per_1k, upstream_endpoint, upstream_key) VALUES (?,?,?,?,?,?,?)',
      [model_id, display_name, provider, input_price_per_1k, output_price_per_1k, upstream_endpoint || null, upstream_key || null]
    );
    res.json({ message: '已添加' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '添加失败' });
  }
});

module.exports = router;
