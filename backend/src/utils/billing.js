const db = require('../config/db');

// 默认汇率（USD to CNY）
const DEFAULT_EXCHANGE_RATE = 7.2;

// 汇率缓存
let cachedRate = null;
let cacheTime = 0;
const CACHE_TTL = 3600000; // 1小时

// 从数据库读取汇率，1小时缓存
async function getExchangeRate() {
  const now = Date.now();
  if (cachedRate && (now - cacheTime) < CACHE_TTL) {
    return cachedRate;
  }
  try {
    const [[row]] = await db.query("SELECT `value` FROM settings WHERE `key` = 'exchange_rate'");
    cachedRate = row ? parseFloat(row.value) || DEFAULT_EXCHANGE_RATE : DEFAULT_EXCHANGE_RATE;
  } catch (e) {
    cachedRate = DEFAULT_EXCHANGE_RATE;
  }
  cacheTime = now;
  return cachedRate;
}

// 最小计费精度（匹配数据库 DECIMAL(10,6)）
const MIN_COST = 0.000001;

// 计算调用费用（统一输出 USD）
async function calculateCost(promptTokens, completionTokens, inputPrice, outputPrice, currency = 'CNY') {
  const costInOriginalCurrency = (promptTokens * inputPrice + completionTokens * outputPrice) / 1000;

  let cost;
  // 如果是人民币定价，转换为美元
  if (currency === 'CNY') {
    const rate = await getExchangeRate();
    cost = costInOriginalCurrency / rate;
  } else {
    cost = costInOriginalCurrency;
  }

  // 有token消耗但费用低于DB精度时，取最小值
  if (cost > 0 && cost < MIN_COST) {
    cost = MIN_COST;
  }

  return cost;
}

// 扣费 + 写日志（事务）
// preReserved: 预扣金额，如果之前有预扣，会先补回预扣金额再扣除实际费用
async function deductBalance(userId, cost, description, preReserved = 0) {
 const conn = await db.getConnection();
 try {
 await conn.beginTransaction();

 // 检查余额
 const [[quota]] = await conn.query('SELECT balance FROM openclaw_quota WHERE user_id = ? FOR UPDATE', [userId]);

 // 计算实际需要扣除的金额
 // 如果有预扣：实际扣款 = cost - preReserved（可能为正或负）
 // 为正：需要再扣更多；为负：需要补回部分
 const actualDeduction = cost - preReserved;
 const currentBalance = Number(quota?.balance ?? 0);

 // 如果需要再扣更多，检查余额是否足够
 if (actualDeduction > 0 && currentBalance < actualDeduction) {
 await conn.rollback();
 return { success: false, reason: 'insufficient_balance', balance: currentBalance };
 }

 // 计算扣款前后的余额（用于日志）
 // balanceBefore 应该是预扣前的值 = 当前余额 + 预扣金额
 const balanceBefore = currentBalance + preReserved;
 const balanceAfter = balanceBefore - cost;

 // 执行余额调整
 if (actualDeduction !== 0) {
 await conn.query('UPDATE openclaw_quota SET balance = balance - ? WHERE user_id = ?', [actualDeduction, userId]);
 }

 // 写 balance_logs
 await conn.query(
 'INSERT INTO balance_logs (user_id, amount, balance_before, balance_after, type, description, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
 [userId, -cost, balanceBefore, balanceAfter, 'api_call', description]
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

module.exports = { calculateCost, deductBalance, getExchangeRate };
