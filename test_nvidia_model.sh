#!/bin/bash

# NVIDIA 模型测试脚本

echo "========================================="
echo "NVIDIA 模型测试"
echo "========================================="
echo ""

# 检查参数
if [ -z "$1" ]; then
  echo "用法: $0 <API_KEY> [model_id]"
  echo ""
  echo "可用模型："
  echo "  - meta/llama-3.1-405b-instruct (最强大)"
  echo "  - meta/llama-3.1-70b-instruct (平衡)"
  echo "  - meta/llama-3.1-8b-instruct (快速)"
  echo "  - mistralai/mistral-large-2-instruct"
  echo "  - mistralai/mixtral-8x7b-instruct-v0.1"
  echo ""
  echo "示例: $0 'sk-xxx' 'meta/llama-3.1-8b-instruct'"
  exit 1
fi

API_KEY="$1"
MODEL="${2:-meta/llama-3.1-8b-instruct}"

echo "测试模型: $MODEL"
echo "API Key: ${API_KEY:0:15}..."
echo ""

# 测试请求
echo "发送测试请求..."
RESPONSE=$(curl -s -X POST http://localhost:3021/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"你好，请用一句话介绍你自己\"}],
    \"max_tokens\": 100
  }")

echo "$RESPONSE" | jq '.'

# 检查是否成功
if echo "$RESPONSE" | jq -e '.choices[0].message.content' > /dev/null 2>&1; then
  echo ""
  echo "✅ 测试成功！"
  echo ""
  echo "回复内容："
  echo "$RESPONSE" | jq -r '.choices[0].message.content'
  echo ""
  echo "Token 使用："
  echo "$RESPONSE" | jq '.usage'
else
  echo ""
  echo "❌ 测试失败"
  echo "错误信息："
  echo "$RESPONSE" | jq -r '.error.message // .error // .'
fi

echo ""
echo "========================================="
