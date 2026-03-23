#!/bin/bash

TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwidXNlcm5hbWUiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiIsImlhdCI6MTc3MzgxNDYxNSwiZXhwIjoxNzc2NDA2NjE1fQ.3smf1yJmIZLL7n6UIyEw7zpHurSUVzyVkv6f6qsmWBE"
BASE_URL="http://localhost:3021"

echo "========================================="
echo "测试新添加的 API 接口"
echo "========================================="
echo ""

echo "=== 1. 测试统计接口 ==="
curl -s "$BASE_URL/api/logs/statistics" \
  -H "Authorization: Bearer $TOKEN" | jq '.'
echo ""

echo "=== 2. 测试邀请码接口 ==="
curl -s "$BASE_URL/api/user-extend/invite" \
  -H "Authorization: Bearer $TOKEN" | jq '.'
echo ""

echo "=== 3. 测试奖励列表接口 ==="
curl -s "$BASE_URL/api/user-extend/rewards" \
  -H "Authorization: Bearer $TOKEN" | jq '.'
echo ""

echo "=== 4. 测试通知列表接口 ==="
curl -s "$BASE_URL/api/user-extend/notifications" \
  -H "Authorization: Bearer $TOKEN" | jq '.'
echo ""

echo "=== 5. 测试加油包充值接口 ==="
curl -s -X POST "$BASE_URL/api/payment/create-recharge" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount":50}' | jq '.'
echo ""

echo "========================================="
echo "测试完成"
echo "========================================="
