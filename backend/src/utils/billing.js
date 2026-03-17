const db = require('../config/db');

// 计算调用费用
function calculateCost(promptTokens, completionTokens, inputPrice, outputPrice) {
  return (promptTokens * inputPrice + completionTokens * outputPrice) / 1000;
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

    // 扣余额
    await conn.query('UPDATE user_quota SET balance = balance - ? WHERE user_id = ?', [cost, userId]);

    // 写 balance_logs
    await conn.query(
      'INSERT INTO balance_logs (user_id, amount, type, description, created_at) VALUES (?, ?, ?, ?, NOW())',
      [userId, -cost, 'api_deduct', description]
    );

    await conn.commit();
    return { success: true, balance: Number(quota.balance) - cost };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { calculateCost, deductBalance };
