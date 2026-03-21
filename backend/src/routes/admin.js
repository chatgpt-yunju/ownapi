const router = require('express').Router();
const db = require('../config/db');
const { adminOnly } = require('../middleware/auth');

router.use(adminOnly);

// 数据看板
router.get('/overview', async (req, res) => {
  try {
    const [[users]] = await db.query('SELECT COUNT(*) as total FROM users');
    const [[apiKeys]] = await db.query('SELECT COUNT(*) as total FROM openclaw_api_keys WHERE status = "active"');
    const [[todayStats]] = await db.query(
      'SELECT COUNT(*) as calls, COALESCE(SUM(total_cost),0) as cost, COALESCE(SUM(prompt_tokens+completion_tokens),0) as tokens FROM openclaw_call_logs WHERE DATE(created_at) = CURDATE()'
    );
    const [[totalStats]] = await db.query(
      'SELECT COUNT(*) as calls, COALESCE(SUM(total_cost),0) as cost, COALESCE(SUM(prompt_tokens+completion_tokens),0) as tokens FROM openclaw_call_logs'
    );
    const [recentLogs] = await db.query(
      `SELECT l.id, l.model, l.prompt_tokens, l.completion_tokens, l.total_cost, l.status, l.created_at, u.username
       FROM openclaw_call_logs l LEFT JOIN users u ON l.user_id = u.id
       ORDER BY l.created_at DESC LIMIT 20`
    );

    res.json({
      total_users: users.total,
      total_calls: Number(totalStats.calls),
      total_tokens: Number(totalStats.tokens),
      total_cost: Number(totalStats.cost),
      today_calls: Number(todayStats.calls),
      today_cost: Number(todayStats.cost),
      today_tokens: Number(todayStats.tokens),
      active_keys: apiKeys.total,
      recent_logs: recentLogs
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取概览失败' });
  }
});

// 用户列表
router.get('/users', async (req, res) => {
  const { page = 1, limit = 20, keyword, search } = req.query;
  const q = keyword || search || '';
  const offset = (page - 1) * limit;
  try {
    let where = '1=1';
    const params = [];
    if (q) {
      where = 'u.username LIKE ?';
      params.push(`%${q}%`);
    }
    const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM users u WHERE ${where}`, params);
    const [users] = await db.query(
      `SELECT u.id as user_id, u.username, u.role, u.created_at, COALESCE(q.balance, 0) as balance,
       (SELECT COUNT(*) FROM openclaw_api_keys k WHERE k.user_id = u.id AND k.status = 'active') as key_count,
       (SELECT COUNT(*) FROM openclaw_call_logs l WHERE l.user_id = u.id) as total_calls,
       (SELECT COALESCE(SUM(l.total_cost),0) FROM openclaw_call_logs l WHERE l.user_id = u.id) as total_cost
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
  const { user_id, amount, description, remark } = req.body;
  const note = description || remark || '管理员操作';
  if (!user_id || !amount) return res.status(400).json({ error: '缺少参数' });

  try {
    // 获取当前余额
    const [[quota]] = await db.query('SELECT balance FROM user_quota WHERE user_id = ?', [user_id]);
    const balanceBefore = quota ? Number(quota.balance) : 0;
    const balanceAfter = balanceBefore + Number(amount);

    // 更新余额（upsert）
    await db.query(
      'INSERT INTO user_quota (user_id, balance) VALUES (?, ?) ON DUPLICATE KEY UPDATE balance = balance + ?',
      [user_id, Number(amount), Number(amount)]
    );

    // 记录余额日志（正数为充值，负数为扣费）
    const logType = Number(amount) >= 0 ? 'recharge' : 'withdraw';
    await db.query(
      'INSERT INTO balance_logs (user_id, amount, balance_before, balance_after, type, description, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
      [user_id, amount, balanceBefore, balanceAfter, logType, note]
    );

    res.json({ message: `操作成功，余额变动 ¥${amount}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '操作失败: ' + err.message });
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

// 模型管理 - 新增
router.post('/models', async (req, res) => {
  const { model_id, display_name, provider, input_price_per_1k, output_price_per_1k, price_currency, sort_order, upstream_model_id, upstream_endpoint, upstream_key } = req.body;
  try {
    await db.query(
      'INSERT INTO openclaw_models (model_id, display_name, provider, input_price_per_1k, output_price_per_1k, price_currency, sort_order, upstream_model_id, upstream_endpoint, upstream_key) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [model_id, display_name, provider, input_price_per_1k, output_price_per_1k, price_currency || 'CNY', sort_order || 0, upstream_model_id || null, upstream_endpoint || null, upstream_key || null]
    );
    res.json({ message: '已添加' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '添加失败' });
  }
});

// 模型管理 - 更新
router.put('/models/:id', async (req, res) => {
  const { display_name, provider, input_price_per_1k, output_price_per_1k, price_currency, sort_order, status, upstream_model_id, upstream_endpoint, upstream_key } = req.body;
  try {
    await db.query(
      'UPDATE openclaw_models SET display_name=?, provider=?, input_price_per_1k=?, output_price_per_1k=?, price_currency=?, sort_order=?, status=?, upstream_model_id=?, upstream_endpoint=?, upstream_key=? WHERE id=?',
      [display_name, provider, input_price_per_1k, output_price_per_1k, price_currency || 'CNY', sort_order || 0, status, upstream_model_id || null, upstream_endpoint || null, upstream_key || null, req.params.id]
    );
    res.json({ message: '已更新' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '更新失败' });
  }
});

// 模型管理 - 删除（软删除，设为 disabled）
router.delete('/models/:id', async (req, res) => {
  try {
    await db.query('UPDATE openclaw_models SET status="disabled" WHERE id=?', [req.params.id]);
    res.json({ message: '已禁用' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '操作失败' });
  }
});

// 供应商管理 - 列表
router.get('/providers', async (req, res) => {
  try {
    const [providers] = await db.query('SELECT * FROM openclaw_providers ORDER BY sort_order');
    res.json(providers);
  } catch (err) {
    res.status(500).json({ error: '获取供应商失败' });
  }
});

// 供应商管理 - 新增
router.post('/providers', async (req, res) => {
  const { name, display_name, base_url, api_key, status, sort_order } = req.body;
  try {
    await db.query(
      'INSERT INTO openclaw_providers (name, display_name, base_url, api_key, status, sort_order) VALUES (?,?,?,?,?,?)',
      [name, display_name, base_url || null, api_key || null, status || 'active', sort_order || 0]
    );
    res.json({ message: '已添加' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '添加失败' });
  }
});

// 供应商管理 - 更新
router.put('/providers/:id', async (req, res) => {
  const { name, display_name, base_url, api_key, status, sort_order } = req.body;
  try {
    await db.query(
      'UPDATE openclaw_providers SET name=?, display_name=?, base_url=?, api_key=?, status=?, sort_order=? WHERE id=?',
      [name, display_name, base_url || null, api_key || null, status || 'active', sort_order || 0, req.params.id]
    );
    res.json({ message: '已更新' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '更新失败' });
  }
});

// 供应商管理 - 删除(软删除)
router.delete('/providers/:id', async (req, res) => {
  try {
    await db.query('UPDATE openclaw_providers SET status="disabled" WHERE id=?', [req.params.id]);
    res.json({ message: '已禁用' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '删除失败' });
  }
});

// 用户详情
router.get('/users/:id', async (req, res) => {
  const userId = req.params.id;
  try {
    const [[user]] = await db.query(
      'SELECT u.id, u.username, u.role, u.created_at, COALESCE(q.balance, 0) as balance FROM users u LEFT JOIN user_quota q ON u.id = q.user_id WHERE u.id = ?',
      [userId]
    );
    if (!user) return res.status(404).json({ error: '用户不存在' });

    const [packages] = await db.query(
      `SELECT up.id, up.package_id, up.started_at, up.expires_at, up.status, p.name as package_name, p.type, p.monthly_quota, p.daily_limit
       FROM openclaw_user_packages up
       JOIN openclaw_packages p ON up.package_id = p.id
       WHERE up.user_id = ? ORDER BY up.started_at DESC`,
      [userId]
    );

    const [boosterOrders] = await db.query(
      `SELECT out_trade_no, amount, status, created_at, paid_at FROM recharge_orders WHERE user_id = ? AND order_type = 'recharge' ORDER BY created_at DESC LIMIT 20`,
      [userId]
    );

    const [packageOrders] = await db.query(
      `SELECT ro.out_trade_no, ro.amount, ro.balance_used, ro.actual_paid, ro.status, ro.created_at, ro.paid_at, p.name as package_name
       FROM recharge_orders ro LEFT JOIN openclaw_packages p ON ro.package_id = p.id
       WHERE ro.user_id = ? AND ro.order_type = 'package' ORDER BY ro.created_at DESC LIMIT 20`,
      [userId]
    );

    const [balanceLogs] = await db.query(
      'SELECT id, amount, balance_before, balance_after, type, description, created_at FROM balance_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [userId]
    );

    const [apiKeys] = await db.query(
      'SELECT id, key_display, name, status, created_at, last_used_at FROM openclaw_api_keys WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );

    const [callLogs] = await db.query(
      `SELECT id, model, prompt_tokens, completion_tokens, total_cost, status, error_message, created_at FROM openclaw_call_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
      [userId]
    );

    const [[stats]] = await db.query(
      'SELECT COUNT(*) as total_calls, COALESCE(SUM(total_cost),0) as total_cost, COALESCE(SUM(prompt_tokens+completion_tokens),0) as total_tokens FROM openclaw_call_logs WHERE user_id = ?',
      [userId]
    );

    res.json({ user, packages, boosterOrders, packageOrders, balanceLogs, apiKeys, callLogs, stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取用户详情失败' });
  }
});

// 用户调用日志 (分页)
router.get('/users/:id/calls', async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;
  try {
    const [logs] = await db.query(
      `SELECT id, model, prompt_tokens, completion_tokens, total_cost, status, error_message, created_at FROM openclaw_call_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [req.params.id, Number(limit), Number(offset)]
    );
    const [[{ total }]] = await db.query('SELECT COUNT(*) as total FROM openclaw_call_logs WHERE user_id = ?', [req.params.id]);
    res.json({ logs, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取调用日志失败' });
  }
});

// 全部订单列表
router.get('/orders', async (req, res) => {
  const { page = 1, limit = 20, user_id, status, order_type } = req.query;
  const offset = (page - 1) * limit;
  try {
    let where = '1=1';
    const params = [];
    if (user_id) { where += ' AND ro.user_id = ?'; params.push(Number(user_id)); }
    if (status) { where += ' AND ro.status = ?'; params.push(status); }
    if (order_type) { where += ' AND ro.order_type = ?'; params.push(order_type); }
    const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM recharge_orders ro WHERE ${where}`, params);
    const [orders] = await db.query(
      `SELECT ro.id, ro.out_trade_no, ro.user_id, u.username, ro.order_type,
        ro.amount, ro.balance_used, ro.actual_paid, ro.status,
        ro.created_at, ro.paid_at, p.name as package_name
       FROM recharge_orders ro
       LEFT JOIN users u ON ro.user_id = u.id
       LEFT JOIN openclaw_packages p ON ro.package_id = p.id
       WHERE ${where} ORDER BY ro.created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    );
    res.json({ orders, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取订单失败' });
  }
});

// 请求日志列表（含 prompt 预览）
router.get('/logs', async (req, res) => {
  const { page = 1, limit = 50, user_id, model, status, date } = req.query;
  const offset = (page - 1) * limit;
  try {
    let where = '1=1';
    const params = [];
    if (user_id) { where += ' AND l.user_id = ?'; params.push(Number(user_id)); }
    if (model) { where += ' AND l.model LIKE ?'; params.push(`%${model}%`); }
    if (status) { where += ' AND l.status = ?'; params.push(status); }
    if (date) { where += ' AND DATE(l.created_at) = ?'; params.push(date); }

    const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM openclaw_call_logs l WHERE ${where}`, params);
    const [logs] = await db.query(
      `SELECT l.id, l.request_id, l.user_id, u.username, l.model,
        l.prompt_tokens, l.completion_tokens, l.total_cost, l.ip,
        l.status, l.error_message, l.created_at,
        LEFT(r.user_prompt, 200) as user_prompt_preview,
        (r.request_id IS NOT NULL) as has_detail
       FROM openclaw_call_logs l
       LEFT JOIN users u ON l.user_id = u.id
       LEFT JOIN openclaw_request_logs r ON l.request_id = r.request_id
       WHERE ${where}
       ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    );
    res.json({ logs, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取日志失败' });
  }
});

// 单条请求完整内容
router.get('/logs/:requestId', async (req, res) => {
  try {
    const [[log]] = await db.query(
      `SELECT l.*, u.username,
        r.user_prompt, r.messages, r.system_prompt, r.response_content
       FROM openclaw_call_logs l
       LEFT JOIN users u ON l.user_id = u.id
       LEFT JOIN openclaw_request_logs r ON l.request_id = r.request_id
       WHERE l.request_id = ?`,
      [req.params.requestId]
    );
    if (!log) return res.status(404).json({ error: '日志不存在' });
    res.json(log);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取日志详情失败' });
  }
});

module.exports = router;
