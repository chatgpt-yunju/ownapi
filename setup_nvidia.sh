#!/bin/bash

# NVIDIA 模型接入脚本

echo "========================================="
echo "NVIDIA 模型接入配置"
echo "========================================="
echo ""

# 检查参数
if [ -z "$1" ]; then
  echo "用法: $0 <NVIDIA_API_KEY>"
  echo ""
  echo "获取 API Key 的步骤："
  echo "1. 访问 https://build.nvidia.com/"
  echo "2. 注册/登录账号"
  echo "3. 访问 https://build.nvidia.com/settings/api-keys"
  echo "4. 点击 'Generate API Key' 生成密钥"
  echo "5. 复制生成的 API Key（格式: nvapi-xxx）"
  echo ""
  echo "示例: $0 'nvapi-xxxxxxxxxx'"
  exit 1
fi

NVIDIA_API_KEY="$1"

echo "配置 NVIDIA API Key: ${NVIDIA_API_KEY:0:15}..."
echo ""

# 1. 更新 settings 表
echo "1. 更新数据库配置..."
mysql -u root wechat_cms <<EOF
INSERT INTO settings (\`key\`, \`value\`, description)
VALUES ('nvidia_api_key', '$NVIDIA_API_KEY', 'NVIDIA API Key')
ON DUPLICATE KEY UPDATE \`value\` = '$NVIDIA_API_KEY';
EOF

if [ $? -eq 0 ]; then
  echo "✅ API Key 配置成功"
else
  echo "❌ API Key 配置失败"
  exit 1
fi

# 2. 添加模型配置
echo ""
echo "2. 添加 NVIDIA 模型..."
mysql -u root wechat_cms <<'EOF'
INSERT INTO openclaw_models (
  model_id,
  display_name,
  provider,
  upstream_endpoint,
  input_price_per_1k,
  output_price_per_1k,
  status,
  sort_order
) VALUES
('meta/llama-3.1-405b-instruct', 'Llama 3.1 405B Instruct', 'nvidia',
 'https://integrate.api.nvidia.com/v1', 0.003600, 0.003600, 'active', 200),
('meta/llama-3.1-70b-instruct', 'Llama 3.1 70B Instruct', 'nvidia',
 'https://integrate.api.nvidia.com/v1', 0.000360, 0.000360, 'active', 201),
('meta/llama-3.1-8b-instruct', 'Llama 3.1 8B Instruct', 'nvidia',
 'https://integrate.api.nvidia.com/v1', 0.000144, 0.000144, 'active', 202),
('mistralai/mistral-large-2-instruct', 'Mistral Large 2', 'nvidia',
 'https://integrate.api.nvidia.com/v1', 0.002160, 0.002160, 'active', 203),
('mistralai/mixtral-8x7b-instruct-v0.1', 'Mixtral 8x7B', 'nvidia',
 'https://integrate.api.nvidia.com/v1', 0.000360, 0.000360, 'active', 204)
ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  upstream_endpoint = VALUES(upstream_endpoint),
  input_price_per_1k = VALUES(input_price_per_1k),
  output_price_per_1k = VALUES(output_price_per_1k);
EOF

if [ $? -eq 0 ]; then
  echo "✅ 模型配置成功"
else
  echo "❌ 模型配置失败"
  exit 1
fi

# 3. 查看已添加的模型
echo ""
echo "3. 已添加的 NVIDIA 模型："
mysql -u root wechat_cms -e "SELECT model_id, display_name, input_price_per_1k, output_price_per_1k, status FROM openclaw_models WHERE provider = 'nvidia';"

echo ""
echo "========================================="
echo "✅ NVIDIA 模型接入完成"
echo "========================================="
echo ""
echo "下一步："
echo "1. 重启服务: pm2 restart openclaw-backend"
echo "2. 测试模型: ./test_nvidia_model.sh"
echo ""
