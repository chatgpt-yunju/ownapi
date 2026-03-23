# NVIDIA 模型接入指南

## 一、注册 NVIDIA 账号

1. 访问 [NVIDIA Build](https://build.nvidia.com/)
2. 点击右上角 "Sign In" 或 "Get Started"
3. 使用 Google/GitHub 账号或邮箱注册
4. 登录成功后进入控制台

## 二、获取 API Key

1. 访问 [API Keys 页面](https://build.nvidia.com/settings/api-keys)
2. 点击 "Generate API Key" 按钮
3. 复制生成的 API Key（格式：`nvapi-xxxxxxxxxx`）
4. **重要**：妥善保存 API Key，只显示一次

## 三、接入到 OpenClaw AI

### 方法 1: 使用自动化脚本（推荐）

```bash
./setup_nvidia.sh 'nvapi-xxxxxxxxxx'
```

### 方法 2: 手动配置

```bash
# 1. 执行 SQL 迁移
mysql -u root wechat_cms < backend/migrations/add_nvidia_models.sql

# 2. 更新 API Key（替换为你的实际 Key）
mysql -u root wechat_cms -e "
INSERT INTO settings (\`key\`, \`value\`, description)
VALUES ('nvidia_api_key', 'nvapi-xxxxxxxxxx', 'NVIDIA API Key')
ON DUPLICATE KEY UPDATE \`value\` = 'nvapi-xxxxxxxxxx';
"

# 3. 重启服务
pm2 restart openclaw-backend
```

## 四、测试模型

```bash
# 获取你的 OpenClaw API Key
API_KEY="sk-xxx"

# 测试 Llama 3.1 8B（快速便宜）
./test_nvidia_model.sh "$API_KEY" "meta/llama-3.1-8b-instruct"

# 测试 Llama 3.1 70B（平衡性能）
./test_nvidia_model.sh "$API_KEY" "meta/llama-3.1-70b-instruct"

# 测试 Llama 3.1 405B（最强大）
./test_nvidia_model.sh "$API_KEY" "meta/llama-3.1-405b-instruct"
```

## 五、已接入的模型

| 模型 ID | 名称 | 输入价格 | 输出价格 | 特点 |
|---------|------|----------|----------|------|
| `meta/llama-3.1-405b-instruct` | Llama 3.1 405B | ¥0.0036/1K | ¥0.0036/1K | 最强大 |
| `meta/llama-3.1-70b-instruct` | Llama 3.1 70B | ¥0.00036/1K | ¥0.00036/1K | 平衡 |
| `meta/llama-3.1-8b-instruct` | Llama 3.1 8B | ¥0.000144/1K | ¥0.000144/1K | 快速便宜 |
| `mistralai/mistral-large-2-instruct` | Mistral Large 2 | ¥0.00216/1K | ¥0.00216/1K | 高性能 |
| `mistralai/mixtral-8x7b-instruct-v0.1` | Mixtral 8x7B | ¥0.00036/1K | ¥0.00036/1K | MoE 架构 |

## 六、API 调用示例

```bash
curl -X POST http://localhost:3021/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta/llama-3.1-8b-instruct",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'
```

## 七、注意事项

1. **免费额度**：NVIDIA 提供免费的 API 调用额度用于测试
2. **速率限制**：免费账号有请求速率限制
3. **模型可用性**：部分模型可能需要申请访问权限
4. **价格**：以上价格为人民币，已按 1 USD = 7.2 CNY 换算

## 八、故障排查

### 问题 1: API Key 无效
- 检查 API Key 是否正确复制
- 确认 API Key 未过期
- 重新生成 API Key

### 问题 2: 模型不可用
- 检查模型 ID 是否正确
- 确认账号有访问该模型的权限
- 查看 NVIDIA 控制台的模型列表

### 问题 3: 请求失败
- 检查网络连接
- 查看服务日志：`pm2 logs openclaw-backend`
- 确认余额充足

## 相关链接

- [NVIDIA Build](https://build.nvidia.com/)
- [API Keys 管理](https://build.nvidia.com/settings/api-keys)
- [NVIDIA API 文档](https://docs.nvidia.com/rag/2.3.0/api-key.html)
