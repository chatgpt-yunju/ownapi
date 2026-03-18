const db = require('../config/db');

// 汇率配置
const EXCHANGE_RATE = 7.2; // USD to CNY

// 计算调用费用（自动处理币种转换）
function calculateCost(promptTokens, completionTokens, inputPrice, outputPrice, currency = 'CNY') {
  const costInOriginalCurrency = (promptTokens * inputPrice + completionTokens * outputPrice) / 1000;

  // 如果是美元，转换为人民币
  if (currency === 'USD') {
    return costInOriginalCurrency * EXCHANGE_RATE;
  }

  return costInOriginalCurrency;
}

// 扣费 + 写日志（事务）
async function deductBalance(userId, cost, description) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 检查余额
    const [[quota]] = await conn.query('SELECT balance FROM user_quota WHERE user_id = ? FOR UPDATE', [userId]);
    if (!quota || Number(quota.balance) < cost) {
      await conn.rollback();
      return { success: false, reason: 'insufficient_balance', balance: quota?.balance ?? 0 };
    }

    const balanceBefore = Number(quota.balance);
    const balanceAfter = balanceBefore - cost;

    // 扣余额
    await conn.query('UPDATE user_quota SET balance = balance - ? WHERE user_id = ?', [cost, userId]);

    // 写 balance_logs
    await conn.query(
      'INSERT INTO balance_logs (user_id, amount, balance_before, balance_after, type, description, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
      [userId, -cost, balanceBefore, balanceAfter, 'buy_quota', description]
    );

    await conn.commit();
    return { success: true, balance: balanceAfter };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { calculateCost, deductBalance, EXCHANGE_RATE };
