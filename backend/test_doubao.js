const axios = require('axios');
const crypto = require('crypto');
const db = require('./src/config/db');

const ADMIN_USER_ID = 1;
const GATEWAY = 'http://localhost:3000/api/plugins/ai-gateway/v1/chat/completions';
const TIMEOUT = 30000;

async function testModel(modelId, apiKey) {
  try {
    const resp = await axios.post(GATEWAY,
      { model: modelId, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5, stream: false },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT }
    );
    return { model: modelId, ok: true };
  } catch (e) {
    const msg = (e.response?.data?.error?.message || e.message || '').slice(0, 80);
    return { model: modelId, ok: false, error: msg };
  }
}

async function main() {
  const rawKey = 'sk-doubao-test-' + crypto.randomBytes(6).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  await db.query("DELETE FROM openclaw_api_keys WHERE name='doubao-test'");
  await db.query('INSERT INTO openclaw_api_keys (user_id, name, key_hash, key_prefix, key_display, status) VALUES (?, ?, ?, ?, ?, ?)',
    [ADMIN_USER_ID, 'doubao-test', keyHash, rawKey.slice(0,8), rawKey.slice(0,12)+'...', 'active']);

  const models = ['doubao-seed-2-0-code-preview-260215', 'doubao-seedream-5-0-260128'];
  
  const results = [];
  for (const m of models) {
    const r = await testModel(m, rawKey);
    console.log(`${r.ok?'✓':'✗'} ${r.model.padEnd(40)} ${r.error || 'OK'}`);
    results.push(r);
    await new Promise(r => setTimeout(r, 500));
  }

  const ok = results.filter(r => r.ok).map(r => r.model);
  if (ok.length > 0) {
    const ids = ok.map(m => `'${m}'`).join(',');
    await db.query(`UPDATE openclaw_models SET status='active' WHERE model_id IN (${ids})`);
    console.log(`\n已启用 ${ok.length} 个豆包模型: ${ok.join(', ')}`);
  }

  await db.query("DELETE FROM openclaw_api_keys WHERE name='doubao-test'");
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
