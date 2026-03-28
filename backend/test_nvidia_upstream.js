const axios = require('axios');
const crypto = require('crypto');
const db = require('./src/config/db');

const ADMIN_USER_ID = 1;
const GATEWAY = 'http://localhost:3000/api/plugins/ai-gateway/v1/chat/completions';
const TIMEOUT = 30000;

async function testModel(modelId, apiKey) {
  try {
    const resp = await axios.post(GATEWAY,
      { 
        model: modelId, 
        messages: [{ role: 'user', content: 'Hi' }], 
        max_tokens: 5, 
        stream: false,
        upstream_provider: 'nvidia'  // 添加 upstream_provider 参数
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT }
    );
    return { model: modelId, ok: true };
  } catch (e) {
    const code = e.response?.status || 'TIMEOUT';
    const msg = (e.response?.data?.error?.message || e.message || '').slice(0, 80);
    return { model: modelId, ok: false, code, error: msg };
  }
}

async function main() {
  const rawKey = 'sk-nv-test-' + crypto.randomBytes(6).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  await db.query("DELETE FROM openclaw_api_keys WHERE name='nvidia-upstream-test'");
  await db.query('INSERT INTO openclaw_api_keys (user_id, name, key_hash, key_prefix, key_display, status) VALUES (?, ?, ?, ?, ?, ?)',
    [ADMIN_USER_ID, 'nvidia-upstream-test', keyHash, rawKey.slice(0,8), rawKey.slice(0,12)+'...', 'active']);

  const models = ['yi-large', 'jamba-1.5-large-instruct', 'deepseek-v3.2'];
  
  const results = [];
  for (const m of models) {
    const r = await testModel(m, rawKey);
    console.log(`${r.ok?'✓':'✗'} ${r.model.padEnd(30)} Code: ${r.code} ${r.error || 'OK'}`);
    results.push(r);
    await new Promise(r => setTimeout(r, 2000)); // 延长 2 秒
  }

  const ok = results.filter(r => r.ok).map(r => r.model);
  if (ok.length > 0) {
    const ids = ok.map(m => `'${m}'`).join(',');
    await db.query(`UPDATE openclaw_models SET status='active' WHERE model_id IN (${ids})`);
    console.log(`\n已启用 ${ok.length} 个 NVIDIA 模型: ${ok.join(', ')}`);
  }

  await db.query("DELETE FROM openclaw_api_keys WHERE name='nvidia-upstream-test'");
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
