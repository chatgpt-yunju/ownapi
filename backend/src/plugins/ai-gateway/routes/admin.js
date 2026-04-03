const router = require('express').Router();
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const db = require('../../../config/db');
const { adminOnly } = require('../middleware/auth');
const cache = require('../utils/cache');
const { getSettingCached } = require('../../../routes/quota');
const { getQueueStats } = require('../middleware/requestQueue');
const {
  adjustBalance,
  normalizeBillingMode,
  normalizeModelCategory,
  roundAmount,
} = require('../utils/billing');

// 运行时迁移：CC Club 密钥注册表（含备注）
db.query(`
  CREATE TABLE IF NOT EXISTS openclaw_ccclub_keys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    api_key VARCHAR(500) NOT NULL UNIQUE,
    notes VARCHAR(255) DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`).catch(() => {});
db.query(`ALTER TABLE openclaw_ccclub_keys ADD COLUMN status ENUM('active','disabled') DEFAULT 'active'`).catch(() => {});

// 运行时迁移：创建模型直连端点表
db.query(`
  CREATE TABLE IF NOT EXISTS openclaw_model_endpoints (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`).catch(() => {});

db.query(`
  CREATE TABLE IF NOT EXISTS openclaw_app_market (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    description TEXT NOT NULL,
    url VARCHAR(2048) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`).catch(() => {});

router.use(adminOnly);

let smtpTransporter = null;
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

function escapeHtml(input = '') {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nl2brHtml(input = '') {
  return escapeHtml(input).replace(/\r?\n/g, '<br>');
}

function trimForLog(input, max = 1200) {
  const s = typeof input === 'string' ? input : JSON.stringify(input || '');
  return s.length > max ? `${s.slice(0, max)} ...[truncated]` : s;
}

async function runHttpJsonTest({ url, headers, body, timeoutMs = 45000 }) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body || {}),
      signal: controller.signal
    });
    const durationMs = Date.now() - startedAt;
    const raw = await resp.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (_) {}
    const preview = parsed
      ? trimForLog(parsed.output_text || parsed.content || parsed.error || parsed, 1200)
      : trimForLog(raw || '', 1200);
    return {
      ok: resp.ok,
      status: resp.status,
      duration_ms: durationMs,
      error: resp.ok ? null : preview,
      response_preview: preview
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    return {
      ok: false,
      status: 0,
      duration_ms: durationMs,
      error: err?.name === 'AbortError'
        ? `请求超时（>${timeoutMs}ms）`
        : (err?.message || '请求异常'),
      response_preview: null
    };
  } finally {
    clearTimeout(timer);
  }
}

async function clearGatewayModelCache({ modelIds = [], modelKeys = [] } = {}) {
  if (!Array.isArray(modelIds) || !Array.isArray(modelKeys)) {
    await cache.delByPrefix('model:');
    await cache.delByPrefix('upstreams:');
    await cache.delByPrefix('provider-endpoints:');
    return;
  }

  for (const key of modelKeys) {
    if (!key) continue;
    await cache.del(`model:${key}`);
  }
  for (const id of modelIds) {
    if (!id) continue;
    await cache.del(`upstreams:${id}`);
    await cache.del(`provider-endpoints:${id}`);
  }
}

function parseDetailJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

async function getRequestDebugTraceDetail(requestId) {
  const [steps] = await db.query(
    `SELECT id, trace_type, route_name, request_path, model, user_id, api_key_id, step_no, step_key, step_name,
            status, duration_ms, attempt_no, upstream_id, upstream_provider, upstream_base_url,
            error_message, detail_json, created_at
     FROM openclaw_request_debug_logs
     WHERE request_id = ?
     ORDER BY id ASC`,
    [requestId]
  );

  const [[callLog]] = await db.query(
    `SELECT l.*, u.username,
            r.user_prompt, r.messages, r.system_prompt, r.response_content
     FROM openclaw_call_logs l
     LEFT JOIN users u ON u.id = l.user_id
     LEFT JOIN openclaw_request_logs r ON r.request_id = l.request_id
     WHERE l.request_id = ?
     LIMIT 1`,
    [requestId]
  );

  const summary = callLog || (steps[0] ? {
    request_id: requestId,
    model: steps[0].model,
    user_id: steps[0].user_id,
    api_key_id: steps[0].api_key_id,
    created_at: steps[0].created_at,
    status: steps.some(step => step.status === 'error') ? 'error' : 'success',
    route_name: steps[0].route_name,
  } : null);

  return {
    request_id: requestId,
    summary,
    steps: steps.map(step => ({
      ...step,
      detail: parseDetailJson(step.detail_json),
    })),
  };
}

function buildManualDebugRelayRequest({ route_type, model, prompt, system, temperature, max_tokens }) {
  const normalizedPrompt = String(prompt || '请回复：pong').slice(0, 5000);
  const normalizedSystem = String(system || '').slice(0, 2000);
  const timeoutMaxTokens = Number(max_tokens) > 0 ? Number(max_tokens) : 256;
  const baseUrl = `http://127.0.0.1:${process.env.PORT || 3000}`;

  if (route_type === 'messages') {
    return {
      url: `${baseUrl}/v1/messages`,
      body: {
        model,
        system: normalizedSystem || undefined,
        messages: [{ role: 'user', content: normalizedPrompt }],
        max_tokens: timeoutMaxTokens,
        temperature,
        stream: false,
      }
    };
  }

  if (route_type === 'responses') {
    return {
      url: `${baseUrl}/v1/responses`,
      body: {
        model,
        input: normalizedPrompt,
        instructions: normalizedSystem || undefined,
        max_output_tokens: timeoutMaxTokens,
        temperature,
        stream: false,
      }
    };
  }

  if (route_type === 'gemini') {
    return {
      url: `${baseUrl}/v1beta/models/${model}:generateContent`,
      body: {
        contents: [{ role: 'user', parts: [{ text: normalizedPrompt }] }],
        systemInstruction: normalizedSystem ? { parts: [{ text: normalizedSystem }] } : undefined,
        generationConfig: {
          temperature,
          maxOutputTokens: timeoutMaxTokens,
        }
      }
    };
  }

  return {
    url: `${baseUrl}/v1/chat/completions`,
    body: {
      model,
      messages: [
        ...(normalizedSystem ? [{ role: 'system', content: normalizedSystem }] : []),
        { role: 'user', content: normalizedPrompt }
      ],
      max_tokens: timeoutMaxTokens,
      temperature,
      stream: false,
    }
  };
}

async function runRelayDebugRequest({ route_type, model, relay_api_key, prompt, system, temperature, max_tokens, timeout_ms }) {
  const { url, body } = buildManualDebugRelayRequest({ route_type, model, prompt, system, temperature, max_tokens });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);
  const startedAt = Date.now();
  let response;
  let raw = '';
  let parsed = null;
  let requestId = null;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${relay_api_key}`,
        'X-Debug-Trace-Type': 'manual',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    requestId = response.headers.get('x-request-id');
    raw = await response.text();
    try { parsed = raw ? JSON.parse(raw) : null; } catch { /* keep raw */ }
    return {
      ok: response.ok,
      status: response.status,
      duration_ms: Date.now() - startedAt,
      request_id: requestId,
      response_preview: trimForLog(parsed || raw || '', 2000),
      error: response.ok ? null : trimForLog(parsed?.error?.message || parsed?.message || raw || '请求失败', 1200),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      duration_ms: Date.now() - startedAt,
      request_id: requestId,
      response_preview: null,
      error: err?.name === 'AbortError'
        ? `请求超时（>${timeout_ms}ms）`
        : (err?.message || '请求异常'),
    };
  } finally {
    clearTimeout(timer);
  }
}

// 数据看板
router.get('/overview', async (req, res) => {
  try {
    const [[users]] = await db.query('SELECT COUNT(*) as total FROM users');
    const [[apiKeys]] = await db.query('SELECT COUNT(*) as total FROM openclaw_api_keys WHERE status = "active" AND is_deleted = 0');
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
    const [[queuePeak]] = await db.query(
      `SELECT
         COALESCE(MAX(CAST(JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.waiting_count')) AS UNSIGNED)),0) AS peak_waiting,
         COALESCE(MAX(CAST(JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.active_count'))  AS UNSIGNED)),0) AS peak_active
       FROM openclaw_request_debug_logs
       WHERE step_name='请求排队' AND DATE(created_at)=CURDATE()`
    );
    const liveQueue = getQueueStats();

    res.json({
      total_users: users.total,
      total_calls: Number(totalStats.calls),
      total_tokens: Number(totalStats.tokens),
      total_cost: Number(totalStats.cost),
      today_calls: Number(todayStats.calls),
      today_cost: Number(todayStats.cost),
      today_tokens: Number(todayStats.tokens),
      active_keys: apiKeys.total,
      recent_logs: recentLogs,
      queue: {
        peak_waiting_today: Number(queuePeak.peak_waiting),
        peak_active_today:  Number(queuePeak.peak_active),
        active_now:         liveQueue.activeCount,
        waiting_now:        liveQueue.waitingCount,
        max_concurrent:     liveQueue.maxConcurrent,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取概览失败' });
  }
});

// 自定义时间段统计
router.get('/stats/range', adminOnly, async (req, res) => {
  const { start, end, model, user_id, api_key_id } = req.query;
  if (!start || !end) return res.status(400).json({ error: '缺少 start / end 参数' });
  const s = new Date(start), e = new Date(end);
  if (isNaN(s) || isNaN(e) || s >= e) return res.status(400).json({ error: '时间范围无效' });

  try {
    const where = ['l.created_at >= ?', 'l.created_at <= ?'];
    const params = [s, e];
    if (model) {
      where.push('l.model = ?');
      params.push(String(model).trim());
    }
    if (user_id) {
      const userIdNum = Number(user_id);
      if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
        return res.status(400).json({ error: 'user_id 无效' });
      }
      where.push('l.user_id = ?');
      params.push(userIdNum);
    }
    if (api_key_id) {
      const apiKeyIdNum = Number(api_key_id);
      if (!Number.isInteger(apiKeyIdNum) || apiKeyIdNum <= 0) {
        return res.status(400).json({ error: 'api_key_id 无效' });
      }
      where.push('l.api_key_id = ?');
      params.push(apiKeyIdNum);
    }
    const [rows] = await db.query(
      `SELECT u.username, l.user_id,
         COUNT(*)                                          AS calls,
         COALESCE(SUM(l.prompt_tokens),0)                 AS input_tokens,
         COALESCE(SUM(l.completion_tokens),0)             AS output_tokens,
         COALESCE(SUM(l.prompt_tokens+l.completion_tokens),0) AS total_tokens,
         COALESCE(SUM(l.total_cost),0)                    AS cost_usd
       FROM openclaw_call_logs l
       LEFT JOIN users u ON u.id = l.user_id
       WHERE ${where.join(' AND ')}
       GROUP BY l.user_id, u.username
       ORDER BY cost_usd DESC`,
      params
    );
    const total = rows.reduce((acc, r) => ({
      calls:        acc.calls        + Number(r.calls),
      input_tokens: acc.input_tokens + Number(r.input_tokens),
      output_tokens:acc.output_tokens+ Number(r.output_tokens),
      total_tokens: acc.total_tokens + Number(r.total_tokens),
      cost_usd:     acc.cost_usd     + Number(r.cost_usd),
    }), { calls:0, input_tokens:0, output_tokens:0, total_tokens:0, cost_usd:0 });
    res.json({ users: rows, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '查询失败' });
  }
});

router.get('/stats/range/options', async (_req, res) => {
  try {
    const [models, users, apiKeys] = await Promise.all([
      db.query(
        `SELECT DISTINCT model
         FROM openclaw_call_logs
         WHERE model IS NOT NULL AND model != ''
         ORDER BY model ASC`
      ),
      db.query(
        `SELECT DISTINCT l.user_id AS id, u.username
         FROM openclaw_call_logs l
         JOIN users u ON u.id = l.user_id
         WHERE l.user_id IS NOT NULL
         ORDER BY u.username ASC, l.user_id ASC`
      ),
      db.query(
        `SELECT DISTINCT k.id, k.key_display, k.user_id, u.username
         FROM openclaw_call_logs l
         JOIN openclaw_api_keys k ON k.id = l.api_key_id
         LEFT JOIN users u ON u.id = k.user_id
         WHERE l.api_key_id IS NOT NULL
         ORDER BY k.id DESC`
      ),
    ]);

    res.json({
      models: (models[0] || []).map(row => ({ value: row.model, label: row.model })),
      users: (users[0] || []).map(row => ({
        id: row.id,
        username: row.username || `用户 ${row.id}`,
      })),
      api_keys: (apiKeys[0] || []).map(row => ({
        id: row.id,
        key_display: row.key_display,
        user_id: row.user_id,
        username: row.username || `用户 ${row.user_id}`,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取统计筛选选项失败' });
  }
});

function normalizeAppMarketPayload(body = {}) {
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim();
  const url = String(body.url || '').trim();
  return { name, description, url };
}

function validateAppMarketPayload({ name, description, url }) {
  if (!name || !description || !url) return '请填写名称、描述和 URL';
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'URL 仅支持 http/https';
  } catch {
    return '请输入有效的 URL';
  }
  return null;
}

router.get('/app-market', async (_req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, description, url, created_at, updated_at FROM openclaw_app_market ORDER BY id DESC'
    );
    res.json({ apps: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取应用市场列表失败' });
  }
});

router.post('/app-market', async (req, res) => {
  const payload = normalizeAppMarketPayload(req.body);
  const validationError = validateAppMarketPayload(payload);
  if (validationError) return res.status(400).json({ error: validationError });

  try {
    const [result] = await db.query(
      'INSERT INTO openclaw_app_market (name, description, url) VALUES (?, ?, ?)',
      [payload.name, payload.description, payload.url]
    );
    res.json({ id: result.insertId, message: '应用已添加' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '添加应用失败' });
  }
});

router.put('/app-market/:id', async (req, res) => {
  const payload = normalizeAppMarketPayload(req.body);
  const validationError = validateAppMarketPayload(payload);
  if (validationError) return res.status(400).json({ error: validationError });

  try {
    const [result] = await db.query(
      'UPDATE openclaw_app_market SET name = ?, description = ?, url = ? WHERE id = ?',
      [payload.name, payload.description, payload.url, Number(req.params.id)]
    );
    if (!result.affectedRows) return res.status(404).json({ error: '应用不存在' });
    res.json({ message: '应用已更新' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '更新应用失败' });
  }
});

router.delete('/app-market/:id', async (req, res) => {
  try {
    const [result] = await db.query(
      'DELETE FROM openclaw_app_market WHERE id = ?',
      [Number(req.params.id)]
    );
    if (!result.affectedRows) return res.status(404).json({ error: '应用不存在' });
    res.json({ message: '应用已删除' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '删除应用失败' });
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
      where = '(u.username LIKE ? OR u.email LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM users u WHERE ${where}`, params);
    const [users] = await db.query(
      `SELECT u.id as user_id, u.username, u.email, u.role, u.status, u.created_at,
              COALESCE(q.balance, 0) as quota_balance,
              COALESCE(w.balance, 0) as wallet_balance,
       (SELECT COUNT(*) FROM openclaw_api_keys k WHERE k.user_id = u.id AND k.status = 'active') as key_count,
       (SELECT COUNT(*) FROM openclaw_call_logs l WHERE l.user_id = u.id) as total_calls,
       (SELECT COALESCE(SUM(l.total_cost),0) FROM openclaw_call_logs l WHERE l.user_id = u.id) as total_cost
       FROM users u
       LEFT JOIN openclaw_quota q ON u.id = q.user_id
       LEFT JOIN openclaw_wallet w ON u.id = w.user_id
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
  const { user_id, amount, description, remark, balance_type } = req.body;
  const note = description || remark || '管理员操作';
  const balanceType = balance_type === 'quota' ? 'quota' : 'wallet';
  if (!user_id || !amount) return res.status(400).json({ error: '缺少参数' });

  try {
    const result = await adjustBalance(
      user_id,
      balanceType,
      Number(amount),
      Number(amount) >= 0 ? 'admin_credit' : 'admin_debit',
      note,
      { source: 'admin', balance_type: balanceType }
    );
    if (!result.success) {
      return res.status(400).json({ error: '余额不足' });
    }

    res.json({ message: `操作成功，${balanceType === 'wallet' ? '钱包' : '配额'}变动 ${roundAmount(amount)}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '操作失败: ' + err.message });
  }
});

// 模型管理 - 列表
router.get('/models', async (req, res) => {
  try {
    const [models] = await db.query('SELECT * FROM openclaw_models ORDER BY sort_order');
    const [allUpstreams] = await db.query('SELECT * FROM openclaw_model_upstreams ORDER BY model_id, sort_order, id');
    const upstreamMap = {};
    for (const u of allUpstreams) {
      if (!upstreamMap[u.model_id]) upstreamMap[u.model_id] = [];
      upstreamMap[u.model_id].push(u);
    }
    for (const m of models) {
      m.upstreams = upstreamMap[m.id] || [];
    }
    res.json(models);
  } catch (err) {
    res.status(500).json({ error: '获取模型失败' });
  }
});

// 模型管理 - 新增（含 upstreams）
router.post('/models', async (req, res) => {
  const {
    model_id, display_name, provider, input_price_per_1k, output_price_per_1k,
    price_currency, sort_order, upstream_model_id, upstream_endpoint, upstream_key,
    upstreams, model_category, billing_mode, per_call_price,
  } = req.body;
  try {
    const [result] = await db.query(
      `INSERT INTO openclaw_models
        (model_id, display_name, provider, input_price_per_1k, output_price_per_1k, price_currency,
         sort_order, upstream_model_id, upstream_endpoint, upstream_key, model_category, billing_mode, per_call_price)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        model_id,
        display_name,
        provider,
        input_price_per_1k,
        output_price_per_1k,
        price_currency || 'CNY',
        sort_order || 0,
        upstream_model_id || null,
        upstream_endpoint || null,
        upstream_key || null,
        normalizeModelCategory(model_category),
        normalizeBillingMode(billing_mode),
        per_call_price == null || per_call_price === '' ? null : roundAmount(per_call_price),
      ]
    );
    const newModelId = result.insertId;
    if (Array.isArray(upstreams)) {
      for (let i = 0; i < upstreams.length; i++) {
        const u = upstreams[i];
        if (!u.base_url || !u.api_key) continue;
        await db.query(
          'INSERT INTO openclaw_model_upstreams (model_id, provider_name, base_url, api_key, upstream_model_id, weight, status, sort_order) VALUES (?,?,?,?,?,?,?,?)',
          [newModelId, u.provider_name || '', u.base_url, u.api_key, u.upstream_model_id || null, u.weight || 1, 'active', i]
        );
      }
    }
    await clearGatewayModelCache({ modelIds: [newModelId], modelKeys: [model_id] });
    res.json({ message: '已添加' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '添加失败' });
  }
});

// 模型管理 - 更新（含 upstreams 同步）
router.put('/models/:id', async (req, res) => {
  const {
    display_name, provider, input_price_per_1k, output_price_per_1k, price_currency,
    sort_order, status, upstream_model_id, upstream_endpoint, upstream_key, upstreams,
    model_category, billing_mode, per_call_price,
  } = req.body;
  const modelId = req.params.id;
  try {
    await db.query(
      `UPDATE openclaw_models
       SET display_name=?, provider=?, input_price_per_1k=?, output_price_per_1k=?, price_currency=?,
           sort_order=?, status=?, upstream_model_id=?, upstream_endpoint=?, upstream_key=?,
           model_category=?, billing_mode=?, per_call_price=?
       WHERE id=?`,
      [
        display_name,
        provider,
        input_price_per_1k,
        output_price_per_1k,
        price_currency || 'CNY',
        sort_order || 0,
        status,
        upstream_model_id || null,
        upstream_endpoint || null,
        upstream_key || null,
        normalizeModelCategory(model_category),
        normalizeBillingMode(billing_mode),
        per_call_price == null || per_call_price === '' ? null : roundAmount(per_call_price),
        modelId,
      ]
    );
    if (Array.isArray(upstreams)) {
      await db.query('UPDATE openclaw_model_upstreams SET status="disabled" WHERE model_id=?', [modelId]);
      for (let i = 0; i < upstreams.length; i++) {
        const u = upstreams[i];
        if (!u.base_url || !u.api_key) continue;
        if (u.id) {
          await db.query(
            'UPDATE openclaw_model_upstreams SET provider_name=?, base_url=?, api_key=?, upstream_model_id=?, weight=?, status="active", sort_order=? WHERE id=?',
            [u.provider_name || '', u.base_url, u.api_key, u.upstream_model_id || null, u.weight || 1, i, u.id]
          );
        } else {
          await db.query(
            'INSERT INTO openclaw_model_upstreams (model_id, provider_name, base_url, api_key, upstream_model_id, weight, status, sort_order) VALUES (?,?,?,?,?,?,?,?)',
            [modelId, u.provider_name || '', u.base_url, u.api_key, u.upstream_model_id || null, u.weight || 1, 'active', i]
          );
        }
      }
    }
    const [[currentModel]] = await db.query('SELECT model_id FROM openclaw_models WHERE id=? LIMIT 1', [modelId]);
    await clearGatewayModelCache({ modelIds: [Number(modelId)], modelKeys: [currentModel?.model_id] });
    res.json({ message: '已更新' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '更新失败' });
  }
});

// 模型管理 - 删除（软删除，设为 disabled）
router.delete('/models/:id', async (req, res) => {
  try {
    const [[currentModel]] = await db.query('SELECT model_id FROM openclaw_models WHERE id=? LIMIT 1', [req.params.id]);
    await db.query('UPDATE openclaw_models SET status="disabled" WHERE id=?', [req.params.id]);
    await clearGatewayModelCache({ modelIds: [Number(req.params.id)], modelKeys: [currentModel?.model_id] });
    res.json({ message: '已禁用' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '操作失败' });
  }
});

// 供应商管理 - 列表（含端点）
router.get('/providers', async (req, res) => {
  try {
    const [providers] = await db.query('SELECT * FROM openclaw_providers ORDER BY sort_order');
    for (const p of providers) {
      const [endpoints] = await db.query(
        'SELECT * FROM openclaw_provider_endpoints WHERE provider_id = ? AND status = "active" ORDER BY id',
        [p.id]
      );
      p.endpoints = endpoints;
    }
    res.json(providers);
  } catch (err) {
    res.status(500).json({ error: '获取供应商失败' });
  }
});

// 供应商管理 - 新增（含端点）
router.post('/providers', async (req, res) => {
  const { name, display_name, status, sort_order, endpoints } = req.body;
  try {
    const [result] = await db.query(
      'INSERT INTO openclaw_providers (name, display_name, base_url, api_key, status, sort_order) VALUES (?,?,NULL,NULL,?,?)',
      [name, display_name, status || 'active', sort_order || 0]
    );
    const providerId = result.insertId;
    if (Array.isArray(endpoints)) {
      for (const ep of endpoints) {
        if (ep.base_url && ep.api_key) {
          await db.query(
            'INSERT INTO openclaw_provider_endpoints (provider_id, base_url, api_key, weight, remark) VALUES (?,?,?,?,?)',
            [providerId, ep.base_url, ep.api_key, ep.weight || 1, ep.remark || null]
          );
        }
      }
    }
    await clearGatewayModelCache();
    res.json({ message: '已添加', id: providerId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '添加失败' });
  }
});

// 供应商管理 - 更新（含端点同步）
router.put('/providers/:id', async (req, res) => {
  const { name, display_name, status, sort_order, endpoints } = req.body;
  try {
    await db.query(
      'UPDATE openclaw_providers SET name=?, display_name=?, status=?, sort_order=? WHERE id=?',
      [name, display_name, status || 'active', sort_order || 0, req.params.id]
    );
    // 同步端点：全部标记 disabled 然后重新插入/恢复
    if (Array.isArray(endpoints)) {
      await db.query('UPDATE openclaw_provider_endpoints SET status="disabled" WHERE provider_id=?', [req.params.id]);
      for (const ep of endpoints) {
        if (!ep.base_url || !ep.api_key) continue;
        if (ep.id) {
          await db.query(
            'UPDATE openclaw_provider_endpoints SET base_url=?, api_key=?, weight=?, remark=?, status="active" WHERE id=? AND provider_id=?',
            [ep.base_url, ep.api_key, ep.weight || 1, ep.remark || null, ep.id, req.params.id]
          );
        } else {
          await db.query(
            'INSERT INTO openclaw_provider_endpoints (provider_id, base_url, api_key, weight, remark) VALUES (?,?,?,?,?)',
            [req.params.id, ep.base_url, ep.api_key, ep.weight || 1, ep.remark || null]
          );
        }
      }
    }
    await clearGatewayModelCache();
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
    await clearGatewayModelCache();
    res.json({ message: '已禁用' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '删除失败' });
  }
});

// 删除用户的API密钥（管理员权限）
router.delete('/users/:userId/api-keys/:keyId', async (req, res) => {
  const { userId, keyId } = req.params;
  try {
    const [result] = await db.query(
      'UPDATE openclaw_api_keys SET status = "disabled" WHERE id = ? AND user_id = ?',
      [keyId, userId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'API密钥不存在' });
    }
    res.json({ message: '已删除' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '操作失败' });
  }
});

// 用户详情
router.get('/users/:id', async (req, res) => {
  const userId = req.params.id;
  try {
    const [[user]] = await db.query(
      `SELECT u.id, u.username, u.role, u.created_at,
              COALESCE(q.balance, 0) as quota_balance,
              COALESCE(w.balance, 0) as wallet_balance
       FROM users u
       LEFT JOIN openclaw_quota q ON u.id = q.user_id
       LEFT JOIN openclaw_wallet w ON u.id = w.user_id
       WHERE u.id = ?`,
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
      `SELECT id, balance_type, amount, balance_before, balance_after, type, description, created_at
       FROM openclaw_balance_logs
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId]
    );

    const [apiKeys] = await db.query(
      'SELECT id, key_display, name, status, created_at, last_used_at FROM openclaw_api_keys WHERE user_id = ? AND is_deleted = 0 ORDER BY created_at DESC',
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
    const trace = await getRequestDebugTraceDetail(req.params.requestId);
    log.debug_steps = trace.steps;
    res.json(log);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取日志详情失败' });
  }
});

// 8步调试日志列表
router.get('/request-debug/traces', async (req, res) => {
  const { page = 1, limit = 20, request_id, model, route_name, trace_type = 'live', status, date } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  try {
    const innerWhere = ['1=1'];
    const innerParams = [];
    if (trace_type) {
      innerWhere.push('d.trace_type = ?');
      innerParams.push(trace_type);
    }
    if (request_id) {
      innerWhere.push('d.request_id LIKE ?');
      innerParams.push(`%${request_id}%`);
    }
    if (model) {
      innerWhere.push('d.model LIKE ?');
      innerParams.push(`%${model}%`);
    }
    if (route_name) {
      innerWhere.push('d.route_name = ?');
      innerParams.push(route_name);
    }
    if (date) {
      innerWhere.push('DATE(d.created_at) = ?');
      innerParams.push(date);
    }

    const innerSql = `
      SELECT d.request_id,
             MAX(d.trace_type) AS trace_type,
             MAX(d.route_name) AS route_name,
             MAX(d.model) AS model,
             MAX(d.user_id) AS user_id,
             MAX(d.api_key_id) AS api_key_id,
             MAX(d.created_at) AS created_at,
             COUNT(*) AS step_count,
             MAX(CASE WHEN d.status = 'error' THEN d.step_no END) AS failed_step_no,
             SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN d.status = 'error' THEN d.step_name END ORDER BY d.id DESC), ',', 1) AS failed_step_name,
             SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN d.status = 'error' THEN COALESCE(d.error_message, '') END ORDER BY d.id DESC SEPARATOR '\n'), '\n', 1) AS error_message,
             CASE
               WHEN SUM(d.status = 'error') > 0 THEN 'error'
               WHEN SUM(d.status = 'pending') > 0 THEN 'pending'
               WHEN SUM(d.status = 'skipped') > 0 AND SUM(d.status = 'success') = 0 THEN 'skipped'
               ELSE 'success'
             END AS final_status
      FROM openclaw_request_debug_logs d
      WHERE ${innerWhere.join(' AND ')}
      GROUP BY d.request_id
    `;

    const outerWhere = ['1=1'];
    const outerParams = [];
    if (status) {
      outerWhere.push('t.final_status = ?');
      outerParams.push(status);
    }

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total
       FROM (${innerSql}) t
       WHERE ${outerWhere.join(' AND ')}`,
      [...innerParams, ...outerParams]
    );

    const [rows] = await db.query(
      `SELECT t.*, u.username, l.status AS call_status, l.error_message AS call_error_message
       FROM (${innerSql}) t
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN openclaw_call_logs l ON l.request_id = t.request_id
       WHERE ${outerWhere.join(' AND ')}
       ORDER BY t.created_at DESC
       LIMIT ? OFFSET ?`,
      [...innerParams, ...outerParams, Number(limit), Number(offset)]
    );

    res.json({ traces: rows, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取调试追踪日志失败' });
  }
});

// 单条8步调试详情
router.get('/request-debug/traces/:requestId', async (req, res) => {
  try {
    const trace = await getRequestDebugTraceDetail(req.params.requestId);
    if (!trace.summary && trace.steps.length === 0) {
      return res.status(404).json({ error: '调试追踪不存在' });
    }
    res.json(trace);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取调试追踪详情失败' });
  }
});

// 手动触发一次真实链路调试
router.post('/request-debug/run', async (req, res) => {
  try {
    const {
      model,
      relay_api_key,
      prompt = '请回复：pong',
      system = '',
      route_type = 'chat',
      temperature = 0.2,
      max_tokens = 256,
      timeout_ms = 45000
    } = req.body || {};

    if (!model) return res.status(400).json({ error: '缺少 model' });
    if (!relay_api_key) return res.status(400).json({ error: '缺少 relay_api_key' });

    const result = await runRelayDebugRequest({
      route_type,
      model,
      relay_api_key,
      prompt,
      system,
      temperature,
      max_tokens,
      timeout_ms: Number(timeout_ms) > 0 ? Number(timeout_ms) : 45000,
    });

    const trace = result.request_id ? await getRequestDebugTraceDetail(result.request_id) : null;
    res.json({
      ...result,
      route_type,
      model,
      trace,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `执行调试失败: ${err.message}` });
  }
});

// CC Club 请求消息列表（含请求内容）
router.get('/ccclub/messages', async (req, res) => {
  const { page = 1, limit = 20, user_id, model, status, date, keyword } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  try {
    let where = `
      (
        EXISTS (
          SELECT 1
          FROM openclaw_models m
          JOIN openclaw_model_upstreams mu ON mu.model_id = m.id
          WHERE m.model_id = l.model
            AND mu.base_url LIKE '%claude-code.club%'
        )
        OR l.error_message LIKE '%claude-code.club%'
      )
    `;
    const params = [];
    if (user_id) { where += ' AND l.user_id = ?'; params.push(Number(user_id)); }
    if (model) { where += ' AND l.model LIKE ?'; params.push(`%${model}%`); }
    if (status) { where += ' AND l.status = ?'; params.push(status); }
    if (date) { where += ' AND DATE(l.created_at) = ?'; params.push(date); }
    if (keyword) {
      where += ' AND (r.user_prompt LIKE ? OR r.messages LIKE ? OR r.system_prompt LIKE ? OR r.response_content LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) as total
       FROM openclaw_call_logs l
       LEFT JOIN openclaw_request_logs r ON l.request_id = r.request_id
       WHERE ${where}`,
      params
    );

    const [logs] = await db.query(
      `SELECT l.id, l.request_id, l.user_id, u.username, l.model, l.prompt_tokens, l.completion_tokens,
              l.total_cost, l.status, l.error_message, l.created_at,
              r.user_prompt, r.messages, r.system_prompt, r.response_content,
              LEFT(r.user_prompt, 240) AS user_prompt_preview
       FROM openclaw_call_logs l
       LEFT JOIN users u ON l.user_id = u.id
       LEFT JOIN openclaw_request_logs r ON l.request_id = r.request_id
       WHERE ${where}
       ORDER BY l.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    );

    res.json({ logs, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取 CC Club 请求消息失败' });
  }
});

// 发送 CC Club 请求消息到管理员邮箱
router.post('/ccclub/messages/send-email', async (req, res) => {
  try {
    const single = req.body.request_id ? [String(req.body.request_id)] : [];
    const list = Array.isArray(req.body.request_ids) ? req.body.request_ids.map(String) : [];
    const requestIds = Array.from(new Set([...single, ...list])).filter(Boolean).slice(0, 100);
    if (!requestIds.length) return res.status(400).json({ error: '请传入 request_id 或 request_ids' });

    const transporter = await getMailer();
    if (!transporter) return res.status(500).json({ error: 'SMTP未配置，无法发送邮件' });
    const from = await getSettingCached('smtp_user', '');
    if (!from) return res.status(500).json({ error: 'SMTP发件人未配置' });
    const to = process.env.ALERT_EMAIL || process.env.ADMIN_EMAIL || '2743319061@qq.com';

    const placeholders = requestIds.map(() => '?').join(',');
    const [rows] = await db.query(
      `SELECT l.request_id, l.user_id, u.username, l.model, l.status, l.error_message, l.created_at,
              l.prompt_tokens, l.completion_tokens, l.total_cost,
              r.user_prompt, r.messages, r.system_prompt, r.response_content
       FROM openclaw_call_logs l
       LEFT JOIN users u ON l.user_id = u.id
       LEFT JOIN openclaw_request_logs r ON l.request_id = r.request_id
       WHERE l.request_id IN (${placeholders})
       ORDER BY l.created_at DESC`,
      requestIds
    );
    if (!rows.length) return res.status(404).json({ error: '未找到对应请求日志' });

    const summaryRows = rows.map((row, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(row.request_id)}</td>
        <td>${escapeHtml(row.username || String(row.user_id || '-'))}</td>
        <td>${escapeHtml(row.model || '-')}</td>
        <td>${escapeHtml(row.status || '-')}</td>
        <td>${escapeHtml(row.created_at || '-')}</td>
      </tr>
    `).join('');

    const details = rows.map((row, i) => `
      <h4 style="margin:18px 0 8px;">#${i + 1} ${escapeHtml(row.request_id || '')}</h4>
      <div><b>用户:</b> ${escapeHtml(row.username || String(row.user_id || '-'))}</div>
      <div><b>模型:</b> ${escapeHtml(row.model || '-')}</div>
      <div><b>状态:</b> ${escapeHtml(row.status || '-')}</div>
      <div><b>时间:</b> ${escapeHtml(row.created_at || '-')}</div>
      <div><b>Tokens:</b> in=${Number(row.prompt_tokens || 0)} / out=${Number(row.completion_tokens || 0)}</div>
      <div><b>费用:</b> ¥${Number(row.total_cost || 0).toFixed(6)}</div>
      <div><b>错误:</b> ${escapeHtml(row.error_message || '-')}</div>
      <div style="margin-top:8px;"><b>User Prompt</b></div>
      <pre style="white-space:pre-wrap;background:#f7f7f9;border:1px solid #eee;padding:8px;border-radius:6px;">${escapeHtml(row.user_prompt || '')}</pre>
      <div style="margin-top:8px;"><b>System Prompt</b></div>
      <pre style="white-space:pre-wrap;background:#f7f7f9;border:1px solid #eee;padding:8px;border-radius:6px;">${escapeHtml(row.system_prompt || '')}</pre>
      <div style="margin-top:8px;"><b>Messages</b></div>
      <pre style="white-space:pre-wrap;background:#f7f7f9;border:1px solid #eee;padding:8px;border-radius:6px;max-height:420px;overflow:auto;">${escapeHtml(row.messages || '')}</pre>
      <div style="margin-top:8px;"><b>Response</b></div>
      <pre style="white-space:pre-wrap;background:#f7f7f9;border:1px solid #eee;padding:8px;border-radius:6px;max-height:420px;overflow:auto;">${escapeHtml(row.response_content || '')}</pre>
    `).join('<hr style="margin:22px 0;border:none;border-top:1px solid #ddd;">');

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    await transporter.sendMail({
      from,
      to,
      subject: `【CC Club 请求消息】${rows.length} 条 ${now}`,
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;">
          <h3>CC Club 请求消息导出</h3>
          <p>导出时间（Asia/Shanghai）：${escapeHtml(now)}</p>
          <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:12px;">
            <thead><tr><th>#</th><th>Request ID</th><th>用户</th><th>模型</th><th>状态</th><th>时间</th></tr></thead>
            <tbody>${summaryRows}</tbody>
          </table>
          <hr style="margin:20px 0;">
          ${details}
        </div>
      `
    });

    res.json({ message: `已发送 ${rows.length} 条请求消息到 ${to}`, sent: rows.length, to });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '发送 CC Club 请求消息邮件失败' });
  }
});

router.post('/emails/send', async (req, res) => {
  try {
    const {
      subject,
      content,
      target = 'all',
      user_ids = [],
    } = req.body || {};

    const normalizedSubject = String(subject || '').trim();
    const normalizedContent = String(content || '').trim();
    if (!normalizedSubject) return res.status(400).json({ error: '邮件主题不能为空' });
    if (!normalizedContent) return res.status(400).json({ error: '邮件正文不能为空' });

    const transporter = await getMailer();
    if (!transporter) return res.status(500).json({ error: 'SMTP未配置，无法发送邮件' });
    const from = await getSettingCached('smtp_user', '');
    if (!from) return res.status(500).json({ error: 'SMTP发件人未配置' });

    let rows = [];
    if (target === 'users') {
      const ids = Array.from(new Set(
        (Array.isArray(user_ids) ? user_ids : [])
          .map(id => Number(id))
          .filter(id => Number.isInteger(id) && id > 0)
      )).slice(0, 500);
      if (!ids.length) return res.status(400).json({ error: '请先填写有效的用户ID' });
      const placeholders = ids.map(() => '?').join(',');
      [rows] = await db.query(
        `SELECT id, username, email
         FROM users
         WHERE id IN (${placeholders}) AND email IS NOT NULL AND email != ''
         ORDER BY id ASC`,
        ids
      );
      if (!rows.length) return res.status(404).json({ error: '所选用户均未绑定邮箱' });
    } else {
      [rows] = await db.query(
        `SELECT id, username, email
         FROM users
         WHERE email IS NOT NULL AND email != ''
         ORDER BY id ASC`
      );
      if (!rows.length) return res.status(404).json({ error: '暂无已绑定邮箱的用户' });
    }

    const recipients = Array.from(new Set(rows.map(row => String(row.email || '').trim()).filter(Boolean)));
    if (!recipients.length) return res.status(404).json({ error: '未找到可发送的邮箱地址' });

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.7;color:#111;">
        <div style="margin-bottom:14px;">${nl2brHtml(normalizedContent)}</div>
        <hr style="margin:18px 0;border:none;border-top:1px solid #e5e7eb;">
        <div style="font-size:12px;color:#666;">
          本邮件由 OpenClaw API 管理后台群发发送。
        </div>
      </div>
    `;

    await transporter.sendMail({
      from,
      bcc: recipients,
      subject: normalizedSubject,
      text: normalizedContent,
      html,
    });

    res.json({
      message: `群发成功，已投递到 ${recipients.length} 个邮箱`,
      sent: recipients.length,
      matched_users: rows.length,
      target: target === 'users' ? 'users' : 'all',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '群发邮件失败' });
  }
});

// CC Club 直连 vs 中转测速（管理员）
router.post('/ccclub/test-latency', async (req, res) => {
  try {
    const {
      model_id,
      prompt = '请回复：pong',
      relay_api_key,
      timeout_ms = 45000
    } = req.body || {};
    if (!model_id) return res.status(400).json({ error: '缺少 model_id' });
    if (!relay_api_key) return res.status(400).json({ error: '缺少 relay_api_key（中转测试密钥）' });

    const [[model]] = await db.query(
      'SELECT id, model_id, upstream_model_id FROM openclaw_models WHERE model_id = ? LIMIT 1',
      [model_id]
    );
    if (!model) return res.status(404).json({ error: '模型不存在' });

    const [[upstream]] = await db.query(
      `SELECT id, base_url, api_key, upstream_model_id, provider_name
       FROM openclaw_model_upstreams
       WHERE model_id = ?
         AND status = 'active'
         AND base_url LIKE '%claude-code.club%'
       ORDER BY sort_order ASC, id ASC
       LIMIT 1`,
      [model.id]
    );
    if (!upstream) return res.status(404).json({ error: '未找到该模型可用的 CC Club 上游配置' });

    const upstreamModelId = upstream.upstream_model_id || model.upstream_model_id || model.model_id;
    const directUrl = String(upstream.base_url || '').replace(/\/+$/, '') + '/v1/responses';
    const relayUrl = `http://127.0.0.1:${process.env.PORT || 3000}/v1/responses`;
    const timeout = Number(timeout_ms) > 0 ? Number(timeout_ms) : 45000;
    const normalizedPrompt = String(prompt || '请回复：pong').slice(0, 5000);

    const directPayload = {
      model: upstreamModelId,
      input: normalizedPrompt,
      max_output_tokens: 128
    };
    const relayPayload = {
      model: model.model_id,
      input: normalizedPrompt,
      max_output_tokens: 128
    };

    const directResult = await runHttpJsonTest({
      url: directUrl,
      headers: { Authorization: `Bearer ${upstream.api_key}` },
      body: directPayload,
      timeoutMs: timeout
    });

    const relayResult = await runHttpJsonTest({
      url: relayUrl,
      headers: { Authorization: `Bearer ${relay_api_key}` },
      body: relayPayload,
      timeoutMs: timeout
    });

    const diffMs = (Number.isFinite(directResult.duration_ms) && Number.isFinite(relayResult.duration_ms))
      ? (relayResult.duration_ms - directResult.duration_ms)
      : null;

    res.json({
      model_id: model.model_id,
      upstream_model_id: upstreamModelId,
      upstream_base_url: upstream.base_url,
      relay_url: relayUrl,
      direct: directResult,
      relay: relayResult,
      diff_ms: diffMs,
      verdict: diffMs === null ? 'unknown' : (diffMs > 0 ? 'relay_slower' : 'relay_faster_or_equal')
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `CC Club 测试失败: ${err.message}` });
  }
});

// ── 错误统计接口：便于发现上游故障规律 ─────────────────────────────────────
router.get('/error-stats', adminOnly, async (req, res) => {
  try {
    // 最近 24h 各错误类型统计
    const [stats24h] = await db.query(`
      SELECT status, COUNT(*) as count,
             SUM(total_cost) as total_cost,
             AVG(prompt_tokens + completion_tokens) as avg_tokens
      FROM openclaw_call_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      GROUP BY status ORDER BY count DESC`
    );

    // 最近 7d 各错误类型统计
    const [stats7d] = await db.query(`
      SELECT status, COUNT(*) as count
      FROM openclaw_call_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY status ORDER BY count DESC`
    );

    // 最近 24h 错误率（成功 vs 失败）
    const [summary] = await db.query(`
      SELECT
        COUNT(*) as total,
        SUM(status = 'success') as success,
        SUM(status != 'success') as errors,
        ROUND(SUM(status = 'success') * 100.0 / COUNT(*), 2) as success_rate
      FROM openclaw_call_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`
    );

    // 最近 20 条错误记录（排除 success）
    const [recentErrors] = await db.query(`
      SELECT l.id, l.created_at, l.model, l.status, l.error_message,
             l.prompt_tokens, l.completion_tokens, l.total_cost,
             u.username, l.ip
      FROM openclaw_call_logs l
      LEFT JOIN users u ON l.user_id = u.id
      WHERE l.status != 'success' AND l.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      ORDER BY l.created_at DESC LIMIT 20`
    );

    // 各模型错误率（24h，只看有错误的模型）
    const [modelErrors] = await db.query(`
      SELECT model,
             COUNT(*) as total,
             SUM(status != 'success') as errors,
             ROUND(SUM(status != 'success') * 100.0 / COUNT(*), 2) as error_rate
      FROM openclaw_call_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      GROUP BY model HAVING errors > 0
      ORDER BY error_rate DESC LIMIT 20`
    );

    res.json({
      summary: summary[0],
      stats_24h: stats24h,
      stats_7d: stats7d,
      model_errors_24h: modelErrors,
      recent_errors: recentErrors
    });
  } catch (err) {
    console.error('Error stats query failed:', err);
    res.status(500).json({ error: '获取错误统计失败' });
  }
});

// 趋势统计 — 最近 N 天每日调用/费用/tokens
router.get('/stats/trends', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 30);
  try {
    const [rows] = await db.query(
      `SELECT DATE(created_at) as date,
         COUNT(*) as calls,
         COALESCE(SUM(total_cost),0) as cost,
         COALESCE(SUM(prompt_tokens+completion_tokens),0) as tokens
       FROM openclaw_call_logs
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [days]
    );
    res.json({ days, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取趋势数据失败' });
  }
});

// 模型调用分布 — 最近 N 天各模型调用占比
router.get('/stats/model-distribution', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 30);
  try {
    const [rows] = await db.query(
      `SELECT model, COUNT(*) as calls, COALESCE(SUM(total_cost),0) as cost
       FROM openclaw_call_logs
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       GROUP BY model
       ORDER BY calls DESC
       LIMIT 10`,
      [days]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取模型分布失败' });
  }
});

// 修改用户状态（封禁/解禁）
router.put('/users/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['active', 'banned'].includes(status)) return res.status(400).json({ error: '状态值无效' });
  try {
    await db.query('UPDATE users SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ message: status === 'banned' ? '用户已封禁' : '用户已解禁' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '操作失败' });
  }
});

// 修改用户角色
router.put('/users/:id/role', async (req, res) => {
  const { role } = req.body;
  if (!['admin', 'user', 'reviewer'].includes(role)) return res.status(400).json({ error: '角色值无效' });
  try {
    await db.query('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
    res.json({ message: '角色已更新' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '操作失败' });
  }
});

// ── 缓存管理接口：手动清除模型/上游缓存 ────────────────────────────────────
router.post('/cache/clear', adminOnly, async (req, res) => {
  const { type, key } = req.body;
  if (type === 'all') {
    await cache.delByPrefix('model:');
    await cache.delByPrefix('upstreams:');
    await cache.delByPrefix('provider-endpoints:');
    await cache.delByPrefix('pkg:');
    res.json({ message: '所有缓存已清除' });
  } else if (type === 'model' && key) {
    await cache.del(`model:${key}`);
    await cache.del(`upstreams:${key}`);
    await cache.del(`provider-endpoints:${key}`);
    res.json({ message: `模型 ${key} 缓存已清除` });
  } else {
    res.status(400).json({ error: '参数错误，type 支持 all/model，model类型需要 key' });
  }
});

// 模型批量健康检查 — 并发测试所有 active 模型
router.post('/models/health-check', async (req, res) => {
  const GATEWAY_URL = process.env.AI_GATEWAY_URL || 'http://localhost:3000/api/plugins/ai-gateway';
  const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || '';

  try {
    const [models] = await db.query(
      "SELECT id, model_id, display_name, provider FROM openclaw_models WHERE status = 'active' ORDER BY sort_order"
    );

    const { model_ids } = req.body || {};
    const testModels = model_ids?.length
      ? models.filter(m => model_ids.includes(m.model_id))
      : models;

    const results = await Promise.allSettled(
      testModels.map(async (m) => {
        const start = Date.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 30000);
          const resp = await fetch(`${GATEWAY_URL}/v1/internal/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Secret': INTERNAL_SECRET,
              'X-User-Id': '1',
            },
            body: JSON.stringify({
              model: m.model_id,
              messages: [{ role: 'user', content: '请回复pong' }],
              max_tokens: 32,
              stream: false,
            }),
            signal: controller.signal,
          });
          clearTimeout(timer);

          const latency = Date.now() - start;
          if (!resp.ok) {
            let errMsg = `HTTP ${resp.status}`;
            try { const d = await resp.json(); errMsg = d.error?.message || errMsg; } catch {}
            return { model_id: m.model_id, display_name: m.display_name, provider: m.provider, status: 'error', latency, error: errMsg };
          }
          const data = await resp.json();
          const reply = data.choices?.[0]?.message?.content || '';
          return { model_id: m.model_id, display_name: m.display_name, provider: m.provider, status: 'ok', latency, reply: reply.slice(0, 100) };
        } catch (err) {
          return { model_id: m.model_id, display_name: m.display_name, provider: m.provider, status: 'error', latency: Date.now() - start, error: err.message };
        }
      })
    );

    const items = results.map(r => r.status === 'fulfilled' ? r.value : { status: 'error', error: r.reason?.message });
    const ok = items.filter(i => i.status === 'ok').length;
    const fail = items.filter(i => i.status === 'error').length;
    res.json({ total: items.length, ok, fail, models: items });
  } catch (err) {
    res.status(500).json({ error: `健康检查失败: ${err.message}` });
  }
});

// ── CC Club 密钥管理 ──────────────────────────────────────────────

// GET /admin/ccclub/keys — 列出所有 CC Club 密钥（以 upstreams 为主，注册表补充备注）
router.get('/ccclub/keys', async (req, res) => {
  try {
    const [keys] = await db.query(
      `SELECT
         COALESCE(k.id, 0)                        AS id,
         u.api_key,
         COALESCE(k.notes, '')                    AS notes,
         COALESCE(k.status, 'active')             AS status,
         k.created_at,
         COUNT(u.id)                              AS upstream_count
       FROM openclaw_model_upstreams u
       LEFT JOIN openclaw_ccclub_keys k ON k.api_key = u.api_key
       WHERE u.base_url LIKE '%claude-code.club%'
       GROUP BY u.api_key
       ORDER BY k.created_at DESC, u.api_key ASC`
    );
    res.json({ keys });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取密钥列表失败' });
  }
});

// POST /admin/ccclub/keys — 新增 CC Club 密钥
router.post('/ccclub/keys', async (req, res) => {
  try {
    let { key_raw, notes } = req.body || {};
    if (!key_raw) return res.status(400).json({ error: '请输入密钥' });
    const apiKey = String(key_raw).startsWith('cr_') ? String(key_raw) : 'cr_' + String(key_raw);
    notes = String(notes || '').slice(0, 255);

    // 重复检查
    const [[exist]] = await db.query(
      'SELECT id FROM openclaw_ccclub_keys WHERE api_key = ? LIMIT 1', [apiKey]
    );
    if (exist) return res.status(409).json({ error: '该密钥已存在，请勿重复添加' });

    // 从参考密钥复制所有 CC Club upstream 行
    const [templateRows] = await db.query(
      `SELECT model_id, base_url, upstream_model_id, weight, sort_order, provider_name
       FROM openclaw_model_upstreams
       WHERE base_url LIKE '%claude-code.club%'
         AND status IN ('active','disabled')
       GROUP BY model_id, base_url, upstream_model_id, weight, sort_order, provider_name`
    );

    if (templateRows.length > 0) {
      const insertVals = templateRows.map(r =>
        [r.model_id, r.base_url, apiKey, r.upstream_model_id, r.weight, r.sort_order, r.provider_name, 'active']
      );
      await db.query(
        `INSERT IGNORE INTO openclaw_model_upstreams
         (model_id, base_url, api_key, upstream_model_id, weight, sort_order, provider_name, status)
         VALUES ?`,
        [insertVals]
      );
    }

    await db.query('INSERT INTO openclaw_ccclub_keys (api_key, notes) VALUES (?, ?)', [apiKey, notes]);
    await cache.delByPrefix('upstreams:');

    res.json({ ok: true, api_key: apiKey, upstream_rows: templateRows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '添加密钥失败: ' + err.message });
  }
});

// PUT/PATCH /admin/ccclub/keys — 修改 CC Club 密钥备注（body: { api_key, notes }）
async function updateCcclubKeyNotes(req, res) {
  try {
    const apiKey = String(req.body?.api_key || '').trim();
    const notes = String(req.body?.notes || '').trim().slice(0, 255);
    if (!apiKey) return res.status(400).json({ error: '缺少 api_key 参数' });

    const [[registryRow]] = await db.query(
      'SELECT id FROM openclaw_ccclub_keys WHERE api_key = ? LIMIT 1',
      [apiKey]
    );
    const [[upstreamRow]] = await db.query(
      `SELECT id
       FROM openclaw_model_upstreams
       WHERE api_key = ?
         AND base_url LIKE '%claude-code.club%'
       LIMIT 1`,
      [apiKey]
    );

    if (!registryRow && !upstreamRow) {
      return res.status(404).json({ error: '未找到该 CC Club 密钥' });
    }

    if (registryRow) {
      await db.query('UPDATE openclaw_ccclub_keys SET notes = ? WHERE api_key = ?', [notes, apiKey]);
    } else {
      await db.query('INSERT INTO openclaw_ccclub_keys (api_key, notes) VALUES (?, ?)', [apiKey, notes]);
    }

    res.json({ ok: true, api_key: apiKey, notes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '更新密钥备注失败: ' + err.message });
  }
}

router.put('/ccclub/keys', updateCcclubKeyNotes);
router.patch('/ccclub/keys', updateCcclubKeyNotes);

// PUT /admin/ccclub/keys/status — 手动启用/禁用 CC Club 密钥（body: { api_key, status: 'active'|'disabled' }）
router.put('/ccclub/keys/status', async (req, res) => {
  try {
    const apiKey = String(req.body?.api_key || '').trim();
    const status = req.body?.status === 'disabled' ? 'disabled' : 'active';
    if (!apiKey) return res.status(400).json({ error: '缺少 api_key 参数' });

    // 确保注册表中有记录
    const [[existing]] = await db.query('SELECT id FROM openclaw_ccclub_keys WHERE api_key = ? LIMIT 1', [apiKey]);
    if (!existing) return res.status(404).json({ error: '未找到该 CC Club 密钥' });

    // 更新注册表状态
    await db.query('UPDATE openclaw_ccclub_keys SET status = ? WHERE api_key = ?', [status, apiKey]);
    // 同步更新所有对应上游行的状态
    await db.query(
      'UPDATE openclaw_model_upstreams SET status = ? WHERE api_key = ? AND base_url LIKE ?',
      [status, apiKey, '%claude-code.club%']
    );
    await cache.delByPrefix('upstreams:');

    res.json({ ok: true, api_key: apiKey, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '更新状态失败: ' + err.message });
  }
});

// DELETE /admin/ccclub/keys — 删除 CC Club 密钥（body: { api_key }）
router.delete('/ccclub/keys', async (req, res) => {
  try {
    const apiKey = String(req.body?.api_key || '').trim();
    if (!apiKey) return res.status(400).json({ error: '缺少 api_key 参数' });

    await db.query('DELETE FROM openclaw_model_upstreams WHERE api_key = ? AND base_url LIKE ?', [apiKey, '%claude-code.club%']);
    await db.query('DELETE FROM openclaw_ccclub_keys WHERE api_key = ?', [apiKey]);
    await cache.delByPrefix('upstreams:');

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '删除密钥失败: ' + err.message });
  }
});

// CC Club 密钥冷却状态查询
router.get('/ccclub/key-resets', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
      k.id AS reg_id,
      k.api_key,
      k.notes,
      COALESCE(k.status, 'active')  AS key_status,
      COALESCE(r.status, 'ready')   AS status,
      r.reset_at,
      r.last_status_code,
      r.last_error_message,
      r.last_seen_at
      FROM openclaw_ccclub_keys k
      LEFT JOIN openclaw_ccclub_key_resets r ON r.key_fingerprint = SHA2(k.api_key, 256)
      ORDER BY
      CASE COALESCE(r.status, 'ready')
      WHEN 'cooldown' THEN 0
      WHEN 'ready' THEN 1
      ELSE 2
      END ASC,
      r.reset_at ASC,
      k.id ASC`
    );
    res.json({ rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取密钥冷却状态失败' });
  }
});

// 手动将指定 CC Club 密钥从冷却状态恢复为可用
router.post('/ccclub/key-resets/recover', async (req, res) => {
  try {
    const apiKey = String(req.body?.api_key || '').trim();
    if (!apiKey) return res.status(400).json({ error: '缺少 api_key 参数' });

    const [[upstreamRow]] = await db.query(
      `SELECT id, provider_name, base_url
       FROM openclaw_model_upstreams
       WHERE api_key = ?
         AND base_url LIKE '%claude-code.club%'
       LIMIT 1`,
      [apiKey]
    );
    if (!upstreamRow) {
      return res.status(404).json({ error: '未找到该 CC Club 密钥对应的上游记录' });
    }

    const keyFingerprint = crypto.createHash('sha256').update(apiKey).digest('hex');
    await db.query(
      `INSERT INTO openclaw_ccclub_key_resets
       (key_fingerprint, provider_name, base_url, reset_at, status, last_seen_at, recovered_notified_at)
       VALUES (?, ?, ?, NOW(), 'ready', NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         provider_name = VALUES(provider_name),
         base_url = VALUES(base_url),
         status = 'ready',
         reset_at = NOW(),
         last_seen_at = NOW(),
         recovered_notified_at = COALESCE(recovered_notified_at, NOW()),
         updated_at = NOW()`,
      [keyFingerprint, String(upstreamRow.provider_name || ''), String(upstreamRow.base_url || '')]
    );

    await db.query(
      `UPDATE openclaw_model_upstreams
       SET status = 'active'
       WHERE base_url LIKE '%claude-code.club%'
         AND SHA2(api_key, 256) = ?`,
      [keyFingerprint]
    );
    await db.query(
      `UPDATE openclaw_provider_endpoints
       SET status = 'active'
       WHERE base_url LIKE '%claude-code.club%'
         AND SHA2(api_key, 256) = ?`,
      [keyFingerprint]
    ).catch(() => {});
    await db.query(
      `UPDATE openclaw_providers
       SET status = 'active'
       WHERE base_url LIKE '%claude-code.club%'
         AND SHA2(api_key, 256) = ?`,
      [keyFingerprint]
    ).catch(() => {});
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
    await cache.delByPrefix('model:');
    await cache.delByPrefix('upstreams:');
    await cache.delByPrefix('provider-endpoints:');

    res.json({ ok: true, api_key: apiKey, status: 'ready' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '手动恢复 CC Club 密钥失败: ' + err.message });
  }
});

// CC Club 密钥冷却状态发送到管理员邮箱
router.post('/ccclub/key-resets/send-email', async (req, res) => {
  try {
    const transporter = await getMailer();
    if (!transporter) return res.status(500).json({ error: 'SMTP未配置，无法发送邮件' });
    const from = await getSettingCached('smtp_user', '');
    if (!from) return res.status(500).json({ error: 'SMTP发件人未配置' });
    const to = process.env.ALERT_EMAIL || process.env.ADMIN_EMAIL || '2743319061@qq.com';

    const [rows] = await db.query(
      `SELECT
         k.id AS reg_id,
         k.api_key,
         k.notes,
         COALESCE(r.status, 'ready') AS status,
         r.reset_at,
         r.last_status_code,
         r.last_error_message,
         r.last_seen_at
       FROM openclaw_ccclub_keys k
       LEFT JOIN openclaw_ccclub_key_resets r ON r.key_fingerprint = SHA2(k.api_key, 256)
       ORDER BY
         CASE COALESCE(r.status, 'ready')
           WHEN 'cooldown' THEN 0
           WHEN 'ready' THEN 1
           ELSE 2
         END ASC,
         r.reset_at ASC,
         k.id ASC`
    );

    const now = new Date();
    const fmtDate = d => d ? new Date(d).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
    const diffLabel = s => {
      if (!s) return '';
      const ms = new Date(s).getTime() - now.getTime();
      if (ms <= 0) return '(已可用)';
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      return `(还需 ${h}h ${m}m)`;
    };

    const tableRows = rows.map((r, i) => `
      <tr style="background:${i % 2 === 0 ? '#fff' : '#f9f9f9'}">
        <td style="padding:6px 10px;border:1px solid #eee;">${escapeHtml(String(r.api_key || '').slice(0, 12) + '…' + String(r.api_key || '').slice(-6))}</td>
        <td style="padding:6px 10px;border:1px solid #eee;">${escapeHtml(r.notes || '—')}</td>
        <td style="padding:6px 10px;border:1px solid #eee;color:${r.status === 'cooldown' ? '#e53e3e' : '#38a169'};font-weight:600;">${r.status === 'cooldown' ? '冷却中' : '可用'}</td>
        <td style="padding:6px 10px;border:1px solid #eee;">${escapeHtml(fmtDate(r.reset_at))} ${escapeHtml(diffLabel(r.reset_at))}</td>
        <td style="padding:6px 10px;border:1px solid #eee;">${r.last_status_code || '—'}</td>
        <td style="padding:6px 10px;border:1px solid #eee;max-width:240px;">${escapeHtml((r.last_error_message || '').slice(0, 80) || '—')}</td>
        <td style="padding:6px 10px;border:1px solid #eee;">${escapeHtml(fmtDate(r.last_seen_at))}</td>
      </tr>`).join('');

    const html = `
      <h2 style="color:#333;">CC Club 密钥冷却状态报告</h2>
      <p style="color:#666;">查询时间：${escapeHtml(fmtDate(now))}，共 ${rows.length} 条记录</p>
      <table style="border-collapse:collapse;width:100%;font-size:13px;">
        <thead>
          <tr style="background:#f0f0f0;">
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">密钥</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">备注</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">状态</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">重置时间</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">HTTP码</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">最近错误</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">最近活跃</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>`;

    await transporter.sendMail({
      from,
      to,
      subject: `[CC Club] 密钥冷却状态报告 — ${rows.filter(r => r.status === 'cooldown').length} 个冷却中`,
      html
    });

    res.json({ ok: true, to, count: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `发送失败: ${err.message}` });
  }
});

module.exports = router;
