const router = require('express').Router();
const db = require('../config/db');
const { ensureQuota } = require('../middleware/apiKeyAuth');

// 获取用户信息
router.get('/info', async (req, res) => {
  try {
    // 确保 openclaw_quota 行存在，新用户首次访问仪表盘时自动初始化配额
    await ensureQuota(req.user.id);

    const [[quota]] = await db.query(
      'SELECT balance FROM openclaw_quota WHERE user_id = ?',
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
    // 获取当前套餐
    let [[myPkg]] = await db.query(
      `SELECT up.started_at, up.expires_at, p.name as package_name, p.daily_limit, p.monthly_quota, p.type
       FROM openclaw_user_packages up
       JOIN openclaw_packages p ON up.package_id = p.id
       WHERE up.user_id = ? AND up.status = 'active' AND (up.expires_at IS NULL OR up.expires_at > NOW())
       ORDER BY up.started_at DESC LIMIT 1`,
      [req.user.id]
    );
    // 没有套餐时使用 Free 默认值
    if (!myPkg) {
      const [[freePkg]] = await db.query(
        'SELECT name as package_name, daily_limit, monthly_quota, type FROM openclaw_packages WHERE type = "free" AND status = "active" LIMIT 1'
      );
      if (freePkg) {
        myPkg = { ...freePkg, started_at: null, expires_at: null };
      }
    }

    // 计算24小时窗口（从套餐开始时间对齐）
    const windowMs = 5 * 60 * 60 * 1000;
    let windowStart, windowEnd;
    if (myPkg && myPkg.started_at) {
      const startMs = new Date(myPkg.started_at).getTime();
      const nowMs = Date.now();
      const windowIndex = Math.floor((nowMs - startMs) / windowMs);
      windowStart = new Date(startMs + windowIndex * windowMs);
      windowEnd = new Date(startMs + (windowIndex + 1) * windowMs);
    } else {
      const now = new Date();
      const day = now.getDay() === 0 ? 6 : now.getDay() - 1;
      windowStart = new Date(now);
      windowStart.setDate(now.getDate() - day);
      windowStart.setHours(0, 0, 0, 0);
      windowEnd = new Date(windowStart.getTime() + windowMs);
    }

    // 月度周期：从套餐开始到过期
    const monthStart = myPkg?.started_at ? new Date(myPkg.started_at) : windowStart;
    const monthEnd = myPkg?.expires_at ? new Date(myPkg.expires_at) : new Date(monthStart.getTime() + 30 * 24 * 60 * 60 * 1000);

    const [[monthUsage]] = await db.query(
      'SELECT COUNT(*) as calls, COALESCE(SUM(total_cost),0) as cost FROM openclaw_call_logs WHERE user_id = ? AND created_at >= ? AND status = "success"',
      [req.user.id, monthStart]
    );

    // 加油包：统计充值记录总额（只计type='booster'，排除套餐自动发放的recharge）
    const [[boosterStats]] = await db.query(
      `SELECT COALESCE(SUM(amount), 0) as total_purchased_cny
       FROM balance_logs WHERE user_id = ? AND type = 'booster' AND amount > 0`,
      [req.user.id]
    );

    const currentBalance = parseFloat(quota?.balance ?? 0);
    const monthlyQuota = myPkg?.monthly_quota ? parseFloat(myPkg.monthly_quota) : null;
    const monthlyCallLimit = myPkg?.daily_limit ? myPkg.daily_limit * 30 : null;
    const monthCalls = monthUsage.calls || 0;
    const monthCost = parseFloat(monthUsage.cost || 0);
    const boosterPurchasedCNY = parseFloat(boosterStats?.total_purchased_cny ?? 0);

    // 计算每个24h窗口的费用限额
    let windowCostLimit = null;
    if (monthlyQuota != null && myPkg) {
      if (myPkg.expires_at && myPkg.started_at) {
        const durationMs = new Date(myPkg.expires_at).getTime() - new Date(myPkg.started_at).getTime();
        const totalWindows = durationMs / windowMs;
        windowCostLimit = totalWindows > 0 ? monthlyQuota / totalWindows : monthlyQuota;
      } else {
        // 默认按30天计算
        windowCostLimit = monthlyQuota * 5 * 24 / (30 * 24) // 5小时窗口，30天月;
      }
      windowCostLimit = Math.round(windowCostLimit * 100) / 100;
    }

    // 加油包余额统计（套餐配额优先消耗，加油包后消耗）
    const boosterTotal = boosterPurchasedCNY;
    const boosterUsed = Math.max(0, monthCost - (monthlyQuota || 0));
    const boosterBalance = Math.max(0, boosterTotal - boosterUsed);

    res.json({
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      balance: currentBalance,
      daily_limit: myPkg?.daily_limit ?? null,
      monthly_call_limit: monthlyCallLimit,
      monthly_quota: monthlyQuota,
      window_cost_limit: windowCostLimit,
      active_keys: keyCnt.cnt,
      today_calls: todayUsage.calls,
      today_cost: todayUsage.cost,
      package_name: myPkg?.package_name ?? null,
      package_type: myPkg?.type ?? null,
      window_start: windowStart,
      window_end: windowEnd,
      month_start: monthStart,
      month_end: monthEnd,
      month_calls: monthCalls,
      month_cost: monthCost,
      booster_balance: boosterBalance,
      booster_used: boosterUsed,
      booster_total: boosterTotal,
      booster_total_purchased_cny: boosterPurchasedCNY
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取信息失败' });
  }
});

// 获取余额
router.get('/balance', async (req, res) => {
  try {
    const [[quota]] = await db.query('SELECT balance FROM openclaw_quota WHERE user_id = ?', [req.user.id]);
    res.json({ balance: quota?.balance ?? 0 });
  } catch (err) {
    res.status(500).json({ error: '获取余额失败' });
  }
});

module.exports = router;
