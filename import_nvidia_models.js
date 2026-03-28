const mysql = require('/home/ubuntu/AI-Short-Video-Management-System/backend/node_modules/mysql2/promise');
const axios = require('axios');

const NVIDIA_KEYS = [
  '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',
  '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',
  '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',
  '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',
];
const BASE_URL = 'https://integrate.api.nvidia.com/v1';

// 非聊天模型（嵌入/图像/安全/奖励等），跳过
const SKIP_PATTERNS = [
  'embed', 'nv-embed', 'arctic-embed', 'bge-m3',
  'deplot', 'paligemma', 'kosmos-2', 'neva-22b', 'nvclip', 'streampetr',
  'reward', 'parse', 'nemoretriever', 'safety-guard', 'llama-guard',
  'gliner-pii', 'fuyu-8b',
];

function shouldSkip(modelId) {
  const lower = modelId.toLowerCase();
  return SKIP_PATTERNS.some(p => lower.includes(p));
}

function shortName(fullId) {
  return fullId.includes('/') ? fullId.split('/').pop() : fullId;
}

function displayName(fullId) {
  const short = shortName(fullId);
  return short.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    .replace(/\d+b/gi, m => m.toUpperCase())
    .replace(/Instruct/g, 'Instruct')
    .replace(/V(\d)/g, 'v$1');
}

async function main() {
  const db = await mysql.createPool({ host:'localhost', user:'root', database:'wechat_cms', connectionLimit:5 });

  // 获取NVIDIA模型列表
  const resp = await axios.get(`${BASE_URL}/models`, {
    headers: { 'Authorization': `Bearer ${NVIDIA_KEYS[3]}` },
    timeout: 15000
  });
  const allModels = (resp.data.data || resp.data).filter(m => !shouldSkip(m.id));
  // 去重
  const seen = new Set();
  const models = allModels.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });

  console.log(`筛选后 ${models.length} 个聊天模型`);

  let created = 0, updated = 0, upstreamsAdded = 0;

  for (const m of models) {
    const short = shortName(m.id);
    const display = displayName(m.id);

    // 检查模型是否已存在
    const [[existing]] = await db.query('SELECT id, status FROM openclaw_models WHERE model_id = ?', [short]);

    let modelDbId;
    if (existing) {
      modelDbId = existing.id;
      // 启用已有模型
      if (existing.status === 'disabled') {
        await db.query('UPDATE openclaw_models SET status="active", provider="nvidia" WHERE id=?', [modelDbId]);
        updated++;
      }
    } else {
      // 新建模型
      const [result] = await db.query(
        'INSERT INTO openclaw_models (model_id, display_name, provider, input_price_per_1k, output_price_per_1k, price_currency, sort_order, status) VALUES (?,?,?,?,?,?,?,?)',
        [short, display, 'nvidia', 0.001, 0.002, 'CNY', 100, 'active']
      );
      modelDbId = result.insertId;
      created++;
    }

    // 检查是否已有 upstream
    const [[upCount]] = await db.query(
      'SELECT COUNT(*) as cnt FROM openclaw_model_upstreams WHERE model_id=? AND status="active"',
      [modelDbId]
    );

    if (upCount.cnt === 0) {
      // 添加4个API key作为upstream（轮询）
      for (let i = 0; i < NVIDIA_KEYS.length; i++) {
        await db.query(
          'INSERT INTO openclaw_model_upstreams (model_id, provider_name, base_url, api_key, upstream_model_id, weight, status, sort_order) VALUES (?,?,?,?,?,?,?,?)',
          [modelDbId, `nvidia-${i+1}`, BASE_URL, NVIDIA_KEYS[i], m.id, 1, 'active', i]
        );
        upstreamsAdded++;
      }
    } else if (upCount.cnt < 4) {
      // 已有upstream但不足4个，补齐（检查哪些key已存在）
      const [existingUps] = await db.query(
        'SELECT api_key FROM openclaw_model_upstreams WHERE model_id=? AND status="active"',
        [modelDbId]
      );
      const existingKeys = new Set(existingUps.map(u => u.api_key));
      for (let i = 0; i < NVIDIA_KEYS.length; i++) {
        if (!existingKeys.has(NVIDIA_KEYS[i])) {
          await db.query(
            'INSERT INTO openclaw_model_upstreams (model_id, provider_name, base_url, api_key, upstream_model_id, weight, status, sort_order) VALUES (?,?,?,?,?,?,?,?)',
            [modelDbId, `nvidia-${i+1}`, BASE_URL, NVIDIA_KEYS[i], m.id, 1, 'active', i]
          );
          upstreamsAdded++;
        }
      }
      // 确保已有的upstream也有正确的upstream_model_id
      await db.query(
        'UPDATE openclaw_model_upstreams SET upstream_model_id=? WHERE model_id=? AND status="active" AND (upstream_model_id IS NULL OR upstream_model_id="")',
        [m.id, modelDbId]
      );
    }
  }

  console.log(`新建: ${created}, 更新: ${updated}, upstream添加: ${upstreamsAdded}`);
  await db.end();
}

main().catch(e => { console.error(e); process.exit(1); });
