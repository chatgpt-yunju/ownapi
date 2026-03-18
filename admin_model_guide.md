# 管理员添加模型指南

## 币种选择说明

管理员在添加或编辑模型时，需要指定价格币种：

### 国内模型 → 选择 **人民币 (CNY)**
- DeepSeek 系列
- GLM 系列
- Qwen 系列
- 其他国内厂商模型

### 国外模型 → 选择 **美元 (USD)**
- Claude 系列 (Anthropic)
- GPT 系列 (OpenAI)
- Gemini 系列 (Google)
- 其他国外厂商模型

## 添加模型步骤

### 1. 进入管理后台

访问: `https://api.yunjunet.cn/admin.html`

### 2. 点击"模型管理"

在左侧菜单选择"模型管理"

### 3. 点击"+ 添加模型"

填写以下信息：

#### 基本信息
- **模型 ID**: 模型的唯一标识符（如 `gpt-4o`, `claude-sonnet-4-6`）
- **显示名称**: 用户看到的名称（如 `GPT-4o`, `Claude Sonnet 4.6`）
- **提供商**: 选择提供商（openai, deepseek, qwen, anthropic, ccclub, volcengine 等）

#### 价格配置
- **输入价格**: 每 1K tokens 的输入价格
- **输出价格**: 每 1K tokens 的输出价格
- **价格币种**:
  - 国内模型选择 **人民币 (CNY)**
  - 国外模型选择 **美元 (USD)**，系统会自动按汇率 7.2 转换为人民币扣费

#### 上游配置（可选）
- **上游地址**: 自定义 API 端点（留空使用默认）
- **上游 Key**: 自定义 API 密钥（留空使用默认）
- **上游模型 ID**: 如果上游模型 ID 与平台不同，填写此字段

#### 其他设置
- **排序**: 数字越小越靠前
- **状态**: 启用/禁用

### 4. 保存模型

点击"保存"按钮完成添加

## 示例配置

### 示例 1: 添加国内模型 (DeepSeek)

```
模型 ID: deepseek-chat
显示名称: DeepSeek Chat
提供商: volcengine
输入价格: 0.0001
输出价格: 0.0002
价格币种: 人民币 (CNY)  ← 国内模型
上游地址: https://ark.cn-beijing.volces.com/api/v3
上游 Key: your-volcengine-key
上游模型 ID: deepseek-v3-2-251201
```

**计费**: 直接按人民币扣费
- 1000 input tokens = ¥0.0001
- 1000 output tokens = ¥0.0002

### 示例 2: 添加国外模型 (Claude)

```
模型 ID: claude-sonnet-4-6
显示名称: Claude Sonnet 4.6
提供商: ccclub
输入价格: 0.003
输出价格: 0.015
价格币种: 美元 (USD)  ← 国外模型
上游地址: https://claude-code.club/api/v1/messages
上游 Key: cr_your-cc-club-key
```

**计费**: 自动转换为人民币（汇率 7.2）
- 1000 input tokens = $0.003 × 7.2 = ¥0.0216
- 1000 output tokens = $0.015 × 7.2 = ¥0.108

### 示例 3: 添加国外模型 (GPT)

```
模型 ID: gpt-4o
显示名称: GPT-4o
提供商: openai
输入价格: 0.005
输出价格: 0.015
价格币种: 美元 (USD)  ← 国外模型
上游地址: https://api.openai.com/v1
上游 Key: sk-your-openai-key
```

**计费**: 自动转换为人民币（汇率 7.2）
- 1000 input tokens = $0.005 × 7.2 = ¥0.036
- 1000 output tokens = $0.015 × 7.2 = ¥0.108

## 价格参考

### 国内模型价格（人民币）

| 模型 | 输入 (¥/1K) | 输出 (¥/1K) | 币种 |
|------|------------|------------|------|
| deepseek-chat | 0.0001 | 0.0002 | CNY |
| deepseek-reasoner | 0.0004 | 0.0016 | CNY |
| glm-4 | 0.001 | 0.001 | CNY |
| qwen-turbo | 0.0003 | 0.0006 | CNY |

### 国外模型价格（美元）

| 模型 | 输入 ($/1K) | 输出 ($/1K) | 币种 | 人民币等价 |
|------|------------|------------|------|-----------|
| claude-sonnet-4-6 | 0.003 | 0.015 | USD | ¥0.0216, ¥0.108 |
| claude-opus-4-6 | 0.015 | 0.075 | USD | ¥0.108, ¥0.54 |
| gpt-4o | 0.005 | 0.015 | USD | ¥0.036, ¥0.108 |
| gpt-4o-mini | 0.00015 | 0.0006 | USD | ¥0.00108, ¥0.00432 |

## 常见问题

### Q1: 如何判断模型是国内还是国外？

**国内模型**:
- 提供商在中国大陆（DeepSeek, 智谱, 阿里云等）
- 官方价格以人民币标注
- 示例: DeepSeek, GLM, Qwen

**国外模型**:
- 提供商在海外（OpenAI, Anthropic, Google等）
- 官方价格以美元标注
- 示例: Claude, GPT, Gemini

### Q2: 如果选错币种会怎样？

- **国内模型选了 USD**: 用户会多付 7.2 倍（系统会按美元转人民币）
- **国外模型选了 CNY**: 用户会少付 7.2 倍（系统不会转换汇率）

**重要**: 请务必选择正确的币种！

### Q3: 汇率是固定的吗？

当前汇率固定为 **1 USD = 7.2 CNY**

如需修改汇率，请联系技术人员修改 `backend/src/utils/billing.js` 中的 `EXCHANGE_RATE` 常量。

### Q4: 如何修改已有模型的币种？

1. 进入"模型管理"
2. 点击模型的"编辑"按钮
3. 修改"价格币种"字段
4. 点击"保存"

**注意**: 修改币种后，新的调用会按新币种计费，历史记录不会改变。

### Q5: 如何查看模型的实际人民币价格？

在模型列表中：
- **CNY 模型**: 显示 ¥ 符号，价格即为人民币
- **USD 模型**: 显示 $ 符号，实际扣费 = 价格 × 7.2

示例:
- `$0.003/1K` → 实际扣费 `¥0.0216/1K`
- `¥0.0001/1K` → 实际扣费 `¥0.0001/1K`

## 技术细节

### 数据库字段

```sql
price_currency ENUM('CNY', 'USD') DEFAULT 'CNY'
```

### 计费逻辑

```javascript
function calculateCost(promptTokens, completionTokens, inputPrice, outputPrice, currency = 'CNY') {
  const costInOriginalCurrency = (promptTokens * inputPrice + completionTokens * outputPrice) / 1000;

  // 如果是美元，转换为人民币
  if (currency === 'USD') {
    return costInOriginalCurrency * 7.2;
  }

  return costInOriginalCurrency;
}
```

### API 接口

**创建模型**:
```bash
POST /api/admin/models
{
  "model_id": "new-model",
  "display_name": "新模型",
  "provider": "provider",
  "input_price_per_1k": 0.001,
  "output_price_per_1k": 0.002,
  "price_currency": "CNY",  // 或 "USD"
  "upstream_endpoint": "https://api.example.com",
  "upstream_key": "your-key"
}
```

**更新模型**:
```bash
PUT /api/admin/models/:id
{
  "input_price_per_1k": 0.001,
  "output_price_per_1k": 0.002,
  "price_currency": "USD",  // 修改币种
  "status": "active"
}
```

## 相关文档

- `dual_currency_billing.md` - 双币种计费系统详细文档
- `token_comparison_test.md` - Token 统计对比测试
- `claude_integration_test.md` - Claude API 集成测试

## 联系支持

如有问题，请联系技术支持或查看相关文档。
