// 上游模型 API 配置
// 可通过数据库 openclaw_models 表的 upstream_endpoint / upstream_key 覆盖
const zhipuProvider = {
  baseUrl: process.env.ZHIPU_BASE_URL || process.env.BIGMODEL_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: process.env.ZHIPU_API_KEY || process.env.BIGMODEL_API_KEY || process.env.GLM_API_KEY || ''
};

const PROVIDERS = {
  openai: {
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY || ''
  },
  deepseek: {
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY || ''
  },
  qwen: {
    baseUrl: process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: process.env.QWEN_API_KEY || ''
  },
  anthropic: {
    baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
    apiKey: process.env.ANTHROPIC_API_KEY || ''
  },
  nvidia: {
    baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    apiKey: process.env.NVIDIA_API_KEY || ''
  },
  google: {
    baseUrl: process.env.GOOGLE_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: process.env.GOOGLE_API_KEY || ''
  },
  volcengine: {
    baseUrl: process.env.VOLCENGINE_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: process.env.VOLCENGINE_API_KEY || ''
  },
  zhipu: zhipuProvider,
  bigmodel: zhipuProvider,
  glm: zhipuProvider,
  glm4: zhipuProvider,
  glm5: zhipuProvider,
  'glm-4': zhipuProvider,
  'glm-5': zhipuProvider,
  zhipuai: zhipuProvider
};

function normalizeProviderName(providerName) {
  return String(providerName || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function getProviderConfig(providerName) {
  if (!providerName) return {};
  return PROVIDERS[providerName] || PROVIDERS[normalizeProviderName(providerName)] || {};
}

module.exports = {
  ...PROVIDERS,
  getProviderConfig
};
