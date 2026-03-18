#!/bin/bash

# OpenClaw AI 支付接口测试脚本

echo "=== OpenClaw AI 支付接口测试 ==="
echo ""

# 测试健康检查
echo "1. 测试健康检查接口..."
curl -s http://localhost:3021/api/health | jq .
echo ""

# 测试套餐列表
echo "2. 测试套餐列表接口..."
curl -s http://localhost:3021/api/package/list \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" | jq .
echo ""

# 测试创建支付订单（需要替换 token）
echo "3. 测试创建支付订单接口（需要有效 token）..."
echo "请手动测试：curl -X POST http://localhost:3021/api/payment/create-package -H 'Authorization: Bearer YOUR_TOKEN' -H 'Content-Type: application/json' -d '{\"package_id\": 2}'"
echo ""

echo "=== 测试完成 ==="
echo ""
echo "提示："
echo "1. 请在浏览器中访问 https://api.yunjunet.cn/console.html 进行完整测试"
echo "2. 确保支付宝配置正确（settings 表）"
echo "3. 确保回调地址可访问：https://api.yunjunet.cn/payment/alipay/notify"
