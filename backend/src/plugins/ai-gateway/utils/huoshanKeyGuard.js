const crypto = require('crypto');
const nodemailer = require('nodemailer');
const db = require('../../../config/db');
const cache = require('./cache');
const { getSettingCached } = require('../../../routes/quota');
const { parseResetAt } = require('./ccClubKeyGuard');

const LOCK_NAME = 'openclaw_huoshan_key_guard_lock';
const SYNC_INTERVAL_MS = 60 * 1000;
const DEFAULT_ALERT_EMAIL = '2743319061@qq.com';
let timerStarted = false;
let smtpTransporter = null;
let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;
  await db.query(`CREATE TABLE IF NOT EXISTS openclaw_model_endpoints (
    id INT AUTO_INCREMENT PRIMARY KEY,
    model_id INT NOT NULL,
    base_url VARCHAR(500) NOT NULL,
    api_key VARCHAR(500) NOT NULL,
    upstream_model_id VARCHAR(200) DEFAULT NULL,
    upstream_provider VARCHAR(100) DEFAULT NULL,
    weight INT DEFAULT 1,
    status ENUM('active','disabled') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (model_id) REFERENCES openclaw_models(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(() => {});
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
  schemaReady = true;
}

async function getMailer() {
  if (smtpTransporter) return smtpTransporter;
  const host = await getSettingCached('smtp_host', '');
  const port = parseInt(await getSettingCached('smtp_port', '465'), 10);
  const user = await getSettingCached('smtp_user', '');
  const pass = await getSettingCached('smtp_pass', '');
  if (!host || !user || !pass) return null;
  smtpTransporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
  return smtpTransporter;
}

function maskFingerprint(fp = '') {
  if (!fp) return '';
  return `${fp.slice(0, 8)}...${fp.slice(-6)}`;
}

function maskApiKey(key = '') {
  const s = String(key || '');
  if (!s) return '';
  return `${s.slice(0, 8)}...${s.slice(-6)}`;
}

function formatLocalTime(dateObj) {
  if (!dateObj) return '';
  const d = new Date(dateObj);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

async function sendResetMail({ subject, html }) {
  try {
    const to = process.env.ALERT_EMAIL || process.env.ADMIN_EMAIL || DEFAULT_ALERT_EMAIL;
    if (!to) return false;
    const transporter = await getMailer();
    if (!transporter) return false;
    const from = await getSettingCached('smtp_user', '');
    if (!from) return false;
    await transporter.sendMail({ from, to, subject, html });
    return true;
  } catch (e) {
    console.error('[huoshan-key-guard] send mail failed:', e.message);
    return false;
  }
}

function normalizeProviderName(providerName) {
  return String(providerName || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function isSmartRouterProvider(providerName = '') {
  const normalizedProvider = normalizeProviderName(providerName);
  return normalizedProvider === 'doubaosmartrouter'
    || normalizedProvider.includes('doubaosmartrouter');
}

function isHuoshanEndpoint(baseUrl = '', providerName = '') {
  return isSmartRouterProvider(providerName)
    || String(baseUrl || '').toLowerCase().includes('doubao-smart-router');
}

function fingerprintKey(apiKey = '') {
  return crypto.createHash('sha256').update(String(apiKey)).digest('hex');
}

async function withDbLock(fn, waitSeconds = 2) {
  const conn = await db.getConnection();
  try {
    const [[lockRow]] = await conn.query('SELECT GET_LOCK(?, ?) AS l', [LOCK_NAME, waitSeconds]);
    if (!lockRow || Number(lockRow.l) !== 1) return false;
    await fn();
  } finally {
    await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
    conn.release();
  }
  return true;
}

async function applyKeyStateByFingerprint(keyFingerprint, shouldEnable) {
  const nextStatus = shouldEnable ? 'active' : 'disabled';

  await db.query(
    `UPDATE openclaw_model_upstreams
     SET status = ?
     WHERE SHA2(api_key, 256) = ?
       AND (
         LOWER(COALESCE(provider_name, '')) LIKE '%doubao-smart-router%'
         OR LOWER(COALESCE(provider_name, '')) LIKE '%doubao smart router%'
         OR LOWER(COALESCE(provider_name, '')) LIKE '%doubaosmartrouter%'
       )`,
    [nextStatus, keyFingerprint]
  );

  await db.query(
    `UPDATE openclaw_model_endpoints
     SET status = ?
     WHERE SHA2(api_key, 256) = ?
       AND LOWER(COALESCE(upstream_provider, '')) LIKE '%doubao-smart-router%'`,
    [nextStatus, keyFingerprint]
  ).catch(() => {});

  await db.query(
    `UPDATE openclaw_provider_endpoints
     SET status = ?
     WHERE SHA2(api_key, 256) = ?
       AND LOWER(COALESCE(provider_name, '')) LIKE '%doubao-smart-router%'`,
    [nextStatus, keyFingerprint]
  ).catch(() => {});

  await db.query(
    `UPDATE openclaw_providers
     SET status = ?
     WHERE SHA2(api_key, 256) = ?
       AND (
         LOWER(COALESCE(name, '')) LIKE '%doubao-smart-router%'
         OR LOWER(COALESCE(display_name, '')) LIKE '%doubao-smart-router%'
         OR LOWER(COALESCE(name, '')) LIKE '%doubaosmartrouter%'
       )`,
    [nextStatus, keyFingerprint]
  ).catch(() => {});
}

async function refreshHuoshanModelStatus() {
  await db.query(
    `UPDATE openclaw_models m
     SET m.status = CASE
       WHEN EXISTS (
         SELECT 1
         FROM openclaw_model_providers mp
         JOIN openclaw_providers p ON p.id = mp.provider_id
         WHERE mp.model_id = m.id
           AND mp.status = 'active'
           AND p.status = 'active'
           AND (
             LOWER(COALESCE(p.name, '')) LIKE '%doubao-smart-router%'
             OR LOWER(COALESCE(p.name, '')) LIKE '%doubao-smart-router%'
             OR LOWER(COALESCE(p.name, '')) LIKE '%doubaosmartrouter%'
             OR LOWER(COALESCE(p.display_name, '')) LIKE '%doubao-smart-router%'
           )
       )
       OR EXISTS (
         SELECT 1
         FROM openclaw_model_upstreams u
         WHERE u.model_id = m.id
           AND u.status = 'active'
           AND (
             LOWER(COALESCE(u.provider_name, '')) LIKE '%doubao-smart-router%'
             OR LOWER(COALESCE(u.provider_name, '')) LIKE '%doubao smart router%'
             OR LOWER(COALESCE(u.provider_name, '')) LIKE '%doubaosmartrouter%'
           )
       )
       OR EXISTS (
         SELECT 1
         FROM openclaw_model_endpoints e
         WHERE e.model_id = m.id
           AND e.status = 'active'
           AND LOWER(COALESCE(e.upstream_provider, '')) LIKE '%doubao-smart-router%'
       )
       THEN 'active' ELSE 'disabled'
     END
     WHERE LOWER(COALESCE(m.provider, '')) LIKE '%doubao-smart-router%'
        OR EXISTS (
          SELECT 1
          FROM openclaw_model_providers mp
          JOIN openclaw_providers p ON p.id = mp.provider_id
          WHERE mp.model_id = m.id
            AND (
              LOWER(COALESCE(p.name, '')) LIKE '%doubao-smart-router%'
              OR LOWER(COALESCE(p.name, '')) LIKE '%doubaosmartrouter%'
              OR LOWER(COALESCE(p.display_name, '')) LIKE '%doubao-smart-router%'
            )
        )
        OR EXISTS (
          SELECT 1
          FROM openclaw_model_upstreams u
         WHERE u.model_id = m.id
            AND (
              LOWER(COALESCE(u.provider_name, '')) LIKE '%doubao-smart-router%'
              OR LOWER(COALESCE(u.provider_name, '')) LIKE '%doubao smart router%'
              OR LOWER(COALESCE(u.provider_name, '')) LIKE '%doubaosmartrouter%'
            )
        )
        OR EXISTS (
          SELECT 1
          FROM openclaw_model_endpoints e
          WHERE e.model_id = m.id
            AND LOWER(COALESCE(e.upstream_provider, '')) LIKE '%doubao-smart-router%'
        )`
  );
}

async function clearGatewayCache() {
  await cache.delByPrefix('model:');
  await cache.delByPrefix('upstreams:');
  await cache.delByPrefix('provider-endpoints:');
}

async function syncHuoshanKeyStates() {
  await ensureSchema();
  await withDbLock(async () => {
    const [rows] = await db.query(
      `SELECT r.key_fingerprint, r.provider_name, r.base_url, r.reset_at, r.recovered_notified_at,
              (
                SELECT u.api_key
                FROM openclaw_model_upstreams u
                WHERE SHA2(u.api_key, 256) = r.key_fingerprint
                LIMIT 1
              ) AS api_key
       FROM openclaw_huoshan_key_resets r
       WHERE r.status = 'cooldown'`
    );

    if (!rows.length) return;

    const now = Date.now();
    for (const row of rows) {
      const resetAt = row.reset_at ? new Date(row.reset_at).getTime() : 0;
      const shouldEnable = resetAt > 0 && resetAt <= now;
      await applyKeyStateByFingerprint(row.key_fingerprint, shouldEnable);

      await db.query(
        `UPDATE openclaw_huoshan_key_resets
         SET status = ?,
             recovered_notified_at = CASE
               WHEN ? = 1 AND recovered_notified_at IS NULL THEN NOW()
               ELSE recovered_notified_at
             END,
             updated_at = NOW()
         WHERE key_fingerprint = ?`,
        [shouldEnable ? 'ready' : 'cooldown', shouldEnable ? 1 : 0, row.key_fingerprint]
      );

      if (shouldEnable && !row.recovered_notified_at) {
        await sendResetMail({
          subject: `【火山引擎 Key恢复】${row.provider_name || 'huoshan'} 已到重置时间`,
          html: `<div style="font-family:sans-serif;line-height:1.8;">
<h3>火山引擎 Key 已自动恢复启用</h3>
<p><b>Provider:</b> ${row.provider_name || '-'}</p>
<p><b>Base URL:</b> ${row.base_url || '-'}</p>
<p><b>Key 预览:</b> <code>${row.api_key ? maskApiKey(row.api_key) : maskFingerprint(row.key_fingerprint)}</code></p>
<p><b>重置时间(Asia/Shanghai):</b> ${formatLocalTime(row.reset_at)}</p>
<p><b>恢复时间(Asia/Shanghai):</b> ${formatLocalTime(new Date())}</p>
</div>`
        });
      }
    }

    await refreshHuoshanModelStatus();
    await clearGatewayCache();
  }, 0);
}

async function noteHuoshanRateLimit({ providerName, baseUrl, apiKey, errorMessage, statusCode, source = 'chat' }) {
  await ensureSchema();
  if (!isHuoshanEndpoint(baseUrl, providerName)) return;
  if (!apiKey) return;

  const resetAt = parseResetAt(errorMessage);
  if (!resetAt) return;

  const fp = fingerprintKey(apiKey);

  await withDbLock(async () => {
    const [[before]] = await db.query(
      `SELECT reset_at FROM openclaw_huoshan_key_resets WHERE key_fingerprint = ?`,
      [fp]
    );
    const beforeTs = before?.reset_at ? new Date(before.reset_at).getTime() : 0;
    const nowTs = new Date(resetAt).getTime();
    const shouldNotifyCooldown = !beforeTs || beforeTs !== nowTs;

    await db.query(
      `INSERT INTO openclaw_huoshan_key_resets
       (key_fingerprint, provider_name, base_url, reset_at, status, last_status_code, last_error_message, last_seen_at, cooldown_notified_at)
       VALUES (?, ?, ?, ?, 'cooldown', ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         provider_name = VALUES(provider_name),
         base_url = VALUES(base_url),
         reset_at = VALUES(reset_at),
         status = 'cooldown',
         last_status_code = VALUES(last_status_code),
         last_error_message = VALUES(last_error_message),
         last_seen_at = NOW(),
         cooldown_notified_at = CASE
           WHEN reset_at <> VALUES(reset_at) THEN NOW()
           WHEN cooldown_notified_at IS NULL THEN NOW()
           ELSE cooldown_notified_at
         END,
         recovered_notified_at = NULL,
         updated_at = NOW()`,
      [fp, providerName || '', baseUrl || '', resetAt, statusCode || 429, `${source}: ${String(errorMessage || '').slice(0, 1000)}`]
    );

    await applyKeyStateByFingerprint(fp, false);
    await refreshHuoshanModelStatus();
    await clearGatewayCache();

    if (shouldNotifyCooldown) {
      await sendResetMail({
        subject: `【火山引擎 Key冷却】${providerName || 'huoshan'} 已记录重置时间`,
        html: `<div style="font-family:sans-serif;line-height:1.8;">
<h3>火山引擎 Key 进入冷却期</h3>
<p><b>Provider:</b> ${providerName || '-'}</p>
<p><b>Base URL:</b> ${baseUrl || '-'}</p>
<p><b>Key 预览:</b> <code>${maskApiKey(apiKey)}</code></p>
<p><b>预计恢复时间(Asia/Shanghai):</b> ${formatLocalTime(resetAt)}</p>
<p><b>记录时间(Asia/Shanghai):</b> ${formatLocalTime(new Date())}</p>
</div>`
      });
    }
  }, 2);
}

function startHuoshanKeyGuard() {
  if (timerStarted) return;
  timerStarted = true;

  syncHuoshanKeyStates().catch((e) => {
    console.error('[huoshan-key-guard] initial sync failed:', e.message);
  });

  setInterval(() => {
    syncHuoshanKeyStates().catch((e) => {
      console.error('[huoshan-key-guard] periodic sync failed:', e.message);
    });
  }, SYNC_INTERVAL_MS);
}

module.exports = {
  ensureSchema,
  noteHuoshanRateLimit,
  syncHuoshanKeyStates,
  startHuoshanKeyGuard,
  parseResetAt,
  isHuoshanEndpoint,
};
