const mysql = require('/home/ubuntu/AI-Short-Video-Management-System/backend/node_modules/mysql2/promise');
const axios = require('axios');

const TIMEOUT = 15000;

async function main() {
  const db = await mysql.createPool({ host:'localhost', user:'root', database:'wechat_cms', waitForConnections:true, connectionLimit:5 });

  // 获取所有有 upstream 的模型
  const [models] = await db.query(`
    SELECT m.id, m.model_id, m.status, m.provider, m.upstream_model_id as model_upstream_id
    FROM openclaw_models m
    WHERE m.id IN (SELECT DISTINCT model_id FROM openclaw_model_upstreams WHERE status='active')
    ORDER BY m.id
  `);

  console.log(`总共 ${models.length} 个有 upstream 的模型\n`);

  const results = { success: [], fail: [] };

  for (const m of models) {
    const [ups] = await db.query(
      'SELECT * FROM openclaw_model_upstreams WHERE model_id=? AND status="active" ORDER BY sort_order LIMIT 1',
      [m.id]
    );
    if (!ups.length) { results.fail.push({ id: m.id, model: m.model_id, err: 'no upstream' }); continue; }
    const u = ups[0];

    // 确定上游模型名
    const upModel = u.upstream_model_id || m.model_upstream_id || m.model_id;

    // 确定是否 Anthropic
    const isAnth = m.model_id.includes('claude') && (u.base_url.includes('claude-code.club') || u.base_url.includes('anthropic.com'));

    let url, body, headers;
    const base = u.base_url.replace(/\/+$/, '');

    if (isAnth) {
      url = base.includes('/messages') ? base : `${base.replace(/\/v1\/?$/, '').replace(/\/+$/, '')}/v1/messages`;
      body = { model: upModel, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5 };
      headers = { 'x-api-key': u.api_key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
    } else {
      if (base.match(/\/chat\/completions$/)) {
        url = base;
      } else {
        const clean = base.replace(/\/v1\/chat\/completions\/?$/, '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
        url = `${clean}/v1/chat/completions`;
      }
      body = { model: upModel, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5 };
      // NVIDIA: 不再自动添加 upstream_provider
      headers = { 'Authorization': `Bearer ${u.api_key}`, 'Content-Type': 'application/json' };
    }

    try {
      const res = await axios.post(url, body, { headers, timeout: TIMEOUT });
      const status = res.status;
      results.success.push({ id: m.id, model: m.model_id, provider: u.provider_name, status });
      process.stdout.write(`✓ ${m.model_id}\n`);
    } catch (err) {
      const status = err.response?.status || 0;
      const msg = (err.response?.data?.error?.message || err.response?.data?.error || err.message || '').toString().slice(0, 80);
      results.fail.push({ id: m.id, model: m.model_id, provider: u.provider_name, status, err: msg });
      process.stdout.write(`✗ ${m.model_id} [${status}] ${msg.slice(0, 50)}\n`);
    }
  }

  console.log(`\n=== 结果 ===`);
  console.log(`成功: ${results.success.length}`);
  console.log(`失败: ${results.fail.length}`);

  // 启用成功的，禁用失败的
  if (results.success.length > 0) {
    const successIds = results.success.map(r => r.id);
    await db.query(`UPDATE openclaw_models SET status='active' WHERE id IN (${successIds.join(',')})`);
    console.log(`已启用 ${successIds.length} 个模型`);
  }
  if (results.fail.length > 0) {
    const failIds = results.fail.map(r => r.id);
    await db.query(`UPDATE openclaw_models SET status='disabled' WHERE id IN (${failIds.join(',')})`);
    console.log(`已禁用 ${failIds.length} 个模型`);
  }

  // 打印失败详情
  if (results.fail.length > 0) {
    console.log('\n=== 失败详情 ===');
    for (const f of results.fail) {
      console.log(`  ${f.model} [${f.status}] ${f.err}`);
    }
  }

  await db.end();
}

main().catch(e => { console.error(e); process.exit(1); });
