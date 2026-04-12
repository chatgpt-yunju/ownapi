const assert = require('assert');

const {
  resolveAnthropicCompatibleUpstreamUrl,
  resolveOpenAICompatibleUpstreamUrl,
} = require('./src/plugins/ai-gateway/utils/upstreamUrl');

const { getProviderConfig: getGatewayProviderConfig } = require('./src/plugins/ai-gateway/config/models');
const {
  applySmartRouterAveragePricing,
  isSmartRouterModel,
} = require('./src/plugins/ai-gateway/utils/smartRouterPricing');
const {
  classifyModelCategory,
  normalizeModelCategory,
} = require('./src/plugins/ai-gateway/utils/billing');

function run() {
  assert.strictEqual(
    resolveOpenAICompatibleUpstreamUrl('https://api.openai.com/v1', 'chat/completions'),
    'https://api.openai.com/v1/chat/completions'
  );

  assert.strictEqual(
    resolveOpenAICompatibleUpstreamUrl('https://ark.cn-beijing.volces.com/api/v3', 'chat/completions'),
    'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
  );

  assert.strictEqual(
    resolveOpenAICompatibleUpstreamUrl('https://open.bigmodel.cn/api/paas/v4', 'chat/completions'),
    'https://open.bigmodel.cn/api/paas/v4/chat/completions'
  );

  assert.strictEqual(
    resolveOpenAICompatibleUpstreamUrl('https://custom.example.com', 'chat/completions'),
    'https://custom.example.com/v1/chat/completions'
  );

  assert.strictEqual(
    resolveAnthropicCompatibleUpstreamUrl('https://api.anthropic.com/v1'),
    'https://api.anthropic.com/v1/messages'
  );

  assert.strictEqual(
    resolveAnthropicCompatibleUpstreamUrl('https://ark.cn-beijing.volces.com/api/v3'),
    'https://ark.cn-beijing.volces.com/api/v3/messages'
  );

  const smartRouterConfig = getGatewayProviderConfig('doubao-smart-router');
  assert.deepStrictEqual(getGatewayProviderConfig('volcengine'), smartRouterConfig);
  assert.deepStrictEqual(getGatewayProviderConfig('ark'), smartRouterConfig);
  assert.deepStrictEqual(getGatewayProviderConfig('huoshan'), smartRouterConfig);
  assert.deepStrictEqual(getGatewayProviderConfig('doubaosmartrouter'), smartRouterConfig);

  assert.strictEqual(isSmartRouterModel({ model_id: 'doubao-smart-router' }), true);
  assert.strictEqual(isSmartRouterModel({ provider: 'doubao-smart-router' }), true);
  assert.strictEqual(isSmartRouterModel({ model_id: 'volcengine' }), true);
  assert.strictEqual(isSmartRouterModel({ provider: 'ark' }), true);
  assert.strictEqual(isSmartRouterModel({ model_category: 'smart_route' }), true);
  assert.strictEqual(isSmartRouterModel({ model_id: 'deepseek-chat' }), false);
  assert.strictEqual(normalizeModelCategory('smart_route'), 'smart_route');
  assert.strictEqual(classifyModelCategory('doubao-smart-router', 'volcengine'), 'smart_route');

  const priced = applySmartRouterAveragePricing(
    { model_id: 'doubao-smart-router', input_price_per_1k: 1, output_price_per_1k: 2, price_currency: 'USD', per_call_price: 3 },
    { input_price_per_1k: 0.1234567, output_price_per_1k: 0.7654321 }
  );
  assert.strictEqual(priced.input_price_per_1k, 0.123457);
  assert.strictEqual(priced.output_price_per_1k, 0.765432);
  assert.strictEqual(priced.price_currency, 'CNY');
  assert.strictEqual(priced.per_call_price, null);
  assert.strictEqual(priced.model_category, 'smart_route');

  console.log('volcengine routing helper checks passed');
}

run();
