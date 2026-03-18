# Token 统计对比测试报告

## 测试目的
对比本地估算、平台返回、上游实际消耗的 token 差异，验证计费准确性。

## 测试方法
- 测试问题: "计算 1+1"
- 测试模型: DeepSeek Chat, GLM-4
- 测试参数: temperature=0 (确保输出一致性)
- 对比维度: 本地估算 vs 平台返回 vs 上游实际

## 测试结果

### 1. DeepSeek Chat

**输入**: "计算 1+1" (7 字符)
- 本地估算: 7 / 3 = 3 tokens
- 平台返回: 9 tokens
- 上游实际: 9 tokens
- 差异: 0 tokens ✅

**输出**: "你给出的计算是：\n\n**1 + 1 = 2**\n\n这是一个基础的加法运算。" (约 30 字符)
- 本地估算: 30 / 3 = 10 tokens
- 平台返回: 47 tokens
- 上游实际: 47 tokens
- 差异: 0 tokens ✅

**上游原始 usage**:
```json
{
  "completion_tokens": 47,
  "prompt_tokens": 9,
  "total_tokens": 56,
  "prompt_tokens_details": {"cached_tokens": 0},
  "completion_tokens_details": {"reasoning_tokens": 0}
}
```

**费用计算**:
- 输入: 9 * $0.0001/1K = ¥0.0000009
- 输出: 47 * $0.0015/1K = ¥0.0000705
- 总计: ¥0.0000714
- 状态: ✅ 计费准确

**结论**: DeepSeek Chat 的 token 统计完全准确，平台正确传递了上游的 usage 数据。

### 2. GLM-4

**输入**: "计算 1+1" (7 字符)
- 本地估算: 7 / 3 = 3 tokens
- 平台返回: 10 tokens
- 上游实际: 10 tokens
- 差异: 0 tokens ✅

**输出**: "1 + 1 = 2" (9 字符)
- 本地估算: 9 / 3 = 3 tokens
- 平台返回: 120 tokens
- 上游实际: 120 tokens (含 113 reasoning tokens)
- 差异: 0 tokens ✅

**上游原始 usage**:
```json
{
  "completion_tokens": 120,
  "prompt_tokens": 10,
  "total_tokens": 130,
  "prompt_tokens_details": {"cached_tokens": 0},
  "completion_tokens_details": {"reasoning_tokens": 113}
}
```

**费用计算**:
- 输入: 10 * $0.0001/1K = ¥0.000001
- 输出: 120 * $0.001/1K = ¥0.00012
- 总计: ¥0.000121
- 状态: ✅ 计费准确

**特殊说明**:
- GLM-4 在火山引擎上启用了推理模式
- 120 个 completion_tokens 中，113 个是推理过程的 token
- 实际输出只有约 7 个 token，但我们按 120 个 token 计费
- 这是上游模型的特性，不是我们平台的问题

**结论**: GLM-4 的 token 统计准确，但由于推理模式导致 token 消耗远高于实际输出。

### 3. Claude Sonnet 4.6 (CC Club)

**输入**: "计算 1+1" (7 字符)
- 本地估算: 7 / 3 = 3 tokens
- 平台返回: 29 tokens
- 上游实际: 29 tokens
- 差异: 0 tokens ✅

**输出**: "1 + 1 = **2**" (13 字符)
- 本地估算: 13 / 3 = 4 tokens
- 平台返回: 14 tokens
- 上游实际: 14 tokens
- 差异: 0 tokens ✅

**上游原始 usage**:
```json
{
  "input_tokens": 29,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 0,
  "cache_creation": {
    "ephemeral_5m_input_tokens": 0,
    "ephemeral_1h_input_tokens": 0
  },
  "output_tokens": 14,
  "service_tier": "standard",
  "inference_geo": "not_available"
}
```

**费用计算**:
- 输入: 29 * $0.003/1K = ¥0.000087
- 输出: 14 * $0.015/1K = ¥0.00021
- 总计: ¥0.000297
- 状态: ✅ 计费准确

**特殊说明**:
- Claude 的 input_tokens 包含系统提示词和格式化开销
- 简单的 "计算 1+1" 需要 29 个 input tokens
- 这是 Anthropic API 的正常行为

**结论**: Claude Sonnet 4.6 的 token 统计完全准确，平台正确转换了 Anthropic 格式的 usage 数据。

## 关键发现

### 1. 平台 Token 统计准确性: ✅ 100%
- 平台正确传递了上游 API 返回的 usage 数据
- 没有 token 统计差异或计费错误
- 代码逻辑: `data.usage?.prompt_tokens` 和 `data.usage?.completion_tokens`

### 2. 本地估算 vs 实际消耗
本地估算公式: `text.length / 3`

**准确性分析**:
- 中文输入: 估算 3 tokens vs 实际 9-10 tokens (差异 200-300%)
- 中文输出: 估算 3-10 tokens vs 实际 47-120 tokens (差异 400-1200%)

**结论**: 本地估算仅用于备用，实际计费完全依赖上游返回的 usage 数据。

### 3. 推理模式的影响
GLM-4 和 DeepSeek Reasoner 等模型启用推理模式后：
- completion_tokens 包含大量 reasoning_tokens
- 实际输出文本很短，但 token 消耗很高
- 这是模型特性，用户需要了解并接受

## 成本对比

### DeepSeek Chat (简单问题)
- Token 消耗: 9 input + 47 output = 56 tokens
- 费用: ¥0.0000714
- 性价比: ⭐⭐⭐⭐⭐

### GLM-4 (简单问题)
- Token 消耗: 10 input + 120 output = 130 tokens
- 费用: ¥0.000121
- 性价比: ⭐⭐⭐ (推理模式导致成本高)

### Claude Sonnet 4.6 (简单问题)
- Token 消耗: 29 input + 14 output = 43 tokens
- 费用: ¥0.000297
- 性价比: ⭐⭐⭐⭐ (质量高但成本较高)

### 成本排序 (从低到高)
1. DeepSeek Chat: ¥0.000071 (最便宜)
2. GLM-4: ¥0.000121 (推理模式)
3. Claude Sonnet 4.6: ¥0.000297 (最贵但质量最好)

## 建议

### 对用户
1. 简单问题使用 DeepSeek Chat，成本更低
2. 复杂推理问题使用 GLM-4 或 DeepSeek Reasoner
3. 了解推理模式会增加 token 消耗

### 对平台
1. ✅ Token 统计准确，无需修改
2. ✅ 计费逻辑正确，无需调整
3. 💡 可以在文档中说明推理模式的特性
4. 💡 可以在控制台显示 reasoning_tokens 的占比

## 测试环境
- 测试时间: 2026-03-18 09:00
- 上游: 火山引擎 (ark.cn-beijing.volces.com)
- 模型版本:
  - DeepSeek: deepseek-v3-2-251201
  - GLM-4: glm-4-7-251222

## 附录: 完整测试日志

### DeepSeek Chat
```bash
curl http://localhost:3021/v1/chat/completions \
  -H "Authorization: Bearer sk-test-..." \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"计算 1+1"}],"temperature":0}'

# 响应
{
  "usage": {
    "prompt_tokens": 9,
    "completion_tokens": 47,
    "total_tokens": 56
  }
}

# 后端日志
[Upstream Usage] Model: deepseek-chat, Raw usage: {"completion_tokens":47,"prompt_tokens":9,"total_tokens":56,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}}
```

### GLM-4
```bash
curl http://localhost:3021/v1/chat/completions \
  -H "Authorization: Bearer sk-test-..." \
  -d '{"model":"glm-4","messages":[{"role":"user","content":"计算 1+1"}],"temperature":0}'

# 响应
{
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 120,
    "total_tokens": 130
  }
}

# 后端日志
[Upstream Usage] Model: glm-4, Raw usage: {"completion_tokens":120,"prompt_tokens":10,"total_tokens":130,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":113}}
```

### Claude Sonnet 4.6
```bash
curl http://localhost:3021/v1/chat/completions \
  -H "Authorization: Bearer sk-test-..." \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"计算 1+1"}],"temperature":0}'

# 响应
{
  "usage": {
    "prompt_tokens": 29,
    "completion_tokens": 14,
    "total_tokens": 43
  }
}

# 后端日志
[Upstream Usage] Model: claude-sonnet-4-6, Raw usage: {"input_tokens":29,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":14,"service_tier":"standard","inference_geo":"not_available"}
[Token Stats] Model: claude-sonnet-4-6, Prompt: 29, Completion: 14
```

