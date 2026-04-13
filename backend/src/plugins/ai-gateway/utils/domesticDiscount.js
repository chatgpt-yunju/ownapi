const { roundAmount } = require('./billing');

const DOMESTIC_PROVIDER_KEYWORDS = [
  'qwen',
  'deepseek',
  'zhipu',
  'bigmodel',
  'glm',
  'doubao',
  'volcengine',
  'volcenginesmartrouter',
  'doubaosmartrouter',
  'ark',
  'huoshan',
  'baidu',
  'ernie',
  'moonshot',
  'kimi',
  'yi',
  'stepfun',
  'hunyuan',
  'tencent',
  'minimax',
  'spark',
  'xfyun',
  'iflytek',
  'sensechat',
  'baichuan',
];

const DOMESTIC_MODEL_KEYWORDS = [
  'qwen',
  'deepseek',
  'glm',
  'zhipu',
  'doubao',
  'volcengine',
  'ark',
  'huoshan',
  'ernie',
  'moonshot',
  'kimi',
  'yi',
  'stepfun',
  'hunyuan',
  'baichuan',
  'spark',
  'internlm',
  'minimax',
];

const DOMESTIC_DISCOUNT_RATE = 0.5;

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function isDomesticModel(model = {}) {
  const provider = normalizeKey(model.provider);
  const modelId = normalizeKey(model.model_id);
  const target = `${provider} ${modelId}`;
  return DOMESTIC_PROVIDER_KEYWORDS.some(keyword => target.includes(normalizeKey(keyword)))
    || DOMESTIC_MODEL_KEYWORDS.some(keyword => target.includes(normalizeKey(keyword)));
}

function applyDomesticModelDiscount(model = {}, rate = DOMESTIC_DISCOUNT_RATE) {
  if (!model || !isDomesticModel(model)) {
    return {
      ...model,
      base_input_price_per_1k: model?.input_price_per_1k ?? 0,
      base_output_price_per_1k: model?.output_price_per_1k ?? 0,
      discount_rate: 1,
      discount_label: null,
      is_domestic_discounted: false,
    };
  }

  const baseInput = Number(model.input_price_per_1k || 0);
  const baseOutput = Number(model.output_price_per_1k || 0);
  return {
    ...model,
    base_input_price_per_1k: roundAmount(baseInput),
    base_output_price_per_1k: roundAmount(baseOutput),
    input_price_per_1k: roundAmount(baseInput * rate),
    output_price_per_1k: roundAmount(baseOutput * rate),
    discount_rate: rate,
    discount_label: '国产 5 折',
    is_domestic_discounted: true,
  };
}

module.exports = {
  DOMESTIC_DISCOUNT_RATE,
  applyDomesticModelDiscount,
  isDomesticModel,
};
