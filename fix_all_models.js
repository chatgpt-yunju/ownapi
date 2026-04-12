const mysql = require('/home/ubuntu/AI-Short-Video-Management-System/backend/node_modules/mysql2/promise');
const axios = require('axios');

const POLLINATIONS_URL = 'https://gen.pollinations.ai/v1';
const POLLINATIONS_KEY = 'free'; // 不需要真实key，但字段不能为空

// 模型到Pollinations模型名的映射
const POLLINATIONS_MAP = {
  // GPT系列 → openai / openai-large
  'gpt-3.5-turbo': 'openai',
  'gpt-4o': 'openai-large',
  'gpt-4o-mini': 'openai',
  'gpt-4-turbo': 'openai-large',
  'gpt-4-turbo-2024-04-09': 'openai-large',
  'gpt-4': 'openai-large',
  'gpt-4-32k': 'openai-large',
  'gpt-4o-audio-preview': 'openai-large',
  'chatgpt-4o-latest': 'openai-large',
  'gpt-5.4-codex': 'openai-large',
  'gpt-5.3-codex': 'openai-large',
  'o1-preview': 'openai-large',
  'o1-mini': 'openai',
  'o3-mini': 'openai',
  // Claude
  'claude-3-5-sonnet-20241022': 'claude',
  // Gemini
  'gemini-2.5-flash': 'gemini',
  'gemini-2.5-pro': 'gemini',
  'gemini-3.1-flash-lite': 'gemini',
  'gemini-2.0-flash-exp': 'gemini',
  'gemini-1.5-pro': 'gemini',
  'gemini-1.5-flash': 'gemini',
  // DeepSeek
  'deepseek-v3-2-251201': 'deepseek',
  // GLM
  'glm-4-7-251222': 'qwen-coder',
  // Qwen
  'qwen-turbo': 'qwen-coder',
  // Doubao
  'doubao-pro-128k-240515': 'deepseek',
  // minimax
  'minimax-m2.5': 'mistral',
  'minimax-m2.7': 'mistral',
};

// 跳过的模型（不可修复）
const SKIP = ['test-model', 'bge-m3', 'minimax-m2.1', 'doubao-seedream-5-0-260128'];

async function main() {
  const db = await mysql.createPool({ host:'localhost', user:'root', database:'wechat_cms', connectionLimit:5 });

  const [disabled] = await db.query("SELECT id, model_id FROM openclaw_models WHERE status='disabled' ORDER BY id");
  console.log(`共 ${disabled.length} 个 disabled 模型\n`);

  let fixed = 0, skipped = 0, failed = 0;

  for (const m of disabled) {
    if (SKIP.includes(m.model_id)) {
      console.log(`⊘ ${m.model_id} (跳过)`);
      skipped++;
      continue;
    }

    const pollinationsModel = POLLINATIONS_MAP[m.model_id];
    if (!pollinationsModel) {
      console.log(`? ${m.model_id} (无映射，跳过)`);
      skipped++;
      continue;
    }

    // 测试Pollinations是否能调通
    try {
      await axios.post(`${POLLINATIONS_URL}/chat/completions`, {
        model: pollinationsModel,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 3
      }, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
    } catch (err) {
      console.log(`✗ ${m.model_id} → ${pollinationsModel} 测试失败: ${err.message?.slice(0, 50)}`);
      failed++;
      continue;
    }

    // 添加Pollinations upstream（保留旧的但disabled）
    // 检查是否已有pollinations upstream
    const [[existing]] = await db.query(
      "SELECT id FROM openclaw_model_upstreams WHERE model_id=? AND base_url=? AND status='active'",
      [m.id, POLLINATIONS_URL]
    );
    if (!existing) {
      await db.query(
        'INSERT INTO openclaw_model_upstreams (model_id, provider_name, base_url, api_key, upstream_model_id, weight, status, sort_order) VALUES (?,?,?,?,?,?,?,?)',
        [m.id, 'pollinations', POLLINATIONS_URL, POLLINATIONS_KEY, pollinationsModel, 1, 'active', 0]
      );
    }

    // 启用模型
    await db.query("UPDATE openclaw_models SET status='active' WHERE id=?", [m.id]);
    console.log(`✓ ${m.model_id} → ${pollinationsModel}`);
    fixed++;
  }

  console.log(`\n=== 结果 ===`);
  console.log(`修复: ${fixed}, 跳过: ${skipped}, 失败: ${failed}`);

  // 统计最终状态
  const [[counts]] = await db.query("SELECT SUM(status='active') as active, SUM(status='disabled') as disabled FROM openclaw_models");
  console.log(`最终: ${counts.active} active, ${counts.disabled} disabled`);

  await db.end();
}

main().catch(e => { console.error(e); process.exit(1); });
