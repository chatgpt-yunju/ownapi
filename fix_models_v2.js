const mysql = require('/home/ubuntu/AI-Short-Video-Management-System/backend/node_modules/mysql2/promise');
const axios = require('axios');

async function main() {
  const db = await mysql.createPool({ host:'localhost', user:'root', database:'wechat_cms', connectionLimit:5 });

  // 获取ccclub key
  const [[keyRow]] = await db.query("SELECT api_key FROM openclaw_model_upstreams WHERE model_id=10 AND status='active' LIMIT 1");
  const ccclubKey = keyRow.api_key;
  const ccclubOpenAI = 'https://claude-code.club/api/v1';

  // 1. Gemini 模型 → 通过 ccclub OpenAI兼容端点
  const geminiModels = ['gemini-2.5-flash','gemini-2.5-pro','gemini-3.1-flash-lite','gemini-2.0-flash-exp','gemini-1.5-pro','gemini-1.5-flash'];
  for (const modelId of geminiModels) {
    const [[m]] = await db.query('SELECT id, status FROM openclaw_models WHERE model_id=?', [modelId]);
    if (!m) { console.log(`⊘ ${modelId} 不存在`); continue; }

    // 添加ccclub upstream
    const [[ex]] = await db.query("SELECT id FROM openclaw_model_upstreams WHERE model_id=? AND base_url=? AND status='active'", [m.id, ccclubOpenAI]);
    if (!ex) {
      await db.query(
        'INSERT INTO openclaw_model_upstreams (model_id, provider_name, base_url, api_key, upstream_model_id, weight, status, sort_order) VALUES (?,?,?,?,?,?,?,?)',
        [m.id, 'ccclub-openai', ccclubOpenAI, ccclubKey, modelId, 1, 'active', 0]
      );
    }
    await db.query("UPDATE openclaw_models SET status='active', provider='google' WHERE id=?", [m.id]);
    console.log(`✓ ${modelId} → ccclub-openai`);
  }

  // 2. GPT/OpenAI 模型 → 通过 NVIDIA (gpt-oss) 替代，或 ccclub OpenAI
  // 测试ccclub是否支持这些模型（通过OpenAI兼容端点）
  const gptModels = [
    { id: 'gpt-3.5-turbo', nvidia: 'openai/gpt-oss-20b' },
    { id: 'gpt-4o', nvidia: null },
    { id: 'gpt-4o-mini', nvidia: 'openai/gpt-oss-20b' },
    { id: 'gpt-4-turbo', nvidia: null },
    { id: 'gpt-4-turbo-2024-04-09', nvidia: null },
    { id: 'gpt-4', nvidia: null },
    { id: 'gpt-4-32k', nvidia: null },
    { id: 'o1-preview', nvidia: null },
    { id: 'o1-mini', nvidia: 'openai/gpt-oss-20b' },
    { id: 'o3-mini', nvidia: null },
    { id: 'gpt-4o-audio-preview', nvidia: null },
    { id: 'chatgpt-4o-latest', nvidia: null },
    { id: 'gpt-5.4-codex', nvidia: null },
    { id: 'gpt-5.3-codex', nvidia: null },
  ];

  const NVIDIA_KEYS = [
    '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',
    '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',
    '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',
    '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',
  ];
  const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1';

  for (const gm of gptModels) {
    const [[m]] = await db.query('SELECT id, status FROM openclaw_models WHERE model_id=?', [gm.id]);
    if (!m) continue;

    if (gm.nvidia) {
      // 有NVIDIA替代模型，添加NVIDIA upstream
      const [[ex]] = await db.query("SELECT id FROM openclaw_model_upstreams WHERE model_id=? AND base_url=? AND status='active'", [m.id, NVIDIA_URL]);
      if (!ex) {
        for (let i = 0; i < NVIDIA_KEYS.length; i++) {
          await db.query(
            'INSERT INTO openclaw_model_upstreams (model_id, provider_name, base_url, api_key, upstream_model_id, weight, status, sort_order) VALUES (?,?,?,?,?,?,?,?)',
            [m.id, `nvidia-${i+1}`, NVIDIA_URL, NVIDIA_KEYS[i], gm.nvidia, 1, 'active', i]
          );
        }
      }
      await db.query("UPDATE openclaw_models SET status='active' WHERE id=?", [m.id]);
      console.log(`✓ ${gm.id} → nvidia (${gm.nvidia})`);
    } else {
      // 没有替代方案，保持disabled
      console.log(`⊘ ${gm.id} (无免费provider可用)`);
    }
  }

  // 3. Claude-3-5-sonnet → ccclub Anthropic Messages 端点
  {
    const [[m]] = await db.query("SELECT id FROM openclaw_models WHERE model_id='claude-3-5-sonnet-20241022'");
    if (m) {
      // 已有ccclub-1 upstream但返回500，可能是模型名过时。尝试用不同的上游模型名
      // 先禁用旧的，添加新的
      await db.query("UPDATE openclaw_model_upstreams SET status='disabled' WHERE model_id=? AND provider_name='ccclub-1'", [m.id]);
      const ccclubAnth = 'https://claude-code.club/api/v1/messages';
      await db.query(
        'INSERT INTO openclaw_model_upstreams (model_id, provider_name, base_url, api_key, upstream_model_id, weight, status, sort_order) VALUES (?,?,?,?,?,?,?,?)',
        [m.id, 'ccclub-anth', ccclubAnth, ccclubKey, 'claude-3-5-sonnet-20241022', 1, 'active', 0]
      );
      await db.query("UPDATE openclaw_models SET status='active' WHERE id=?", [m.id]);
      console.log(`✓ claude-3-5-sonnet-20241022 → ccclub-anth (重试)`);
    }
  }

  // 4. 火山引擎模型修复
  const volcKey = '18771050-2cfc-42b1-a212-4cf95de83aa7';
  const volcUrl = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
  // deepseek-v3-2-251201 的 endpoint ID 需要修正，用NVIDIA替代
  {
    const [[m]] = await db.query("SELECT id FROM openclaw_models WHERE model_id='deepseek-v3-2-251201'");
    if (m) {
      // 添加NVIDIA upstream (deepseek-v3.2 在NVIDIA上可用)
      const [[ex]] = await db.query("SELECT id FROM openclaw_model_upstreams WHERE model_id=? AND base_url=? AND status='active'", [m.id, NVIDIA_URL]);
      if (!ex) {
        for (let i = 0; i < NVIDIA_KEYS.length; i++) {
          await db.query(
            'INSERT INTO openclaw_model_upstreams (model_id, provider_name, base_url, api_key, upstream_model_id, weight, status, sort_order) VALUES (?,?,?,?,?,?,?,?)',
            [m.id, `nvidia-${i+1}`, NVIDIA_URL, NVIDIA_KEYS[i], 'deepseek-ai/deepseek-v3.2', 1, 'active', i]
          );
        }
      }
      await db.query("UPDATE openclaw_models SET status='active' WHERE id=?", [m.id]);
      console.log(`✓ deepseek-v3-2-251201 → nvidia (deepseek-ai/deepseek-v3.2)`);
    }
  }

  // glm-4-7-251222 → NVIDIA has z-ai/glm4.7
  {
    const [[m]] = await db.query("SELECT id FROM openclaw_models WHERE model_id='glm-4-7-251222'");
    if (m) {
      const [[ex]] = await db.query("SELECT id FROM openclaw_model_upstreams WHERE model_id=? AND base_url=? AND status='active'", [m.id, NVIDIA_URL]);
      if (!ex) {
        for (let i = 0; i < NVIDIA_KEYS.length; i++) {
          await db.query(
            'INSERT INTO openclaw_model_upstreams (model_id, provider_name, base_url, api_key, upstream_model_id, weight, status, sort_order) VALUES (?,?,?,?,?,?,?,?)',
            [m.id, `nvidia-${i+1}`, NVIDIA_URL, NVIDIA_KEYS[i], 'z-ai/glm4.7', 1, 'active', i]
          );
        }
      }
      await db.query("UPDATE openclaw_models SET status='active' WHERE id=?", [m.id]);
      console.log(`✓ glm-4-7-251222 → nvidia (z-ai/glm4.7)`);
    }
  }

  // qwen-turbo → NVIDIA has qwen models
  {
    const [[m]] = await db.query("SELECT id FROM openclaw_models WHERE model_id='qwen-turbo'");
    if (m) {
      const [[ex]] = await db.query("SELECT id FROM openclaw_model_upstreams WHERE model_id=? AND base_url=? AND status='active'", [m.id, NVIDIA_URL]);
      if (!ex) {
        for (let i = 0; i < NVIDIA_KEYS.length; i++) {
          await db.query(
            'INSERT INTO openclaw_model_upstreams (model_id, provider_name, base_url, api_key, upstream_model_id, weight, status, sort_order) VALUES (?,?,?,?,?,?,?,?)',
            [m.id, `nvidia-${i+1}`, NVIDIA_URL, NVIDIA_KEYS[i], 'qwen/qwen2.5-7b-instruct', 1, 'active', i]
          );
        }
      }
      await db.query("UPDATE openclaw_models SET status='active' WHERE id=?", [m.id]);
      console.log(`✓ qwen-turbo → nvidia (qwen/qwen2.5-7b-instruct)`);
    }
  }

  // doubao-pro-128k → volcengine 端点名不对，用NVIDIA deepseek替代
  {
    const [[m]] = await db.query("SELECT id FROM openclaw_models WHERE model_id='doubao-pro-128k-240515'");
    if (m) {
      const [[ex]] = await db.query("SELECT id FROM openclaw_model_upstreams WHERE model_id=? AND base_url=? AND status='active'", [m.id, NVIDIA_URL]);
      if (!ex) {
        for (let i = 0; i < NVIDIA_KEYS.length; i++) {
          await db.query(
            'INSERT INTO openclaw_model_upstreams (model_id, provider_name, base_url, api_key, upstream_model_id, weight, status, sort_order) VALUES (?,?,?,?,?,?,?,?)',
            [m.id, `nvidia-${i+1}`, NVIDIA_URL, NVIDIA_KEYS[i], 'deepseek-ai/deepseek-v3.1', 1, 'active', i]
          );
        }
      }
      await db.query("UPDATE openclaw_models SET status='active' WHERE id=?", [m.id]);
      console.log(`✓ doubao-pro-128k-240515 → nvidia (deepseek-ai/deepseek-v3.1)`);
    }
  }

  // 最终统计
  const [[counts]] = await db.query("SELECT SUM(status='active') as active, SUM(status='disabled') as disabled FROM openclaw_models");
  console.log(`\n=== 最终: ${counts.active} active, ${counts.disabled} disabled ===`);

  await db.end();
}

main().catch(e => { console.error(e); process.exit(1); });
