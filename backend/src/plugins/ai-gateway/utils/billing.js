const db = require('../../../config/db');
const { getSettingCached } = require('../../../routes/quota');

const DEFAULT_EXCHANGE_RATE = 7.2;
const CACHE_TTL = 3600000;
const MIN_COST = 0.000001;

const BALANCE_TABLES = {
  quota: 'openclaw_quota',
  wallet: 'openclaw_wallet',
};

let cachedRate = null;
let cacheTime = 0;

function roundAmount(value) {
  return Number(Number(value || 0).toFixed(6));
}

function normalizeBillingMode(mode) {
  return mode === 'per_call' ? 'per_call' : 'token';
}

function normalizeBalanceType(balanceType) {
  return balanceType === 'wallet' ? 'wallet' : 'quota';
}

function normalizeModelCategory(category) {
  const normalized = String(category || '').toLowerCase();
  if (['language', 'image', 'vision', 'audio', 'coding'].includes(normalized)) {
    return normalized;
  }
  return 'language';
}

function classifyModelCategory(modelId, provider = '') {
  const target = `${modelId || ''} ${provider || ''}`.toLowerCase();

  if (/(audio|whisper|tts|speech|transcribe|transcription|asr|realtime-audio)/.test(target)) {
    return 'audio';
  }
  if (/(seedream|dall|flux|stable-diffusion|image|midjourney|sdxl|kolors)/.test(target)) {
    return 'image';
  }
  if (/(vision|multimodal|paligemma|fuyu|kosmos|neva|vila|deplot|streampetr|nvclip|vlm|embed-vl|nemoretriever-parse|nemotron-parse|vl\b|gpt-4\.?1-?vision|gpt-4o|gemini.*vision)/.test(target)) {
    return 'vision';
  }
  if (/(codex|coder|codegemma|codestral|starcoder|codellama|devstral|granite-.*code|embedcode|qwen.*coder|gpt-5|(^|[^a-z])o[1-9]([^a-z]|$)|programming|coding)/.test(target)) {
    return 'coding';
  }
  return 'language';
}

function getModelBillingMeta(modelConfig = {}) {
  const billingMode = normalizeBillingMode(modelConfig.billing_mode);
  const balanceType = billingMode === 'per_call' ? 'wallet' : 'quota';
  const perCallPrice = roundAmount(modelConfig.per_call_price || 0);
  return { billingMode, balanceType, perCallPrice };
}

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

async function calculateCost(promptTokens, completionTokens, inputPrice, outputPrice, currency = 'CNY') {
  const costInOriginalCurrency = (Number(promptTokens || 0) * Number(inputPrice || 0) + Number(completionTokens || 0) * Number(outputPrice || 0)) / 1000;

  let cost;
  if (currency === 'CNY') {
    const rate = await getExchangeRate();
    cost = costInOriginalCurrency / rate;
  } else {
    cost = costInOriginalCurrency;
  }

  if (cost > 0 && cost < MIN_COST) {
    cost = MIN_COST;
  }

  return roundAmount(cost);
}

function getBalanceTable(balanceType) {
  return BALANCE_TABLES[normalizeBalanceType(balanceType)];
}

async function ensureBalanceRecord(userId, balanceType, conn = db) {
  const table = getBalanceTable(balanceType);
  // 检查是否已存在，避免覆盖已有余额
  const [[existing]] = await conn.query(`SELECT user_id FROM ${table} WHERE user_id = ?`, [userId]);
  if (existing) return;
  // 新用户使用 settings 中配置的默认值
  const settingKey = balanceType === 'quota' ? 'new_user_quota' : 'new_user_wallet';
  const defaultBalance = parseFloat(await getSettingCached(settingKey, '0')) || 0;
  await conn.query(
    `INSERT IGNORE INTO ${table} (user_id, balance) VALUES (?, ?)`,
    [userId, defaultBalance]
  );
}

async function ensureQuotaBalance(userId, conn = db) {
  await ensureBalanceRecord(userId, 'quota', conn);
  const [[row]] = await conn.query('SELECT balance FROM openclaw_quota WHERE user_id = ?', [userId]);
  return roundAmount(row?.balance || 0);
}

async function ensureWalletBalance(userId, conn = db) {
  await ensureBalanceRecord(userId, 'wallet', conn);
  const [[row]] = await conn.query('SELECT balance FROM openclaw_wallet WHERE user_id = ?', [userId]);
  return roundAmount(row?.balance || 0);
}

async function ensureUserBalances(userId, conn = db) {
  const [quotaBalance, walletBalance] = await Promise.all([
    ensureQuotaBalance(userId, conn),
    ensureWalletBalance(userId, conn),
  ]);
  return { quotaBalance, walletBalance };
}

async function getLockedBalance(conn, userId, balanceType) {
  const normalizedBalanceType = normalizeBalanceType(balanceType);
  const table = getBalanceTable(normalizedBalanceType);
  await ensureBalanceRecord(userId, normalizedBalanceType, conn);
  const [[row]] = await conn.query(`SELECT balance FROM ${table} WHERE user_id = ? FOR UPDATE`, [userId]);
  return roundAmount(row?.balance || 0);
}

async function appendBalanceLog(conn, {
  userId,
  balanceType,
  amount,
  balanceBefore,
  balanceAfter,
  type,
  description,
  metadata,
}) {
  await conn.query(
    `INSERT INTO openclaw_balance_logs
      (user_id, balance_type, amount, balance_before, balance_after, type, description, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      userId,
      normalizeBalanceType(balanceType),
      roundAmount(amount),
      roundAmount(balanceBefore),
      roundAmount(balanceAfter),
      type || null,
      description || null,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );
}

async function adjustBalance(userId, balanceType, delta, logType, description, metadata = null, existingConn = null) {
  const normalizedBalanceType = normalizeBalanceType(balanceType);
  const table = getBalanceTable(normalizedBalanceType);
  const conn = existingConn || await db.getConnection();
  const ownConnection = !existingConn;
  const amount = roundAmount(delta);

  try {
    if (ownConnection) await conn.beginTransaction();

    const balanceBefore = await getLockedBalance(conn, userId, normalizedBalanceType);
    if (amount < 0 && balanceBefore < Math.abs(amount)) {
      if (ownConnection) await conn.rollback();
      return { success: false, reason: 'insufficient_balance', balance: balanceBefore };
    }

    const balanceAfter = roundAmount(balanceBefore + amount);
    await conn.query(`UPDATE ${table} SET balance = ? WHERE user_id = ?`, [balanceAfter, userId]);

    if (amount !== 0) {
      await appendBalanceLog(conn, {
        userId,
        balanceType: normalizedBalanceType,
        amount,
        balanceBefore,
        balanceAfter,
        type: logType,
        description,
        metadata,
      });
    }

    if (ownConnection) await conn.commit();
    return { success: true, balance: balanceAfter, balanceBefore, balanceAfter, delta: amount };
  } catch (err) {
    if (ownConnection) await conn.rollback();
    throw err;
  } finally {
    if (ownConnection) conn.release();
  }
}

async function reserveBalance(userId, balanceType, amount, existingConn = null) {
  const normalizedBalanceType = normalizeBalanceType(balanceType);
  const table = getBalanceTable(normalizedBalanceType);
  const conn = existingConn || await db.getConnection();
  const ownConnection = !existingConn;
  const reservedAmount = roundAmount(amount);

  try {
    if (ownConnection) await conn.beginTransaction();

    const balanceBefore = await getLockedBalance(conn, userId, normalizedBalanceType);
    if (reservedAmount > 0 && balanceBefore < reservedAmount) {
      if (ownConnection) await conn.rollback();
      return { success: false, reason: 'insufficient_balance', balance: balanceBefore };
    }

    const balanceAfter = roundAmount(balanceBefore - reservedAmount);
    if (reservedAmount > 0) {
      await conn.query(`UPDATE ${table} SET balance = ? WHERE user_id = ?`, [balanceAfter, userId]);
    }

    if (ownConnection) await conn.commit();
    return {
      success: true,
      balanceType: normalizedBalanceType,
      reservedAmount,
      balanceBefore,
      balanceAfter,
    };
  } catch (err) {
    if (ownConnection) await conn.rollback();
    throw err;
  } finally {
    if (ownConnection) conn.release();
  }
}

async function settleReservedCharge(
  userId,
  balanceType,
  chargedAmount,
  description,
  reservedAmount = 0,
  logType = 'api_call',
  metadata = null
) {
  const normalizedBalanceType = normalizeBalanceType(balanceType);
  const table = getBalanceTable(normalizedBalanceType);
  const charge = roundAmount(chargedAmount);
  const reserve = roundAmount(reservedAmount);

  if (charge <= 0 && reserve > 0) {
    return refundReservedBalance(userId, normalizedBalanceType, reserve, 'refund', description || '预留退款', metadata);
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const currentBalance = await getLockedBalance(conn, userId, normalizedBalanceType);
    const actualDeduction = roundAmount(charge - reserve);

    if (actualDeduction > 0 && currentBalance < actualDeduction) {
      await conn.rollback();
      return { success: false, reason: 'insufficient_balance', balance: currentBalance };
    }

    const balanceBefore = roundAmount(currentBalance + reserve);
    const balanceAfter = roundAmount(balanceBefore - charge);

    if (actualDeduction !== 0) {
      await conn.query(`UPDATE ${table} SET balance = ? WHERE user_id = ?`, [balanceAfter, userId]);
    }

    if (charge > 0) {
      await appendBalanceLog(conn, {
        userId,
        balanceType: normalizedBalanceType,
        amount: -charge,
        balanceBefore,
        balanceAfter,
        type: logType,
        description,
        metadata,
      });
    }

    await conn.commit();
    return { success: true, balance: balanceAfter, chargedAmount: charge, balanceType: normalizedBalanceType };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function refundReservedBalance(userId, balanceType, reservedAmount, logType = 'refund', description = '预留退款', metadata = null) {
  const refundAmount = roundAmount(reservedAmount);
  if (refundAmount <= 0) {
    return { success: true, refundedAmount: 0, skipped: true };
  }

  return adjustBalance(userId, balanceType, refundAmount, logType, description, metadata);
}

async function reserveModelCharge(userId, modelConfig, tokenReserve = 0, metadata = null) {
  const billing = getModelBillingMeta(modelConfig);
  const reservedAmount = billing.billingMode === 'per_call' ? billing.perCallPrice : roundAmount(tokenReserve);
  const result = await reserveBalance(userId, billing.balanceType, reservedAmount);
  return { ...billing, ...result };
}

async function settleModelCharge(userId, modelConfig, tokenCost, description, reservation = null, metadata = null) {
  const billing = getModelBillingMeta(modelConfig);
  const chargedAmount = billing.billingMode === 'per_call'
    ? billing.perCallPrice
    : roundAmount(tokenCost);
  const reservedAmount = roundAmount(reservation?.reservedAmount || 0);

  return settleReservedCharge(
    userId,
    billing.balanceType,
    chargedAmount,
    description,
    reservedAmount,
    'api_call',
    metadata
  );
}

async function refundModelCharge(userId, modelConfig, reservation = null, description = '请求失败，释放预留余额', metadata = null) {
  const billing = getModelBillingMeta(modelConfig);
  const reservedAmount = roundAmount(reservation?.reservedAmount || 0);
  return refundReservedBalance(userId, billing.balanceType, reservedAmount, 'refund', description, metadata);
}

module.exports = {
  MIN_COST,
  calculateCost,
  getExchangeRate,
  roundAmount,
  normalizeBillingMode,
  normalizeBalanceType,
  normalizeModelCategory,
  classifyModelCategory,
  getModelBillingMeta,
  ensureBalanceRecord,
  ensureQuotaBalance,
  ensureWalletBalance,
  ensureUserBalances,
  adjustBalance,
  reserveBalance,
  settleReservedCharge,
  refundReservedBalance,
  reserveModelCharge,
  settleModelCharge,
  refundModelCharge,
};
