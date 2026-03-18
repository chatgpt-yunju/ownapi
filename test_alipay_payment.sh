#!/bin/bash

# 支付宝支付测试脚本
BASE_URL="https://api.yunjunet.cn"

echo "========================================="
echo "支付宝支付测试脚本"
echo "========================================="
echo ""

# 1. 创建测试用户
echo "1. 创建测试用户..."
REGISTER_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "test_alipay_'$(date +%s)'",
    "password": "test123456"
  }')

echo "注册响应: $REGISTER_RESPONSE"
TOKEN=$(echo $REGISTER_RESPONSE | grep -o '"token":"[^"]*' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "❌ 注册失败，请检查响应"
  exit 1
fi

echo "✅ 注册成功，Token: ${TOKEN:0:20}..."
echo ""

# 2. 查看用户信息
echo "2. 查看用户信息..."
USER_INFO=$(curl -s -X GET "$BASE_URL/api/user/info" \
  -H "Authorization: Bearer $TOKEN")
echo "用户信息: $USER_INFO"
echo ""

# 3. 查看套餐列表
echo "3. 查看套餐列表..."
PACKAGES=$(curl -s -X GET "$BASE_URL/api/packages" \
  -H "Authorization: Bearer $TOKEN")
echo "套餐列表: $PACKAGES"
echo ""

# 4. 测试场景 1: 余额为 0，购买 Pro 套餐（完全支付宝支付）
echo "4. 测试场景 1: 余额为 0，购买 Pro 套餐..."
PAYMENT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/payment/create-package" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"package_id": 2}')

echo "支付响应: $PAYMENT_RESPONSE"
echo ""

# 提取支付链接
PAY_URL=$(echo $PAYMENT_RESPONSE | grep -o '"payUrl":"[^"]*' | cut -d'"' -f4)
OUT_TRADE_NO=$(echo $PAYMENT_RESPONSE | grep -o '"out_trade_no":"[^"]*' | cut -d'"' -f4)

if [ -n "$PAY_URL" ]; then
  echo "✅ 支付链接生成成功"
  echo "支付链接: $PAY_URL"
  echo "订单号: $OUT_TRADE_NO"
  echo ""
  echo "请在浏览器中打开以下链接进行支付:"
  echo "$PAY_URL"
  echo ""
  echo "支付完成后，按回车键继续查询订单状态..."
  read

  # 5. 查询订单状态
  echo "5. 查询订单状态..."
  for i in {1..5}; do
    ORDER_STATUS=$(curl -s -X GET "$BASE_URL/api/payment/order/$OUT_TRADE_NO" \
      -H "Authorization: Bearer $TOKEN")
    echo "订单状态 (第 $i 次): $ORDER_STATUS"

    STATUS=$(echo $ORDER_STATUS | grep -o '"status":"[^"]*' | cut -d'"' -f4)
    if [ "$STATUS" = "paid" ]; then
      echo "✅ 订单支付成功！"
      break
    fi

    if [ $i -lt 5 ]; then
      echo "等待 3 秒后重试..."
      sleep 3
    fi
  done
  echo ""

  # 6. 查看 API 密钥
  echo "6. 查看 API 密钥..."
  API_KEYS=$(curl -s -X GET "$BASE_URL/api/keys" \
    -H "Authorization: Bearer $TOKEN")
  echo "API 密钥列表: $API_KEYS"
  echo ""

  # 7. 测试调用模型
  API_KEY=$(echo $API_KEYS | grep -o '"key_display":"[^"]*' | head -1 | cut -d'"' -f4 | sed 's/\.\.\.//')
  if [ -n "$API_KEY" ]; then
    echo "7. 测试调用模型..."
    echo "使用 API Key: $API_KEY..."

    # 获取完整的 API Key（需要从数据库或响应中获取）
    echo "注意：需要使用完整的 API Key 进行测试"
    echo "请从前端界面复制完整的 API Key"
  fi
else
  echo "❌ 支付链接生成失败"
fi

echo ""
echo "========================================="
echo "测试完成"
echo "========================================="
