#!/bin/bash

# 支付宝支付测试脚本（使用主站 SSO）
BASE_URL="https://api.yunjunet.cn"
MAIN_SITE="https://yunjunet.cn"

echo "========================================="
echo "支付宝支付测试（使用主站 SSO）"
echo "========================================="
echo ""

# 检查参数
if [ -z "$1" ]; then
  echo "用法: $0 <SSO_TOKEN> [package_id]"
  echo ""
  echo "获取 SSO Token 的方法："
  echo "1. 访问 https://yunjunet.cn 并登录"
  echo "2. 打开浏览器开发者工具 (F12)"
  echo "3. 在 Console 中输入: localStorage.getItem('token')"
  echo "4. 复制 token 值"
  echo ""
  echo "示例: $0 'eyJhbGc...' 2"
  exit 1
fi

SSO_TOKEN="$1"
PACKAGE_ID="${2:-2}"  # 默认购买 Pro 套餐 (id=2)

echo "使用 SSO Token: ${SSO_TOKEN:0:20}..."
echo "购买套餐 ID: $PACKAGE_ID"
echo ""

# 1. 验证 Token 并获取用户信息
echo "1. 验证 Token 并获取用户信息..."
USER_INFO=$(curl -s -X GET "$BASE_URL/api/user/info" \
  -H "Authorization: Bearer $SSO_TOKEN")

echo "用户信息: $USER_INFO"
echo ""

# 检查是否成功
if echo "$USER_INFO" | grep -q "error"; then
  echo "❌ Token 验证失败，请检查 Token 是否正确"
  exit 1
fi

USERNAME=$(echo $USER_INFO | grep -o '"username":"[^"]*' | cut -d'"' -f4)
BALANCE=$(echo $USER_INFO | grep -o '"balance":[0-9.]*' | cut -d':' -f2)

echo "✅ 登录成功"
echo "用户名: $USERNAME"
echo "余额: ¥$BALANCE"
echo ""

# 2. 查看套餐列表
echo "2. 查看套餐列表..."
PACKAGES=$(curl -s -X GET "$BASE_URL/api/package/list" \
  -H "Authorization: Bearer $SSO_TOKEN")
echo "$PACKAGES" | python3 -m json.tool 2>/dev/null || echo "$PACKAGES"
echo ""

# 3. 创建支付订单
echo "3. 创建支付订单（套餐 ID: $PACKAGE_ID）..."
PAYMENT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/payment/create-package" \
  -H "Authorization: Bearer $SSO_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"package_id\": $PACKAGE_ID}")

echo "支付响应:"
echo "$PAYMENT_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$PAYMENT_RESPONSE"
echo ""

# 检查是否是完全余额支付
if echo "$PAYMENT_RESPONSE" | grep -q "paid_by_balance"; then
  echo "✅ 完全余额支付成功！"
  API_KEY=$(echo $PAYMENT_RESPONSE | grep -o '"api_key":"[^"]*' | cut -d'"' -f4)
  KEY_DISPLAY=$(echo $PAYMENT_RESPONSE | grep -o '"key_display":"[^"]*' | cut -d'"' -f4)
  echo "API Key: $API_KEY"
  echo "Key Display: $KEY_DISPLAY"
  echo ""
  echo "可以使用以下命令测试模型调用:"
  echo "./test_model_call.sh $API_KEY"
  exit 0
fi

# 提取支付链接
PAY_URL=$(echo $PAYMENT_RESPONSE | grep -o '"payUrl":"[^"]*' | cut -d'"' -f4 | sed 's/\\//g')
OUT_TRADE_NO=$(echo $PAYMENT_RESPONSE | grep -o '"out_trade_no":"[^"]*' | cut -d'"' -f4)
BALANCE_USED=$(echo $PAYMENT_RESPONSE | grep -o '"balance_used":[0-9.]*' | cut -d':' -f2)
NEED_PAY=$(echo $PAYMENT_RESPONSE | grep -o '"need_pay":[0-9.]*' | cut -d':' -f2)

if [ -n "$PAY_URL" ]; then
  echo "✅ 支付订单创建成功"
  echo "订单号: $OUT_TRADE_NO"
  echo "余额抵扣: ¥$BALANCE_USED"
  echo "需支付: ¥$NEED_PAY"
  echo ""
  echo "支付链接:"
  echo "$PAY_URL"
  echo ""
  echo "请在浏览器中打开以上链接进行支付"
  echo "或者访问控制台: https://api.yunjunet.cn/console.html"
  echo ""
  echo "支付完成后，按回车键查询订单状态..."
  read

  # 4. 查询订单状态
  echo "4. 查询订单状态..."
  for i in {1..10}; do
    ORDER_STATUS=$(curl -s -X GET "$BASE_URL/api/payment/order/$OUT_TRADE_NO" \
      -H "Authorization: Bearer $SSO_TOKEN")

    echo "[$i/10] 订单状态:"
    echo "$ORDER_STATUS" | python3 -m json.tool 2>/dev/null || echo "$ORDER_STATUS"

    STATUS=$(echo $ORDER_STATUS | grep -o '"status":"[^"]*' | cut -d'"' -f4)
    if [ "$STATUS" = "paid" ]; then
      echo ""
      echo "✅ 订单支付成功！"

      # 5. 查看 API 密钥
      echo ""
      echo "5. 查看 API 密钥..."
      API_KEYS=$(curl -s -X GET "$BASE_URL/api/api-key/list" \
        -H "Authorization: Bearer $SSO_TOKEN")
      echo "$API_KEYS" | python3 -m json.tool 2>/dev/null || echo "$API_KEYS"

      break
    fi

    if [ $i -lt 10 ]; then
      echo "等待 3 秒后重试..."
      sleep 3
    else
      echo ""
      echo "⚠️  订单仍未支付，请稍后在控制台查看"
    fi
  done
else
  echo "❌ 支付订单创建失败"
  echo "错误信息: $PAYMENT_RESPONSE"
fi

echo ""
echo "========================================="
echo "测试完成"
echo "========================================="
