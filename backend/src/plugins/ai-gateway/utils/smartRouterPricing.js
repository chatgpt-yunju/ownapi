const db = require('../../../config/db');
const { roundAmount } = require('./billing');

const SMART_ROUTER_KEYS = new Set([
  'doubao-smart-router',
  'doubaosmartrouter',
  'volcengine',
  'volcenginesmartrouter',
  'ark',
  'huoshan',
]);

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function isSmartRouterModel(model = {}) {
  const modelId = normalizeKey(model.model_id);
  const provider = normalizeKey(model.provider);
  const category = String(model.model_category || '').trim().toLowerCase();
  return SMART_ROUTER_KEYS.has(modelId)
    || SMART_ROUTER_KEYS.has(provider)
    || modelId.includes('doubaosmartrouter')
    || provider.includes('doubaosmartrouter')
    || category === 'smart_route';
}

function applySmartRouterAveragePricing(model = {}, pricing = {}) {
  const input = Number.isFinite(Number(pricing.input_price_per_1k))
    ? roundAmount(pricing.input_price_per_1k)
    : 0;
  const output = Number.isFinite(Number(pricing.output_price_per_1k))
    ? roundAmount(pricing.output_price_per_1k)
    : 0;

  return {
    ...model,
    input_price_per_1k: input,
    output_price_per_1k: output,
    price_currency: 'CNY',
    per_call_price: null,
    model_category: 'smart_route',
  };
}

async function getDomesticAveragePricing() {
  const [rows] = await db.query(
    `SELECT
       COALESCE(AVG(input_price_per_1k), 0) AS avg_input,
       COALESCE(AVG(output_price_per_1k), 0) AS avg_output
     FROM openclaw_models
     WHERE status = 'active'
       AND billing_mode = 'token'
       AND price_currency = 'CNY'
       AND COALESCE(model_category, '') <> 'smart_route'
       AND LOWER(REPLACE(REPLACE(REPLACE(COALESCE(model_id, ''), '-', ''), '_', ''), ' ', '')) NOT IN (
         'doubaosmartrouter', 'volcengine', 'volcenginesmartrouter', 'ark', 'huoshan'
       )
       AND LOWER(REPLACE(REPLACE(REPLACE(COALESCE(provider, ''), '-', ''), '_', ''), ' ', '')) NOT IN (
         'doubaosmartrouter', 'volcengine', 'volcenginesmartrouter', 'ark', 'huoshan'
       )`
  );
  const row = rows?.[0] || {};
  return {
    input_price_per_1k: roundAmount(row.avg_input || 0),
    output_price_per_1k: roundAmount(row.avg_output || 0),
  };
}

module.exports = {
  applySmartRouterAveragePricing,
  getDomesticAveragePricing,
  isSmartRouterModel,
};
