const db = require('../../config/db');
const {
  classifyModelCategory,
  normalizeModelCategory,
} = require('./utils/billing');
const { getDomesticAveragePricing } = require('./utils/smartRouterPricing');

function normalizeProviderKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

async function mergeProviderRows(sourceProviderId, targetProviderId) {
  if (!sourceProviderId || !targetProviderId || sourceProviderId === targetProviderId) return;

  await db.query(
    'UPDATE openclaw_provider_endpoints SET provider_id = ? WHERE provider_id = ?',
    [targetProviderId, sourceProviderId]
  );

  const [targetBindings] = await db.query(
    'SELECT model_id FROM openclaw_model_providers WHERE provider_id = ?',
    [targetProviderId]
  );
  const targetModelIds = new Set(targetBindings.map(row => row.model_id));

  const [sourceBindings] = await db.query(
    'SELECT id, model_id FROM openclaw_model_providers WHERE provider_id = ? ORDER BY id',
    [sourceProviderId]
  );

  for (const binding of sourceBindings) {
    if (targetModelIds.has(binding.model_id)) {
      await db.query('DELETE FROM openclaw_model_providers WHERE id = ?', [binding.id]).catch(() => {});
      continue;
    }

    await db.query(
      'UPDATE openclaw_model_providers SET provider_id = ? WHERE id = ?',
      [targetProviderId, binding.id]
    ).catch(() => {});
    targetModelIds.add(binding.model_id);
  }

  await db.query('UPDATE openclaw_providers SET status = "disabled" WHERE id = ?', [sourceProviderId]);
}

module.exports = async function migrate() {
  await db.query(`CREATE TABLE IF NOT EXISTS openclaw_models (
    id INT AUTO_INCREMENT PRIMARY KEY,
    model_id VARCHAR(100) NOT NULL UNIQUE,
    display_name VARCHAR(200),
    provider VARCHAR(50),
    input_price_per_1k DECIMAL(10,6) DEFAULT 0,
    output_price_per_1k DECIMAL(10,6) DEFAULT 0,
    status ENUM('active','inactive') DEFAULT 'active',
    sort_order INT DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});
  await db.query("ALTER TABLE openclaw_models ADD COLUMN price_currency VARCHAR(10) DEFAULT 'CNY'").catch(() => {});
  await db.query("ALTER TABLE openclaw_models ADD COLUMN upstream_model_id VARCHAR(200) DEFAULT NULL").catch(() => {});
  await db.query("ALTER TABLE openclaw_models ADD COLUMN upstream_endpoint VARCHAR(500) DEFAULT NULL").catch(() => {});
  await db.query("ALTER TABLE openclaw_models ADD COLUMN upstream_key VARCHAR(500) DEFAULT NULL").catch(() => {});
  await db.query("ALTER TABLE openclaw_models ADD COLUMN billing_mode ENUM('token','per_call') NOT NULL DEFAULT 'token'").catch(() => {});
  await db.query('ALTER TABLE openclaw_models ADD COLUMN per_call_price DECIMAL(12,6) DEFAULT NULL').catch(() => {});
  await db.query("ALTER TABLE openclaw_models ADD COLUMN model_category ENUM('language','image','vision','audio','coding','smart_route') NOT NULL DEFAULT 'language'").catch(() => {});
  await db.query("ALTER TABLE openclaw_models MODIFY COLUMN model_category ENUM('language','image','vision','audio','coding','smart_route') NOT NULL DEFAULT 'language'").catch(() => {});

  await db.query(`CREATE TABLE IF NOT EXISTS openclaw_api_keys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    key_hash VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(20),
    name VARCHAR(100),
    balance DECIMAL(12,4) DEFAULT 0,
    status ENUM('active','disabled') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});

  await db.query(`CREATE TABLE IF NOT EXISTS openclaw_request_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    api_key_id INT,
    model VARCHAR(100),
    input_tokens INT DEFAULT 0,
    output_tokens INT DEFAULT 0,
    cost DECIMAL(10,6) DEFAULT 0,
    status VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});

  await db.query(`CREATE TABLE IF NOT EXISTS openclaw_ccclub_keys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    api_key VARCHAR(500) NOT NULL UNIQUE,
    notes VARCHAR(255) DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});

  // CC Club key 冷却记录：记录每个 key 的重置时间，未到期自动禁用，到期自动启用
  await db.query(`CREATE TABLE IF NOT EXISTS openclaw_ccclub_key_resets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    key_fingerprint CHAR(64) NOT NULL UNIQUE,
    provider_name VARCHAR(100) DEFAULT '',
    base_url VARCHAR(500) DEFAULT '',
    reset_at DATETIME NOT NULL,
    status ENUM('cooldown','ready') DEFAULT 'cooldown',
    last_status_code INT DEFAULT NULL,
    last_error_message TEXT,
    last_seen_at DATETIME DEFAULT NOW(),
    cooldown_notified_at DATETIME DEFAULT NULL,
    recovered_notified_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT NOW(),
    updated_at DATETIME DEFAULT NOW() ON UPDATE NOW(),
    INDEX idx_status_reset (status, reset_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});
  await db.query('ALTER TABLE openclaw_ccclub_key_resets ADD COLUMN cooldown_notified_at DATETIME DEFAULT NULL').catch(() => {});
  await db.query('ALTER TABLE openclaw_ccclub_key_resets ADD COLUMN recovered_notified_at DATETIME DEFAULT NULL').catch(() => {});

  // 火山引擎 key 冷却记录：记录每个 key 的重置时间，未到期自动禁用，到期自动启用
  await db.query(`CREATE TABLE IF NOT EXISTS openclaw_huoshan_key_resets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    key_fingerprint CHAR(64) NOT NULL UNIQUE,
    provider_name VARCHAR(100) DEFAULT '',
    base_url VARCHAR(500) DEFAULT '',
    reset_at DATETIME NOT NULL,
    status ENUM('cooldown','ready') DEFAULT 'cooldown',
    last_status_code INT DEFAULT NULL,
    last_error_message TEXT,
    last_seen_at DATETIME DEFAULT NOW(),
    cooldown_notified_at DATETIME DEFAULT NULL,
    recovered_notified_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT NOW(),
    updated_at DATETIME DEFAULT NOW() ON UPDATE NOW(),
    INDEX idx_status_reset (status, reset_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});
  await db.query('ALTER TABLE openclaw_huoshan_key_resets ADD COLUMN cooldown_notified_at DATETIME DEFAULT NULL').catch(() => {});
  await db.query('ALTER TABLE openclaw_huoshan_key_resets ADD COLUMN recovered_notified_at DATETIME DEFAULT NULL').catch(() => {});

  await db.query(`CREATE TABLE IF NOT EXISTS openclaw_packages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100),
    type VARCHAR(50),
    price DECIMAL(10,2),
    balance DECIMAL(12,4) DEFAULT 0,
    models_allowed TEXT,
    status ENUM('active','inactive') DEFAULT 'active'
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});

  await db.query(`CREATE TABLE IF NOT EXISTS openclaw_user_packages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    package_id INT NOT NULL,
    status ENUM('active','expired') DEFAULT 'active',
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});

  // users 表加 ai-gateway 所需列
  await db.query('ALTER TABLE users ADD COLUMN extra_quota DECIMAL(12,4) DEFAULT 0').catch(() => {});
  await db.query('ALTER TABLE users ADD COLUMN vip_level INT DEFAULT 0').catch(() => {});
  await db.query('ALTER TABLE users ADD COLUMN balance DECIMAL(12,4) DEFAULT 0').catch(() => {});
  await db.query("ALTER TABLE users ADD COLUMN status ENUM('active','banned') DEFAULT 'active'").catch(() => {});

  // 充值订单表
  await db.query(`CREATE TABLE IF NOT EXISTS recharge_orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    out_trade_no VARCHAR(64) NOT NULL UNIQUE,
    user_id INT NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    quota DECIMAL(12,4) DEFAULT 0,
    bonus_quota DECIMAL(12,4) DEFAULT 0,
    status ENUM('pending','paid','failed','refunded') DEFAULT 'pending',
    order_type VARCHAR(30) DEFAULT 'recharge',
    trade_no VARCHAR(100),
    paid_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user (user_id),
    INDEX idx_trade (out_trade_no)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});

  // 余额日志表
  await db.query(`CREATE TABLE IF NOT EXISTS balance_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    amount DECIMAL(12,6) NOT NULL,
    balance_before DECIMAL(12,6) DEFAULT 0,
    balance_after DECIMAL(12,6) DEFAULT 0,
    type VARCHAR(30),
    description VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});

  await db.query(`CREATE TABLE IF NOT EXISTS openclaw_wallet (
    user_id INT NOT NULL PRIMARY KEY,
    balance DECIMAL(12,6) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});

  await db.query(`CREATE TABLE IF NOT EXISTS openclaw_balance_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    balance_type ENUM('quota','wallet') NOT NULL DEFAULT 'quota',
    amount DECIMAL(12,6) NOT NULL,
    balance_before DECIMAL(12,6) DEFAULT 0,
    balance_after DECIMAL(12,6) DEFAULT 0,
    type VARCHAR(30),
    description VARCHAR(500),
    detail_json LONGTEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user (user_id),
    INDEX idx_balance_type (balance_type),
    INDEX idx_user_balance_type (user_id, balance_type)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});

  // 精度升级：DECIMAL(12,2) → DECIMAL(12,6)，匹配 billing.js MIN_COST=0.000001
  await db.query('ALTER TABLE openclaw_quota MODIFY COLUMN balance DECIMAL(12,6) NOT NULL DEFAULT 0').catch(() => {});
  await db.query('ALTER TABLE openclaw_wallet MODIFY COLUMN balance DECIMAL(12,6) NOT NULL DEFAULT 0').catch(() => {});
  await db.query('ALTER TABLE balance_logs MODIFY COLUMN amount DECIMAL(12,6) NOT NULL').catch(() => {});
  await db.query('ALTER TABLE balance_logs MODIFY COLUMN balance_before DECIMAL(12,6) DEFAULT 0').catch(() => {});
  await db.query('ALTER TABLE balance_logs MODIFY COLUMN balance_after DECIMAL(12,6) DEFAULT 0').catch(() => {});
  await db.query('ALTER TABLE openclaw_balance_logs MODIFY COLUMN amount DECIMAL(12,6) NOT NULL').catch(() => {});
  await db.query('ALTER TABLE openclaw_balance_logs MODIFY COLUMN balance_before DECIMAL(12,6) DEFAULT 0').catch(() => {});
  await db.query('ALTER TABLE openclaw_balance_logs MODIFY COLUMN balance_after DECIMAL(12,6) DEFAULT 0').catch(() => {});
  await db.query("ALTER TABLE openclaw_balance_logs ADD COLUMN balance_type ENUM('quota','wallet') NOT NULL DEFAULT 'quota' AFTER user_id").catch(() => {});
  await db.query('ALTER TABLE openclaw_balance_logs ADD COLUMN detail_json LONGTEXT DEFAULT NULL AFTER description').catch(() => {});

  await db.query(`CREATE TABLE IF NOT EXISTS openclaw_rewards (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    type VARCHAR(50) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    description VARCHAR(500) DEFAULT NULL,
    status ENUM('pending','received','expired') DEFAULT 'received',
    related_id INT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    received_at DATETIME DEFAULT NULL,
    INDEX idx_user_status (user_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});

  await db.query(`CREATE TABLE IF NOT EXISTS openclaw_invite_records (
    id INT AUTO_INCREMENT PRIMARY KEY,
    inviter_id INT NOT NULL,
    invitee_id INT NOT NULL,
    invite_code VARCHAR(32) NOT NULL,
    reward_amount DECIMAL(10,2) DEFAULT 0.00,
    register_reward_amount DECIMAL(10,2) DEFAULT 0.00,
    first_paid_reward_amount DECIMAL(10,2) DEFAULT 0.00,
    first_paid_rewarded TINYINT(1) DEFAULT 0,
    first_paid_order_no VARCHAR(64) DEFAULT NULL,
    first_paid_at DATETIME DEFAULT NULL,
    status ENUM('pending','active','expired') DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_inviter (inviter_id),
    INDEX idx_invitee (invitee_id),
    INDEX idx_invite_code (invite_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});

  await db.query('ALTER TABLE openclaw_rewards MODIFY COLUMN status ENUM("pending","received","expired") DEFAULT "received"').catch(() => {});
  await db.query('ALTER TABLE openclaw_invite_records ADD COLUMN register_reward_amount DECIMAL(10,2) DEFAULT 0.00 AFTER reward_amount').catch(() => {});
  await db.query('ALTER TABLE openclaw_invite_records ADD COLUMN first_paid_reward_amount DECIMAL(10,2) DEFAULT 0.00 AFTER register_reward_amount').catch(() => {});
  await db.query('ALTER TABLE openclaw_invite_records ADD COLUMN first_paid_rewarded TINYINT(1) DEFAULT 0 AFTER first_paid_reward_amount').catch(() => {});
  await db.query('ALTER TABLE openclaw_invite_records ADD COLUMN first_paid_order_no VARCHAR(64) DEFAULT NULL AFTER first_paid_rewarded').catch(() => {});
  await db.query('ALTER TABLE openclaw_invite_records ADD COLUMN first_paid_at DATETIME DEFAULT NULL AFTER first_paid_order_no').catch(() => {});
  await db.query('ALTER TABLE openclaw_invite_records ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at').catch(() => {});

  await db.query(`CREATE TABLE IF NOT EXISTS openclaw_package_reminders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_package_id INT NOT NULL,
    reminder_key VARCHAR(32) NOT NULL,
    channel VARCHAR(20) NOT NULL DEFAULT 'both',
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_user_package_reminder (user_package_id, reminder_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});

  await db.query("ALTER TABLE openclaw_call_logs ADD COLUMN billing_mode ENUM('token','per_call') DEFAULT 'token'").catch(() => {});
  await db.query("ALTER TABLE openclaw_call_logs ADD COLUMN charged_balance_type ENUM('quota','wallet') DEFAULT NULL").catch(() => {});
  await db.query('ALTER TABLE openclaw_call_logs ADD COLUMN charged_amount DECIMAL(12,6) DEFAULT 0').catch(() => {});
  // 覆盖索引：加速月度 COUNT/SUM 聚合查询（user_id + created_at + status）
  await db.query('ALTER TABLE openclaw_call_logs ADD INDEX idx_user_month_status (user_id, created_at, status)').catch(() => {});
  // HTTP 状态码：区分 503(满载)/504(超时)/502(上游错误) 等
  await db.query('ALTER TABLE openclaw_call_logs ADD COLUMN http_status SMALLINT DEFAULT NULL').catch(() => {});

  // 供应商端点表：一个供应商可绑定多个 base_url + api_key
  await db.query(`CREATE TABLE IF NOT EXISTS openclaw_provider_endpoints (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider_id INT NOT NULL,
    base_url VARCHAR(500) NOT NULL,
    api_key VARCHAR(500) NOT NULL,
    weight INT DEFAULT 1,
    status ENUM('active','disabled') DEFAULT 'active',
    remark VARCHAR(200) DEFAULT NULL,
    created_at DATETIME DEFAULT NOW(),
    INDEX idx_provider (provider_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});

  // 将现有 provider 的 base_url+api_key 迁移到 endpoints 表（幂等）
  try {
    const [providers] = await db.query(
      'SELECT id, base_url, api_key FROM openclaw_providers WHERE base_url IS NOT NULL AND api_key IS NOT NULL'
    );
    for (const p of providers) {
      const [[exists]] = await db.query(
        'SELECT id FROM openclaw_provider_endpoints WHERE provider_id = ? AND api_key = ? LIMIT 1',
        [p.id, p.api_key]
      );
      if (!exists) {
        await db.query(
          'INSERT INTO openclaw_provider_endpoints (provider_id, base_url, api_key) VALUES (?, ?, ?)',
          [p.id, p.base_url, p.api_key]
        );
      }
    }
  } catch (e) { console.error('[migrate] provider endpoints migration:', e.message); }

  // 合并重复供应商（nvidia-2→nvidia, ccclub-2→ccclub-1 等）
  const mergeMap = {
    'nvidia-2': 'nvidia', 'nvidia-3': 'nvidia',
    'ccclub-2': 'ccclub-1', 'ccclub-openai-2': 'ccclub-openai-1'
  };
  for (const [oldName, newName] of Object.entries(mergeMap)) {
    try {
      const [[oldP]] = await db.query('SELECT id FROM openclaw_providers WHERE name = ?', [oldName]);
      const [[newP]] = await db.query('SELECT id FROM openclaw_providers WHERE name = ?', [newName]);
      if (!oldP || !newP) continue;
      // 迁移 endpoints 到目标供应商
      await db.query('UPDATE openclaw_provider_endpoints SET provider_id = ? WHERE provider_id = ?', [newP.id, oldP.id]);
      // 迁移 model_providers 引用
      // 先删除已存在的映射（避免 unique 冲突）
      const [existingMPs] = await db.query(
        'SELECT model_id FROM openclaw_model_providers WHERE provider_id = ?', [newP.id]
      );
      const existingModelIds = new Set(existingMPs.map(r => r.model_id));
      await db.query(
        'DELETE FROM openclaw_model_providers WHERE provider_id = ? AND model_id IN (?)',
        [oldP.id, existingMPs.length ? existingMPs.map(r => r.model_id) : [0]]
      ).catch(() => {});
      await db.query('UPDATE openclaw_model_providers SET provider_id = ? WHERE provider_id = ?', [newP.id, oldP.id]).catch(() => {});
      // 禁用旧供应商
      await db.query('UPDATE openclaw_providers SET status = "disabled" WHERE id = ?', [oldP.id]);
    } catch (e) { console.error(`[migrate] merge ${oldName}→${newName}:`, e.message); }
  }

  // 将火山引擎智能路由的历史命名统一为 Doubao-Smart-Router，兼容旧数据里
  // 不同的 smart-router 别名。
  try {
    const smartRouterCanonicalName = 'doubao-smart-router';
    const smartRouterCanonicalKey = normalizeProviderKey(smartRouterCanonicalName);
    const smartRouterDisplayName = 'Doubao-Smart-Router';
    const smartRouterNameKeys = new Set([
      normalizeProviderKey(smartRouterCanonicalName),
      normalizeProviderKey('doubao smart router'),
    ]);
    const smartRouterDisplayKeys = new Set([
      normalizeProviderKey(smartRouterDisplayName),
    ]);

    const [smartRouterRows] = await db.query(
      'SELECT id, name, display_name, base_url, api_key, status, sort_order FROM openclaw_providers'
    );
    const matchedRows = smartRouterRows.filter(row =>
      smartRouterNameKeys.has(normalizeProviderKey(row.name)) ||
      smartRouterDisplayKeys.has(normalizeProviderKey(row.display_name))
    );

    if (matchedRows.length > 0) {
      const canonicalRow = matchedRows.find(row => normalizeProviderKey(row.name) === smartRouterCanonicalKey)
        || matchedRows[0];

      for (const row of matchedRows) {
        if (row.id !== canonicalRow.id) {
          await mergeProviderRows(row.id, canonicalRow.id);
        }
      }

      const preferredBaseUrl = canonicalRow.base_url
        || matchedRows.find(row => row.id !== canonicalRow.id && row.base_url)?.base_url
        || null;
      const preferredApiKey = canonicalRow.api_key
        || matchedRows.find(row => row.id !== canonicalRow.id && row.api_key)?.api_key
        || null;
      const preferredStatus = matchedRows.some(row => row.status === 'active') ? 'active' : canonicalRow.status;
      const preferredSortOrder = canonicalRow.sort_order ?? 0;

      await db.query(
        `UPDATE openclaw_providers
         SET name = ?, display_name = ?, base_url = ?, api_key = ?, status = ?, sort_order = ?
         WHERE id = ?`,
        [
          smartRouterCanonicalName,
          smartRouterDisplayName,
          preferredBaseUrl,
          preferredApiKey,
          preferredStatus,
          preferredSortOrder,
          canonicalRow.id
        ]
      );
    }
  } catch (e) {
    console.error('[migrate] smart-router provider normalization:', e.message);
  }

  // 只保留 Smart-Route：其余火山引擎历史模型、供应商和上游绑定全部禁用。
  try {
    const nonSmartRouterNames = [
      'volcengine',
      'volcengine-1',
      'volcengine-2',
      'huoshan',
      'ark',
    ];
    const nonSmartRouterSql = nonSmartRouterNames.map((name) => `'${normalizeProviderKey(name)}'`).join(', ');

    await db.query(
      `UPDATE openclaw_providers
       SET status = 'disabled'
       WHERE LOWER(COALESCE(name, '')) IN (${nonSmartRouterSql})
          OR LOWER(COALESCE(display_name, '')) LIKE '%火山引擎%'
          OR LOWER(COALESCE(display_name, '')) LIKE '%volcengine%'
          OR LOWER(COALESCE(display_name, '')) LIKE '%huoshan%'
          OR LOWER(COALESCE(display_name, '')) LIKE '%ark%'`
    );

    await db.query(
      `UPDATE openclaw_model_providers mp
       JOIN openclaw_providers p ON p.id = mp.provider_id
       SET mp.status = 'disabled'
       WHERE mp.status = 'active'
         AND (
           LOWER(COALESCE(p.name, '')) IN (${nonSmartRouterSql})
           OR LOWER(COALESCE(p.display_name, '')) LIKE '%火山引擎%'
           OR LOWER(COALESCE(p.display_name, '')) LIKE '%volcengine%'
           OR LOWER(COALESCE(p.display_name, '')) LIKE '%huoshan%'
           OR LOWER(COALESCE(p.display_name, '')) LIKE '%ark%'
         )`
    );

    await db.query(
      `UPDATE openclaw_model_upstreams
       SET status = 'disabled'
       WHERE status = 'active'
         AND (
           LOWER(COALESCE(provider_name, '')) IN (${nonSmartRouterSql})
           OR LOWER(COALESCE(provider_name, '')) LIKE '%火山引擎%'
           OR LOWER(COALESCE(provider_name, '')) LIKE '%volcengine%'
           OR LOWER(COALESCE(provider_name, '')) LIKE '%huoshan%'
           OR LOWER(COALESCE(provider_name, '')) LIKE '%ark%'
         )`
    );

    await db.query(
      `UPDATE openclaw_model_endpoints e
       JOIN openclaw_models m ON m.id = e.model_id
       SET e.status = 'disabled'
       WHERE e.status = 'active'
         AND (
           LOWER(COALESCE(m.provider, '')) IN (${nonSmartRouterSql})
           OR LOWER(COALESCE(m.provider, '')) LIKE '%火山引擎%'
           OR LOWER(COALESCE(m.provider, '')) LIKE '%volcengine%'
           OR LOWER(COALESCE(m.provider, '')) LIKE '%huoshan%'
           OR LOWER(COALESCE(m.provider, '')) LIKE '%ark%'
         )`
    );

    const smartRouterPricing = await getDomesticAveragePricing();
    await db.query(
      `UPDATE openclaw_models
       SET input_price_per_1k = ?,
           output_price_per_1k = ?,
           price_currency = 'CNY',
           per_call_price = NULL,
           model_category = 'smart_route'
       WHERE LOWER(COALESCE(model_id, '')) LIKE '%doubao-smart-router%'
          OR LOWER(COALESCE(provider, '')) LIKE '%doubao-smart-router%'`,
      [smartRouterPricing.input_price_per_1k, smartRouterPricing.output_price_per_1k]
    );
  } catch (e) {
    console.error('[migrate] disable non-smart-router volcengine models:', e.message);
  }

  // 将仍在旧 upstream 表中生效的 CC Club OpenAI 绑定同步到 provider 体系，
  // 避免 /v1/responses 仅依赖新表时拿不到可用端点。
  try {
    const providerName = 'ccclub-openai';
    const providerDisplayName = 'CC Club OpenAI';
    const [legacyCcclubRows] = await db.query(
      `SELECT DISTINCT u.model_id, u.base_url, u.api_key, u.upstream_model_id, u.weight
       FROM openclaw_model_upstreams u
       JOIN openclaw_models m ON m.id = u.model_id
       WHERE u.status = 'active'
         AND m.status = 'active'
         AND u.api_key IS NOT NULL AND u.api_key <> ''
         AND (
           u.provider_name LIKE 'ccclub-openai%'
           OR u.base_url LIKE '%claude-code.club/openai%'
         )`
    );

    if (legacyCcclubRows.length > 0) {
      const primaryBaseUrl = legacyCcclubRows[0].base_url;
      const primaryApiKey = legacyCcclubRows[0].api_key;

      let providerId;
      const [[existingProvider]] = await db.query(
        'SELECT id FROM openclaw_providers WHERE name = ? LIMIT 1',
        [providerName]
      );

      if (existingProvider) {
        providerId = existingProvider.id;
        await db.query(
          `UPDATE openclaw_providers
           SET display_name = ?, base_url = ?, api_key = ?
           WHERE id = ?`,
          [providerDisplayName, primaryBaseUrl, primaryApiKey, providerId]
        );
      } else {
        const [insertProvider] = await db.query(
          `INSERT INTO openclaw_providers
            (name, display_name, base_url, api_key, weight, status, sort_order)
           VALUES (?, ?, ?, ?, 1, 'active', 0)`,
          [providerName, providerDisplayName, primaryBaseUrl, primaryApiKey]
        );
        providerId = insertProvider.insertId;
      }

      for (const row of legacyCcclubRows) {
        const [[existingEndpoint]] = await db.query(
          `SELECT id
           FROM openclaw_provider_endpoints
           WHERE provider_id = ? AND base_url = ? AND api_key = ?
           LIMIT 1`,
          [providerId, row.base_url, row.api_key]
        );

        if (existingEndpoint) {
          await db.query(
            `UPDATE openclaw_provider_endpoints
             SET weight = ?
             WHERE id = ?`,
            [row.weight || 1, existingEndpoint.id]
          );
        } else {
          await db.query(
            `INSERT INTO openclaw_provider_endpoints
              (provider_id, base_url, api_key, weight, status, remark)
             VALUES (?, ?, ?, ?, 'active', 'synced-from-legacy-upstreams')`,
            [providerId, row.base_url, row.api_key, row.weight || 1]
          );
        }

        const [[existingBinding]] = await db.query(
          `SELECT id
           FROM openclaw_model_providers
           WHERE model_id = ? AND provider_id = ?
           LIMIT 1`,
          [row.model_id, providerId]
        );

        if (existingBinding) {
          await db.query(
            `UPDATE openclaw_model_providers
             SET weight = ?, upstream_model_id = ?
             WHERE id = ?`,
            [row.weight || 1, row.upstream_model_id, existingBinding.id]
          );
        } else {
          await db.query(
            `INSERT INTO openclaw_model_providers
              (model_id, provider_id, weight, status, upstream_model_id)
             VALUES (?, ?, ?, 'active', ?)`,
            [row.model_id, providerId, row.weight || 1, row.upstream_model_id]
          );
        }

      }
    }
  } catch (e) {
    console.error('[migrate] ccclub-openai provider sync:', e.message);
  }

  try {
    const [models] = await db.query('SELECT id, model_id, provider, model_category, billing_mode, per_call_price FROM openclaw_models');
    for (const model of models) {
      const currentCategory = normalizeModelCategory(model.model_category);
      const detectedCategory = classifyModelCategory(model.model_id, model.provider);
      const nextCategory = currentCategory === 'language' && detectedCategory !== 'language'
        ? detectedCategory
        : currentCategory;
      const nextBillingMode = model.billing_mode === 'per_call' ? 'per_call' : 'token';
      const nextPerCallPrice = model.per_call_price == null ? null : Number(model.per_call_price);
      await db.query(
        'UPDATE openclaw_models SET model_category = ?, billing_mode = ?, per_call_price = ? WHERE id = ?',
        [nextCategory, nextBillingMode, nextPerCallPrice, model.id]
      );
    }
  } catch (e) {
    console.error('[migrate] model billing/category backfill:', e.message);
  }

  // ── NVIDIA 端点去重：每个 API Key 保留 id 最小的一条，禁用其余 ──────────
  try {
    const [nvidiaEndpoints] = await db.query(`
      SELECT id, api_key
      FROM openclaw_model_upstreams
      WHERE (provider_name = 'nvidia' OR base_url LIKE '%nvidia%')
        AND status = 'active'
      ORDER BY api_key, id ASC
    `);
    if (nvidiaEndpoints.length > 0) {
      const seenKeys = new Set();
      const toDisable = [];
      for (const ep of nvidiaEndpoints) {
        if (seenKeys.has(ep.api_key)) {
          toDisable.push(ep.id);
        } else {
          seenKeys.add(ep.api_key);
        }
      }
      if (toDisable.length > 0) {
        await db.query(
          `UPDATE openclaw_model_upstreams SET status = 'disabled' WHERE id IN (${toDisable.join(',')})`,
        );
        console.log(`[migrate] Disabled ${toDisable.length} duplicate NVIDIA endpoints, kept ${seenKeys.size}`);
      }
    }
  } catch (e) {
    console.error('[migrate] NVIDIA dedup:', e.message);
  }

  // ── OpenClaw 教程表 ──────────────────────────────────────────────────────
  await db.query(`CREATE TABLE IF NOT EXISTS openclaw_tutorials (
    id INT AUTO_INCREMENT PRIMARY KEY,
    slug VARCHAR(200) NOT NULL UNIQUE,
    title VARCHAR(300) NOT NULL,
    category VARCHAR(50) NOT NULL DEFAULT 'general',
    subcategory VARCHAR(100) DEFAULT NULL,
    content MEDIUMTEXT NOT NULL,
    source_url VARCHAR(500) DEFAULT NULL,
    sort_order INT DEFAULT 0,
    status ENUM('active','hidden') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_category (category),
    INDEX idx_status (status),
    FULLTEXT INDEX ft_search (title, content)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});

  await db.query(`CREATE TABLE IF NOT EXISTS openclaw_blog_posts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    summary TEXT,
    content LONGTEXT,
    status ENUM('draft','published') DEFAULT 'draft',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});
};
