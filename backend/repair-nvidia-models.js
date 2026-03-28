#!/usr/bin/env node

const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const db = require('./src/config/db');
const cache = require('./src/plugins/ai-gateway/utils/cache');
const { classifyModelCategory } = require('./src/plugins/ai-gateway/utils/billing');

const CATALOG_PATH = process.env.NVIDIA_CATALOG_PATH || '/tmp/nvidia_models.json';
const GATEWAY_BASE = (process.env.LOCAL_GATEWAY_BASE || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const TEST_TIMEOUT_MS = Number(process.env.NVIDIA_TEST_TIMEOUT_MS || 45000);
const TEST_IMAGE_URL = process.env.NVIDIA_TEST_IMAGE_URL || 'https://assets.ngc.nvidia.com/products/api-catalog/nemoretriever-parse/example_1.jpg';
const TEMP_USER_ID = Number(process.env.NVIDIA_TEST_USER_ID || 999999);
const MODEL_FILTER = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
const TEMP_KEY = `sk-${crypto.randomBytes(24).toString('hex')}`;
const TEMP_KEY_HASH = crypto.createHash('sha256').update(TEMP_KEY).digest('hex');
const TEMP_KEY_DISPLAY = `${TEMP_KEY.slice(0, 7)}...${TEMP_KEY.slice(-4)}`;
const TEMP_KEY_PREFIX = TEMP_KEY.slice(0, 7);

function slugFromUpstreamModel(upstreamModelId) {
  return String(upstreamModelId || '').split('/').pop();
}

function shouldSkipSmokeTest(modelId) {
  const target = String(modelId || '').toLowerCase();
  if (/(streampetr)/.test(target)) return 'specialized_non_chat_model';
  return null;
}

function isEmbeddingsModel(modelId) {
  const target = String(modelId || '').toLowerCase();
  return /(^|[-_])(embed|embedqa)([-_]|$)|arctic-embed|bge-m3|nvclip/.test(target);
}

function isParserModel(modelId) {
  const target = String(modelId || '').toLowerCase();
  return target.includes('nemoretriever-parse') || target.includes('nemotron-parse');
}

function buildSmokeRequest(modelId, category) {
  const lower = String(modelId || '').toLowerCase();

  if (isEmbeddingsModel(modelId)) {
    const body = {
      model: modelId,
      input: 'Embed this sentence.',
      encoding_format: 'float',
    };
    if (lower.includes('embedqa') || lower.includes('e5')) body.input_type = 'query';
    if (lower.includes('nvclip') || lower.includes('embed-vl')) body.modality = 'text';
    return { endpoint: '/v1/embeddings', body };
  }

  if (isParserModel(modelId)) {
    return {
      endpoint: '/v1/chat/completions',
      body: {
        model: modelId,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Extract the document into markdown.' },
            { type: 'image_url', image_url: { url: TEST_IMAGE_URL } },
          ],
        }],
        tools: [{
          type: 'function',
          function: {
            name: 'markdown_bbox',
            description: 'Parse the document into markdown with bounding boxes.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'markdown_bbox' } },
        max_tokens: 128,
        stream: false,
      }
    };
  }

  if (category === 'vision') {
    return {
      endpoint: '/v1/chat/completions',
      body: {
        model: modelId,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe the main subject in one short sentence.' },
            { type: 'image_url', image_url: { url: TEST_IMAGE_URL } },
          ],
        }],
        max_tokens: 64,
        stream: false,
      }
    };
  }

  if (lower.includes('reward')) {
    return {
      endpoint: '/v1/chat/completions',
      body: {
        model: modelId,
        messages: [
          { role: 'user', content: 'Question: what color is the sky on a clear day?' },
          { role: 'assistant', content: 'The sky is usually blue on a clear day.' },
        ],
        max_tokens: 16,
        stream: false,
      }
    };
  }

  return {
    endpoint: '/v1/chat/completions',
    body: {
      model: modelId,
      messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
      max_tokens: 16,
      stream: false,
    }
  };
}

async function smokeTestModel(modelId, category) {
  try {
    const request = buildSmokeRequest(modelId, category);
    const response = await axios.post(
      `${GATEWAY_BASE}${request.endpoint}`,
      request.body,
      {
        timeout: TEST_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${TEMP_KEY}`,
          'Content-Type': 'application/json',
        },
        validateStatus: () => true,
      }
    );

    const payload = response.data;
    if (response.status !== 200) {
      const message = payload?.error?.message || payload?.message || JSON.stringify(payload);
      return { ok: false, httpStatus: response.status, detail: String(message || `HTTP ${response.status}`).slice(0, 500) };
    }

    return { ok: true, httpStatus: response.status };
  } catch (error) {
    return { ok: false, httpStatus: 0, detail: error.message };
  }
}

async function ensureTempTestAuth() {
  await db.query(
    `INSERT INTO openclaw_api_keys (user_id, key_prefix, key_hash, key_display, name, status, is_deleted)
     VALUES (?, ?, ?, ?, 'NVIDIA Repair Temp Key', 'active', 0)`,
    [TEMP_USER_ID, TEMP_KEY_PREFIX, TEMP_KEY_HASH, TEMP_KEY_DISPLAY]
  );
  await db.query(
    'INSERT INTO openclaw_quota (user_id, balance) VALUES (?, 1000) ON DUPLICATE KEY UPDATE balance = GREATEST(balance, 1000)',
    [TEMP_USER_ID]
  );
  await db.query(
    'INSERT INTO openclaw_wallet (user_id, balance) VALUES (?, 1000) ON DUPLICATE KEY UPDATE balance = GREATEST(balance, 1000)',
    [TEMP_USER_ID]
  );

  const [[pkg]] = await db.query(
    `SELECT id
     FROM openclaw_packages
     WHERE status = 'active' AND type <> 'free'
     ORDER BY price DESC, id DESC
     LIMIT 1`
  );
  if (pkg?.id) {
    await db.query('UPDATE openclaw_user_packages SET status = "expired" WHERE user_id = ? AND status = "active"', [TEMP_USER_ID]).catch(() => {});
    await db.query(
      `INSERT INTO openclaw_user_packages (user_id, package_id, started_at, expires_at, status)
       VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY), 'active')`,
      [TEMP_USER_ID, pkg.id]
    );
  }
}

async function cleanupTempTestAuth() {
  await db.query('DELETE FROM openclaw_api_keys WHERE key_hash = ?', [TEMP_KEY_HASH]).catch(() => {});
  await cache.del(`key:${TEMP_KEY_HASH}`).catch(() => {});
}

async function loadOfficialCatalog() {
  const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
  const payload = JSON.parse(raw);
  const items = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return items
    .map((item) => item?.id)
    .filter(Boolean);
}

async function main() {
  const officialIds = await loadOfficialCatalog();
  const officialSet = new Set(officialIds);
  const [models] = await db.query(
    `SELECT id, model_id, status, model_category, upstream_model_id
     FROM openclaw_models
     WHERE provider = 'nvidia'
     ORDER BY model_id`
  );
  const [providers] = await db.query(`SELECT id FROM openclaw_providers WHERE name = 'nvidia' AND status = 'active' LIMIT 1`);
  if (!providers.length) {
    throw new Error('Active NVIDIA provider not found');
  }
  const providerId = providers[0].id;

  const [bindings] = await db.query(
    `SELECT id, model_id, status, upstream_model_id
     FROM openclaw_model_providers
     WHERE provider_id = ?`,
    [providerId]
  );
  const bindingByModelId = new Map(bindings.map((row) => [row.model_id, row]));
  const modelByUpstream = new Map(models.map((row) => [row.upstream_model_id, row]));
  const modelById = new Map(models.map((row) => [row.model_id, row]));
  const report = {
    inserted: [],
    relinked: [],
    categoriesUpdated: [],
    bindingsInserted: [],
    enabled: [],
    disabled: [],
    skipped: [],
    failed: [],
    missingFromOfficial: [],
  };

  for (const upstreamModelId of officialIds) {
    if (modelByUpstream.has(upstreamModelId)) continue;
    const modelId = slugFromUpstreamModel(upstreamModelId);
    const category = classifyModelCategory(modelId, 'nvidia');
    const existingModel = modelById.get(modelId);
    if (existingModel) {
      await db.query(
        'UPDATE openclaw_models SET display_name = ?, upstream_model_id = ?, model_category = ? WHERE id = ?',
        [modelId, upstreamModelId, category, existingModel.id]
      );
      existingModel.upstream_model_id = upstreamModelId;
      existingModel.model_category = category;
      modelByUpstream.set(upstreamModelId, existingModel);
      report.relinked.push(`${modelId}:${upstreamModelId}`);
      continue;
    }

    const [result] = await db.query(
      `INSERT INTO openclaw_models
        (model_id, display_name, provider, status, upstream_model_id, model_category, billing_mode)
       VALUES (?, ?, 'nvidia', 'disabled', ?, ?, 'token')`,
      [modelId, modelId, upstreamModelId, category]
    );
    const insertedModel = {
      id: result.insertId,
      model_id: modelId,
      status: 'disabled',
      model_category: category,
      upstream_model_id: upstreamModelId,
    };
    models.push(insertedModel);
    modelById.set(modelId, insertedModel);
    modelByUpstream.set(upstreamModelId, insertedModel);
    report.inserted.push(modelId);
  }

  for (const model of models) {
    if (!model.upstream_model_id || !officialSet.has(model.upstream_model_id)) {
      report.missingFromOfficial.push(model.model_id);
      continue;
    }

    const detectedCategory = classifyModelCategory(model.model_id, 'nvidia');
    if (detectedCategory !== model.model_category) {
      await db.query('UPDATE openclaw_models SET model_category = ? WHERE id = ?', [detectedCategory, model.id]);
      model.model_category = detectedCategory;
      report.categoriesUpdated.push(`${model.model_id}:${detectedCategory}`);
    }

    const binding = bindingByModelId.get(model.id);
    if (!binding) {
      const [result] = await db.query(
        `INSERT INTO openclaw_model_providers (model_id, provider_id, weight, status, upstream_model_id)
         VALUES (?, ?, 1, ?, ?)`,
        [model.id, providerId, model.status === 'active' ? 'active' : 'disabled', model.upstream_model_id]
      );
      bindingByModelId.set(model.id, {
        id: result.insertId,
        model_id: model.id,
        status: model.status === 'active' ? 'active' : 'disabled',
        upstream_model_id: model.upstream_model_id,
      });
      report.bindingsInserted.push(model.model_id);
    } else if (binding.upstream_model_id !== model.upstream_model_id) {
      await db.query(
        'UPDATE openclaw_model_providers SET upstream_model_id = ? WHERE id = ?',
        [model.upstream_model_id, binding.id]
      );
      binding.upstream_model_id = model.upstream_model_id;
    }
  }

  await ensureTempTestAuth();

  try {
    const smokeTargets = models.filter((model) => {
      if (MODEL_FILTER && !MODEL_FILTER.test(model.model_id)) return false;
      return model.status !== 'active' || report.bindingsInserted.includes(model.model_id);
    });
    for (const model of smokeTargets) {
      const binding = bindingByModelId.get(model.id);
      const skipReason = shouldSkipSmokeTest(model.model_id);
      if (skipReason) {
        await db.query('UPDATE openclaw_models SET status = "disabled" WHERE id = ?', [model.id]);
        if (binding?.id) {
          await db.query('UPDATE openclaw_model_providers SET status = "disabled" WHERE id = ?', [binding.id]);
        }
        report.skipped.push(`${model.model_id}:${skipReason}`);
        continue;
      }

      if (binding?.id) {
        await db.query('UPDATE openclaw_model_providers SET status = "active" WHERE id = ?', [binding.id]);
      }
      await db.query('UPDATE openclaw_models SET status = "active" WHERE id = ?', [model.id]);

      const smoke = await smokeTestModel(model.model_id, model.model_category);
      if (smoke.ok) {
        report.enabled.push(model.model_id);
        model.status = 'active';
        continue;
      }

      await db.query('UPDATE openclaw_models SET status = "disabled" WHERE id = ?', [model.id]);
      if (binding?.id) {
        await db.query('UPDATE openclaw_model_providers SET status = "disabled" WHERE id = ?', [binding.id]);
      }
      model.status = 'disabled';
      report.failed.push(`${model.model_id}:${smoke.httpStatus || 'ERR'}:${smoke.detail}`);
    }
  } finally {
    await cleanupTempTestAuth();
  }

  await cache.delByPrefix('model:');
  await cache.delByPrefix('upstreams:');
  await cache.delByPrefix('provider-endpoints:');

  console.log(JSON.stringify({
    official_count: officialIds.length,
    local_count: models.length,
    filter: MODEL_FILTER ? MODEL_FILTER.source : null,
    inserted_count: report.inserted.length,
    relinked_count: report.relinked.length,
    category_updates: report.categoriesUpdated.length,
    bindings_inserted: report.bindingsInserted.length,
    enabled_count: report.enabled.length,
    failed_count: report.failed.length,
    skipped_count: report.skipped.length,
    missing_from_official_count: report.missingFromOfficial.length,
    report,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end().catch(() => {});
    if (cache.redis) {
      await cache.redis.quit().catch(() => {});
    }
  });
