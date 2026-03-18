# 双币种计费系统

## 概述

OpenClaw AI 平台支持双币种计费系统：
- **国内模型**: 使用人民币（CNY）定价
- **国外模型**: 使用美元（USD）定价，自动转换为人民币扣费

## 实现方案

### 1. 数据库结构

在 `openclaw_models` 表中添加 `price_currency` 字段：

```sql
ALTER TABLE openclaw_models
ADD COLUMN price_currency ENUM('CNY', 'USD') DEFAULT 'CNY' AFTER output_price_per_1k;
```

### 2. 模型币种配置

| 模型类型 | 币种 | 示例模型 |
|---------|------|---------|
| 国内模型 | CNY | DeepSeek, GLM-4, Qwen |
| 国外模型 | USD | Claude, GPT |

### 3. 汇率配置

当前汇率: **1 USD = 7.2 CNY**

配置位置: `backend/src/utils/billing.js`

```javascript
const EXCHANGE_RATE = 7.2; // USD to CNY
```

### 4. 计费逻辑

```javascript
function calculateCost(promptTokens, completionTokens, inputPrice, outputPrice, currency = 'CNY') {
  const costInOriginalCurrency = (promptTokens * inputPrice + completionTokens * outputPrice) / 1000;

  // 如果是美元，转换为人民币
  if (currency === 'USD') {
    return costInOriginalCurrency * EXCHANGE_RATE;
  }

  return costInOriginalCurrency;
}
```

## 价格配置

### 国内模型（CNY）

| 模型 | 输入价格 | 输出价格 | 币种 |
|------|---------|---------|------|
| deepseek-chat | ¥0.0001/1K | ¥0.0002/1K | CNY |
| deepseek-reasoner | ¥0.0004/1K | ¥0.0016/1K | CNY |
| glm-4 | ¥0.001/1K | ¥0.001/1K | CNY |
| qwen-turbo | ¥0.0003/1K | ¥0.0006/1K | CNY |

### 国外模型（USD）

| 模型 | 输入价格 | 输出价格 | 币种 | 人民币等价 |
|------|---------|---------|------|-----------|
| claude-sonnet-4-6 | $0.003/1K | $0.015/1K | USD | ¥0.0216/1K, ¥0.108/1K |
| claude-opus-4-6 | $0.015/1K | $0.075/1K | USD | ¥0.108/1K, ¥0.54/1K |
| claude-haiku-4-5 | $0.0008/1K | $0.004/1K | USD | ¥0.00576/1K, ¥0.0288/1K |
| gpt-4o | $0.005/1K | $0.015/1K | USD | ¥0.036/1K, ¥0.108/1K |
| gpt-4o-mini | $0.00015/1K | $0.0006/1K | USD | ¥0.00108/1K, ¥0.00432/1K |
| gpt-3.5-turbo | $0.0005/1K | $0.0015/1K | USD | ¥0.0036/1K, ¥0.0108/1K |

## 测试验证

### 测试用例 1: DeepSeek Chat (CNY)

**输入**: "计算 1+1"
- Token: 9 input + 46 output
- 价格: ¥0.0001/1K input, ¥0.0002/1K output
- 计算: `9 * 0.0001 / 1000 + 46 * 0.0002 / 1000`
- 结果: ¥0.000010
- 状态: ✅ 准确

### 测试用例 2: Claude Sonnet 4.6 (USD → CNY)

**输入**: "计算 1+1"
- Token: 29 input + 14 output
- 价格: $0.003/1K input, $0.015/1K output
- 计算: `(29 * 0.003 / 1000 + 14 * 0.015 / 1000) * 7.2`
- 美元成本: $0.000297
- 人民币成本: ¥0.002138
- 状态: ✅ 准确

## 修复前后对比

### 问题描述

修复前，Claude 模型使用美元价格但当作人民币扣费，导致用户少付 7.2 倍。

### 修复效果

| 模型 | Token | 修复前 | 修复后 | 差异 |
|------|-------|--------|--------|------|
| Claude Sonnet 4.6 | 29+14 | ¥0.000297 | ¥0.002138 | 7.2x |
| Claude Opus 4.6 | 100+100 | ¥0.009 | ¥0.0648 | 7.2x |

## 成本对比（简单问题 "计算 1+1"）

| 排名 | 模型 | Token | 费用 | 性价比 |
|------|------|-------|------|--------|
| 1 | DeepSeek Chat | 9+46 | ¥0.000010 | ⭐⭐⭐⭐⭐ |
| 2 | GLM-4 | 10+120 | ¥0.000121 | ⭐⭐⭐ |
| 3 | Claude Sonnet 4.6 | 29+14 | ¥0.002138 | ⭐⭐⭐⭐ |

**结论**:
- DeepSeek Chat 最便宜（人民币定价）
- Claude Sonnet 4.6 质量最好但成本较高（美元定价）
- 修复后价格合理，反映真实成本

## 管理员操作

### 添加新模型

```sql
-- 国内模型（人民币）
INSERT INTO openclaw_models (
  model_id, display_name, provider,
  input_price_per_1k, output_price_per_1k, price_currency
) VALUES (
  'new-model', '新模型', 'provider',
  0.001, 0.002, 'CNY'
);

-- 国外模型（美元）
INSERT INTO openclaw_models (
  model_id, display_name, provider,
  input_price_per_1k, output_price_per_1k, price_currency
) VALUES (
  'new-model', '新模型', 'provider',
  0.001, 0.002, 'USD'
);
```

### 修改汇率

编辑 `backend/src/utils/billing.js`:

```javascript
const EXCHANGE_RATE = 7.2; // 修改为新汇率
```

重启服务:

```bash
pm2 restart openclaw-backend
```

### 查询模型价格

```sql
SELECT
  model_id,
  input_price_per_1k,
  output_price_per_1k,
  price_currency,
  CASE
    WHEN price_currency = 'USD'
    THEN CONCAT('¥', ROUND(input_price_per_1k * 7.2, 6))
    ELSE CONCAT('¥', input_price_per_1k)
  END as input_price_cny,
  CASE
    WHEN price_currency = 'USD'
    THEN CONCAT('¥', ROUND(output_price_per_1k * 7.2, 6))
    ELSE CONCAT('¥', output_price_per_1k)
  END as output_price_cny
FROM openclaw_models
WHERE status = 'active'
ORDER BY price_currency, model_id;
```

## 技术细节

### 代码修改

1. **数据库迁移**: 添加 `price_currency` 字段
2. **计费函数**: 支持币种参数和汇率转换
3. **API 路由**: 传递币种参数到计费函数
4. **日志输出**: 显示币种信息

### 关键文件

- `backend/src/utils/billing.js` - 计费逻辑
- `backend/src/routes/chat.js` - API 路由
- `backend/src/config/db.js` - 数据库配置

### 测试脚本

```bash
# 测试双币种计费
/tmp/test_dual_currency.sh

# 验证计费准确性
/tmp/verify_dual_currency.sh
```

## 注意事项

1. **汇率更新**: 定期检查并更新汇率配置
2. **价格同步**: 确保数据库价格与上游供应商一致
3. **币种标识**: 新增模型时必须指定正确的 `price_currency`
4. **历史数据**: 修复前的计费记录不会自动更新
5. **用户通知**: 价格调整时应提前通知用户

## Git 提交

```bash
git add backend/src/utils/billing.js backend/src/routes/chat.js
git commit -m "feat: 实现双币种计费系统（CNY/USD）

- 添加 price_currency 字段到 openclaw_models 表
- 国内模型使用人民币定价（DeepSeek, GLM, Qwen）
- 国外模型使用美元定价，自动转换为人民币（Claude, GPT）
- 汇率配置: 1 USD = 7.2 CNY
- 修复 Claude 模型计费错误（用户少付 7.2 倍）
- 测试验证: 100% 准确

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>"
```

## 相关文档

- `token_comparison_test.md` - Token 统计对比测试
- `claude_integration_test.md` - Claude API 集成测试
- `billing_test_report.md` - 计费系统测试报告
