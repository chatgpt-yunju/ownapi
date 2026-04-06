const crypto = require('crypto');
const nodemailer = require('nodemailer');
const db = require('../../../config/db');
const cache = require('./cache');
const { getSettingCached } = require('../../../routes/quota');

const LOCK_NAME = 'openclaw_ccclub_key_guard_lock';
const SYNC_INTERVAL_MS = 60 * 1000;
const DEFAULT_ALERT_EMAIL = '2743319061@qq.com';
let timerStarted = false;
let smtpTransporter = null;
let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;
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
  // 保留 cr_ 前缀后最多8个字符，末尾保留6个字符
  const prefix = s.startsWith('cr_') ? 'cr_' : '';
  const rest = s.startsWith('cr_') ? s.slice(3) : s;
  return `${prefix}${rest.slice(0, 8)}...${rest.slice(-6)}`;
}

async function fetchCcClubKeyNotes(apiKey) {
  try {
    const [[row]] = await db.query(
      'SELECT notes FROM openclaw_ccclub_keys WHERE api_key = ? LIMIT 1',
      [apiKey]
    );
    return row?.notes || '';
  } catch {
    return '';
  }
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
    console.error('[ccclub-key-guard] send mail failed:', e.message);
    return false;
  }
}

function isCcClubEndpoint(baseUrl = '', providerName = '') {
  return String(baseUrl).includes('claude-code.club') || String(providerName).startsWith('ccclub');
}

function parseResetAt(errorMessage = '') {
  const msg = String(errorMessage || '');
  // 例：将在 9626 分钟后重置
  const zhMatch = msg.match(/将[在于]?\s*(\d+)\s*分钟后重置/);
  if (zhMatch) {
    const minutes = Number(zhMatch[1]);
    if (Number.isFinite(minutes) && minutes > 0) {
      return new Date(Date.now() + minutes * 60 * 1000);
    }
  }

  // 例：reset in 120 minutes
  const enMatch = msg.match(/reset\s+in\s+(\d+)\s*minutes?/i);
  if (enMatch) {
    const minutes = Number(enMatch[1]);
    if (Number.isFinite(minutes) && minutes > 0) {
      return new Date(Date.now() + minutes * 60 * 1000);
    }
  }

  return null;
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
     WHERE base_url LIKE '%claude-code.club%'
       AND SHA2(api_key, 256) = ?`,
    [nextStatus, keyFingerprint]
  );

  await db.query(
    `UPDATE openclaw_provider_endpoints
     SET status = ?
     WHERE base_url LIKE '%claude-code.club%'
       AND SHA2(api_key, 256) = ?`,
    [nextStatus, keyFingerprint]
  ).catch(() => {});

  await db.query(
    `UPDATE openclaw_providers
     SET status = ?
     WHERE base_url LIKE '%claude-code.club%'
       AND SHA2(api_key, 256) = ?`,
    [nextStatus, keyFingerprint]
  ).catch(() => {});
}

async function refreshCcClubModelStatus() {
  await db.query(
    `UPDATE openclaw_models m
     LEFT JOIN (
       SELECT model_id, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_cnt
       FROM openclaw_model_upstreams
       WHERE base_url LIKE '%claude-code.club%'
       GROUP BY model_id
     ) u ON u.model_id = m.id
     SET m.status = CASE WHEN COALESCE(u.active_cnt, 0) > 0 THEN 'active' ELSE 'disabled' END
     WHERE m.provider LIKE 'ccclub%' OR u.model_id IS NOT NULL`
  );
}

async function clearGatewayCache() {
  await cache.delByPrefix('model:');
  await cache.delByPrefix('upstreams:');
  await cache.delByPrefix('provider-endpoints:');
}

async function syncCcClubKeyStates() {
  await ensureSchema();
  await withDbLock(async () => {
    const [rows] = await db.query(
      `SELECT r.key_fingerprint, r.provider_name, r.base_url, r.reset_at, r.recovered_notified_at,
              k.api_key, k.notes
       FROM openclaw_ccclub_key_resets r
       LEFT JOIN openclaw_ccclub_keys k ON SHA2(k.api_key, 256) = r.key_fingerprint
       WHERE r.status = 'cooldown'`
    );

    if (!rows.length) return;

    const now = Date.now();
    for (const row of rows) {
      const resetAt = row.reset_at ? new Date(row.reset_at).getTime() : 0;
      const shouldEnable = resetAt > 0 && resetAt <= now;
      await applyKeyStateByFingerprint(row.key_fingerprint, shouldEnable);

      await db.query(
        `UPDATE openclaw_ccclub_key_resets
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
        const keyNotes = row.notes || '';
        await sendResetMail({
          subject: `【CC Club Key恢复】${row.provider_name || 'ccclub'}${keyNotes ? ' · ' + keyNotes : ''} 已到重置时间`,
          html: `<div style="font-family:sans-serif;line-height:1.8;">
<h3>CC Club Key 已自动恢复启用</h3>
<p><b>Provider:</b> ${row.provider_name || '-'}</p>
<p><b>Base URL:</b> ${row.base_url || '-'}</p>
<p><b>Key 预览:</b> <code>${row.api_key ? maskApiKey(row.api_key) : maskFingerprint(row.key_fingerprint)}</code></p>
<p><b>备注:</b> ${keyNotes || '-'}</p>
<p><b>重置时间(Asia/Shanghai):</b> ${formatLocalTime(row.reset_at)}</p>
<p><b>恢复时间(Asia/Shanghai):</b> ${formatLocalTime(new Date())}</p>
</div>`
        });
      }
    }

    await refreshCcClubModelStatus();
    await clearGatewayCache();
  }, 0);
}

async function noteCcClubRateLimit({ providerName, baseUrl, apiKey, errorMessage, statusCode, source = 'chat' }) {
  await ensureSchema();
  if (!isCcClubEndpoint(baseUrl, providerName)) return;
  if (!apiKey) return;

  const resetAt = parseResetAt(errorMessage);
  if (!resetAt) return;

  const fp = fingerprintKey(apiKey);

  await withDbLock(async () => {
    const [[before]] = await db.query(
      `SELECT reset_at FROM openclaw_ccclub_key_resets WHERE key_fingerprint = ?`,
      [fp]
    );
    const beforeTs = before?.reset_at ? new Date(before.reset_at).getTime() : 0;
    const nowTs = new Date(resetAt).getTime();
    const shouldNotifyCooldown = !beforeTs || beforeTs !== nowTs;

    await db.query(
      `INSERT INTO openclaw_ccclub_key_resets
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
    await refreshCcClubModelStatus();
    await clearGatewayCache();

    if (shouldNotifyCooldown) {
      const keyNotes = await fetchCcClubKeyNotes(apiKey);
      await sendResetMail({
        subject: `【CC Club Key冷却】${providerName || 'ccclub'}${keyNotes ? ' · ' + keyNotes : ''} 已记录重置时间`,
        html: `<div style="font-family:sans-serif;line-height:1.8;">
<h3>CC Club Key 进入冷却期</h3>
<p><b>Provider:</b> ${providerName || '-'}</p>
<p><b>Base URL:</b> ${baseUrl || '-'}</p>
<p><b>Key 预览:</b> <code>${maskApiKey(apiKey)}</code></p>
<p><b>备注:</b> ${keyNotes || '-'}</p>
<p><b>预计恢复时间(Asia/Shanghai):</b> ${formatLocalTime(resetAt)}</p>
<p><b>记录时间(Asia/Shanghai):</b> ${formatLocalTime(new Date())}</p>
</div>`
      });
    }
  }, 2);
}

function startCcClubKeyGuard() {
  if (timerStarted) return;
  timerStarted = true;

  // 启动立即执行一次，随后每分钟执行一次
  syncCcClubKeyStates().catch((e) => {
    console.error('[ccclub-key-guard] initial sync failed:', e.message);
  });

  setInterval(() => {
    syncCcClubKeyStates().catch((e) => {
      console.error('[ccclub-key-guard] periodic sync failed:', e.message);
    });
  }, SYNC_INTERVAL_MS);
}

module.exports = {
  noteCcClubRateLimit,
  syncCcClubKeyStates,
  startCcClubKeyGuard,
  parseResetAt
};
