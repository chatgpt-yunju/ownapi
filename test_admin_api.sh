#!/bin/bash

# 测试管理员 API - 添加模型（带币种）

echo "=== 测试添加模型（USD 币种）==="
curl -X POST http://localhost:3021/api/admin/models \
  -H "Content-Type: application/json" \
  -d '{
    "model_id": "test-usd-model",
    "display_name": "测试美元模型",
    "provider": "test",
    "input_price_per_1k": 0.005,
    "output_price_per_1k": 0.010,
    "price_currency": "USD"
  }'

echo -e "\n\n=== 查询新添加的模型 ==="
mysql -u root wechat_cms -e "SELECT id, model_id, display_name, price_currency FROM openclaw_models WHERE model_id='test-usd-model'"

echo -e "\n=== 测试更新模型（修改币种为 CNY）==="
MODEL_ID=$(mysql -u root wechat_cms -sN -e "SELECT id FROM openclaw_models WHERE model_id='test-usd-model'")
curl -X PUT http://localhost:3021/api/admin/models/$MODEL_ID \
  -H "Content-Type: application/json" \
  -d '{
    "input_price_per_1k": 0.001,
    "output_price_per_1k": 0.002,
    "price_currency": "CNY",
    "status": "active"
  }'

echo -e "\n\n=== 查询更新后的模型 ==="
mysql -u root wechat_cms -e "SELECT id, model_id, display_name, input_price_per_1k, output_price_per_1k, price_currency FROM openclaw_models WHERE model_id='test-usd-model'"

echo -e "\n=== 清理测试数据 ==="
mysql -u root wechat_cms -e "DELETE FROM openclaw_models WHERE model_id='test-usd-model'"
echo "✅ 测试完成"
