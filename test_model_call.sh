#!/bin/bash

# 模型调用测试脚本
BASE_URL="https://api.yunjunet.cn"

echo "========================================="
echo "OpenClaw API 模型调用测试"
echo "========================================="
echo ""

# 检查参数
if [ -z "$1" ]; then
  echo "用法: $0 <API_KEY>"
  echo "示例: $0 sk-xxxxx"
  exit 1
fi

API_KEY="$1"

echo "使用 API Key: ${API_KEY:0:10}..."
echo ""

# 测试 1: 调用 Claude Sonnet 4.6
echo "测试 1: 调用 Claude Sonnet 4.6"
echo "-----------------------------------"
RESPONSE=$(curl -s -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [
      {"role": "user", "content": "你好，请用一句话介绍你自己"}
    ],
    "max_tokens": 100
  }')

echo "响应: $RESPONSE"
echo ""

# 测试 2: 调用 DeepSeek
echo "测试 2: 调用 DeepSeek"
echo "-----------------------------------"
RESPONSE=$(curl -s -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      {"role": "user", "content": "1+1等于几？"}
    ],
    "max_tokens": 50
  }')

echo "响应: $RESPONSE"
echo ""

# 测试 3: 查看 API 密钥信息
echo "测试 3: 查看 API 密钥信息"
echo "-----------------------------------"
echo "请在数据库中查询："
echo "SELECT * FROM openclaw_api_keys WHERE key_display LIKE '${API_KEY:0:10}%';"
echo ""

# 测试 4: 查看调用日志
echo "测试 4: 查看最近的调用日志"
echo "-----------------------------------"
echo "请在数据库中查询："
echo "SELECT * FROM openclaw_call_logs ORDER BY created_at DESC LIMIT 5;"
echo ""

echo "========================================="
echo "测试完成"
echo "========================================="
