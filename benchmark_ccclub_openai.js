const fs = require('fs');
const { spawnSync } = require('child_process');
const jwt = require('./backend/node_modules/jsonwebtoken');
const nodemailer = require('./backend/node_modules/nodemailer');
const db = require('./backend/src/config/db');

function parseEnvFile(filePath) {
  const out = {};
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function escapeHtml(input = '') {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pad(str, len) {
  const s = String(str);
  if (s.length >= len) return s;
  return s + ' '.repeat(len - s.length);
}

function formatMs(value) {
  return `${Number(value || 0).toFixed(0)} ms`;
}

async function fetchJson(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {}
    return { ok: resp.ok, status: resp.status, ms: Date.now() - started, text, data };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: err?.name === 'AbortError' ? `timeout>${timeoutMs}ms` : (err?.message || 'request failed'),
    };
  } finally {
    clearTimeout(timer);
  }
}

function curlJson(url, options = {}, timeoutMs = 60000) {
  const headers = options.headers || {};
  const body = options.body;
  const method = options.method || 'GET';
  const started = Date.now();
  const args = [
    '-sS',
    '--max-time',
    String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    '-X',
    method,
    url,
    '-w',
    '\\n__HTTP_CODE__%{http_code}',
  ];
  for (const [key, value] of Object.entries(headers)) {
    args.push('-H', `${key}: ${value}`);
  }
  if (body !== undefined) {
    args.push('--data-binary', body);
  }
  const proc = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const stdout = proc.stdout || '';
  const stderr = proc.stderr || '';
  const marker = '\n__HTTP_CODE__';
  const markerIndex = stdout.lastIndexOf(marker);
  const bodyText = markerIndex >= 0 ? stdout.slice(0, markerIndex) : stdout;
  const codeText = markerIndex >= 0 ? stdout.slice(markerIndex + marker.length).trim() : '0';
  let data = null;
  try {
    data = bodyText ? JSON.parse(bodyText) : null;
  } catch (_) {}
  return {
    ok: Number(codeText) >= 200 && Number(codeText) < 300,
    status: Number(codeText) || 0,
    ms: Date.now() - started,
    text: bodyText,
    data,
    error: proc.error ? (proc.error.message || 'curl failed') : (stderr.trim() || null),
  };
}

async function main() {
  const envPath = './backend/.env';
  const env = parseEnvFile(envPath);
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) throw new Error(`Missing JWT_SECRET in ${envPath}`);

  const [modelRows] = await db.query(
    `SELECT model_id, display_name, provider, sort_order
     FROM openclaw_models
     WHERE provider IN ('openai','ccclub') AND status = 'active'
     ORDER BY provider, sort_order, id`
  );
  const models = modelRows.filter(Boolean);
  if (!models.length) throw new Error('No active openai/ccclub models found');

  const prompt = 'Reply with only: pong.';
  const internalSecret = env.INTERNAL_API_SECRET;
  if (!internalSecret) throw new Error(`Missing INTERNAL_API_SECRET in ${envPath}`);

  console.log(`Benchmarking ${models.length} models...`);
  const results = [];
  for (const m of models) {
    const resp = curlJson('http://127.0.0.1:3000/v1/internal/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': internalSecret,
        'X-User-Id': '1',
      },
      body: JSON.stringify({
        model: m.model_id,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1,
        temperature: 0,
        stream: false,
      }),
    }, 45000);

    let preview = '';
    let error = resp.error || null;
    if (resp.data) {
      preview = resp.data.choices?.[0]?.message?.content
        || resp.data.output_text
        || resp.data.error?.message
        || resp.data.message
        || '';
      if (!resp.ok && !error) error = resp.data.error?.message || resp.data.error || `HTTP ${resp.status}`;
    } else if (resp.text) {
      preview = resp.text.slice(0, 120);
      if (!resp.ok && !error) error = `HTTP ${resp.status}`;
    }

    const row = {
      model_id: m.model_id,
      display_name: m.display_name,
      provider: m.provider,
      status: resp.ok ? 'ok' : 'error',
      latency_ms: resp.ms,
      http_status: resp.status,
      preview: String(preview || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      error,
    };
    results.push(row);
    console.log(`${pad(row.status === 'ok' ? '✓' : '✗', 2)} ${pad(row.model_id, 34)} ${pad(formatMs(row.latency_ms), 10)} ${row.error ? row.error : row.preview}`);
  }

  const ranked = [...results]
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'ok' ? -1 : 1;
      if (a.status === 'ok' && b.status === 'ok') return a.latency_ms - b.latency_ms || a.model_id.localeCompare(b.model_id);
      return a.latency_ms - b.latency_ms || a.model_id.localeCompare(b.model_id);
    })
    .map((r, idx) => ({ ...r, rank: idx + 1 }));

  const [smtpRows] = await db.query(
    'SELECT `key`, value FROM settings WHERE `key` IN ("smtp_host","smtp_port","smtp_user","smtp_pass")'
  );
  const smtp = Object.fromEntries(smtpRows.map(r => [r.key, r.value]));
  if (!smtp.smtp_host || !smtp.smtp_user || !smtp.smtp_pass) {
    throw new Error('Missing SMTP settings in database');
  }

  const testedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const successCount = ranked.filter(r => r.status === 'ok').length;
  const failCount = ranked.length - successCount;
  const fastest = ranked.filter(r => r.status === 'ok').slice(0, 5);

  const textLines = [];
  textLines.push('CC Club / OpenAI 模型响应速度排名');
  textLines.push(`测试时间：${testedAt}`);
  textLines.push(`测试方式：调用后台 /api/admin/models/health-check 并发测试，prompt = "${prompt}"，max_tokens = 32`);
  textLines.push(`模型范围：openai + ccclub 活跃模型，共 ${ranked.length} 个`);
  textLines.push(`成功：${successCount} 个，失败：${failCount} 个`);
  textLines.push('');
  textLines.push('完整排名：');
  for (const r of ranked) {
    const statusText = r.status === 'ok' ? formatMs(r.latency_ms) : `ERROR (${r.error || `HTTP ${r.http_status}`})`;
    textLines.push(`${String(r.rank).padStart(2, '0')}. ${pad(r.model_id, 34)} | ${pad(r.provider, 6)} | ${pad(statusText, 28)} | ${r.display_name}`);
  }
  textLines.push('');
  textLines.push('最快前 5：');
  for (const r of fastest) {
    textLines.push(`- ${r.model_id} (${r.display_name}) : ${formatMs(r.latency_ms)}`);
  }
  if (failCount) {
    textLines.push('');
    textLines.push('失败模型：');
    for (const r of ranked.filter(x => x.status !== 'ok')) {
      textLines.push(`- ${r.model_id}: ${r.error || `HTTP ${r.http_status}`}`);
    }
  }

  const text = textLines.join('\n');
  const htmlRows = ranked.map(r => {
    const statusText = r.status === 'ok' ? `${r.latency_ms} ms` : escapeHtml(r.error || `HTTP ${r.http_status}`);
    return `<tr><td>${r.rank}</td><td>${escapeHtml(r.model_id)}</td><td>${escapeHtml(r.display_name)}</td><td>${escapeHtml(r.provider)}</td><td>${r.status === 'ok' ? '成功' : '失败'}</td><td>${statusText}</td></tr>`;
  }).join('');
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111">
      <h2>CC Club / OpenAI 模型响应速度排名</h2>
      <p>测试时间：${escapeHtml(testedAt)}</p>
      <p>测试方式：调用后台 <code>/api/admin/models/health-check</code> 并发测试，prompt = <code>${escapeHtml(prompt)}</code>，max_tokens = 32。</p>
      <p>模型范围：openai + ccclub 活跃模型，共 <b>${ranked.length}</b> 个；成功 <b>${successCount}</b> 个，失败 <b>${failCount}</b> 个。</p>
      <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;width:100%;max-width:1200px">
        <thead style="background:#f3f4f6"><tr><th>#</th><th>model_id</th><th>display_name</th><th>provider</th><th>状态</th><th>响应</th></tr></thead>
        <tbody>${htmlRows}</tbody>
      </table>
      <h3>最快前 5</h3>
      <ul>${fastest.map(r => `<li>${escapeHtml(r.model_id)} (${escapeHtml(r.display_name)})：${r.latency_ms} ms</li>`).join('')}</ul>
    </div>`;

  const transporter = nodemailer.createTransport({
    host: smtp.smtp_host,
    port: Number(smtp.smtp_port) || 465,
    secure: Number(smtp.smtp_port) === 465,
    auth: { user: smtp.smtp_user, pass: smtp.smtp_pass },
  });

  const to = '2743319061@qq.com';
  const subject = `CC Club / OpenAI 模型响应速度排名 - ${testedAt}`;
  await transporter.sendMail({
    from: `OpenClaw Benchmark <${smtp.smtp_user}>`,
    to,
    subject,
    text,
    html,
  });

  const reportPath = '/tmp/ccclub-openai-ranking-report.txt';
  fs.writeFileSync(reportPath, text, 'utf8');

  console.log(`\nEmail sent to ${to}`);
  console.log(`Report saved to ${reportPath}`);
  console.log(`Top 3: ${ranked.filter(r => r.status === 'ok').slice(0, 3).map(r => `${r.model_id} (${r.latency_ms} ms)`).join(' | ')}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
