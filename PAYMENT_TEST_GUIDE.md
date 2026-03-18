# OpenClaw AI 支付宝支付测试指南

## 系统架构

- **主站**: https://yunjunet.cn (端口 3000) - 提供 SSO 认证和用户管理
- **OpenClaw API**: https://api.yunjunet.cn (端口 3021) - 提供 AI 模型 API 和套餐购买
- **认证方式**: 使用主站的 SSO Token
- **用户表**: 共用主站的 `users` 表
- **余额系统**: 使用 `balance_logs` 表（最新记录的 balance_after）

## 测试前准备

### 1. 获取 SSO Token

访问 https://yunjunet.cn 并登录，然后：

1. 打开浏览器开发者工具 (F12)
2. 切换到 Console 标签
3. 输入: `localStorage.getItem('token')`
4. 复制返回的 token 值（包括引号内的内容）

### 2. 查看当前余额

```bash
# 使用 SSO Token 查看用户信息
curl -X GET https://api.yunjunet.cn/api/user/info \
  -H "Authorization: Bearer YOUR_SSO_TOKEN"
```

## 测试方案

### 方案 A: 使用自动化脚本测试

```bash
cd /home/ubuntu/api_yunjunet_cn

# 使用你的 SSO Token 运行测试
./test_payment_with_sso.sh 'YOUR_SSO_TOKEN' 2

# 参数说明:
# - 第一个参数: SSO Token（必填）
# - 第二个参数: 套餐 ID（可选，默认 2 = Pro 套餐）
```

脚本会自动：
1. 验证 Token 并显示用户信息
2. 查看套餐列表
3. 创建支付订单
4. 显示支付链接（如果需要支付宝支付）
5. 等待支付完成后查询订单状态
6. 显示生成的 API 密钥

### 方案 B: 使用浏览器手动测试

#### 步骤 1: 登录主站

1. 访问 https://yunjunet.cn
2. 使用已有账号登录（admin 或 user001）

#### 步骤 2: 访问 OpenClaw 控制台

1. 访问 https://api.yunjunet.cn/console.html
2. 系统会自动使用主站的 SSO Token 进行认证
3. 查看仪表盘，确认余额显示正确

#### 步骤 3: 购买套餐

1. 点击左侧菜单的"套餐"
2. 选择要购买的套餐（建议先测试 Pro ¥129）
3. 点击"购买"按钮
4. 系统会显示支付信息：
   - 如果余额充足：直接扣除余额，弹出 API Key
   - 如果余额不足：显示余额抵扣金额和需支付金额，跳转支付宝

#### 步骤 4: 完成支付（如果需要）

1. 在支付宝页面扫码支付
2. 支付完成后，页面会自动跳转回控制台
3. 系统会自动创建 API 密钥

#### 步骤 5: 查看 API 密钥

1. 点击左侧菜单的"API Keys"
2. 查看新创建的密钥
3. 复制完整的 API Key

#### 步骤 6: 测试模型调用

```bash
./test_model_call.sh YOUR_API_KEY
```

## 测试场景

### 场景 1: 完全余额支付

**测试用户**: admin (余额 ¥129.99)

**步骤**:
1. 使用 admin 账号登录主站
2. 获取 SSO Token
3. 运行测试脚本或访问控制台
4. 购买 Pro 套餐 (¥129)

**预期结果**:
- 直接扣除余额 ¥129
- 不跳转支付宝
- 立即生成 API 密钥
- 余额变为 ¥0.99

**验证**:
```sql
-- 查看订单
SELECT * FROM recharge_orders WHERE user_id = 1 ORDER BY created_at DESC LIMIT 1;
-- 应该显示: amount=129, balance_used=129, actual_paid=0, status='paid'

-- 查看余额变化
SELECT * FROM balance_logs WHERE user_id = 1 ORDER BY created_at DESC LIMIT 2;

-- 查看 API 密钥
SELECT * FROM openclaw_api_keys WHERE user_id = 1 ORDER BY created_at DESC LIMIT 1;
```

### 场景 2: 混合支付

**测试用户**: user001 (余额 ¥10.00)

**步骤**:
1. 使用 user001 账号登录主站
2. 获取 SSO Token
3. 运行测试脚本或访问控制台
4. 购买 Pro 套餐 (¥129)

**预期结果**:
- 提示余额抵扣 ¥10
- 需支付 ¥119
- 跳转支付宝支付 ¥119
- 支付完成后生成 API 密钥
- 余额变为 ¥0

**验证**:
```sql
-- 查看订单
SELECT * FROM recharge_orders WHERE user_id = 2 ORDER BY created_at DESC LIMIT 1;
-- 应该显示: amount=129, balance_used=10, actual_paid=119, status='paid'
```

### 场景 3: 完全支付宝支付

**测试用户**: 创建新用户或使用余额为 0 的用户

**步骤**:
1. 在主站注册新用户
2. 获取 SSO Token
3. 运行测试脚本或访问控制台
4. 购买 Pro 套餐 (¥129)

**预期结果**:
- 余额抵扣 ¥0
- 需支付 ¥129
- 跳转支付宝支付 ¥129
- 支付完成后生成 API 密钥

**验证**:
```sql
-- 查看订单
SELECT * FROM recharge_orders WHERE out_trade_no = 'YOUR_ORDER_NO';
-- 应该显示: amount=129, balance_used=0, actual_paid=129, status='paid'
```

## 套餐信息

| 套餐 | 价格 | 每日限额 | 月度配额 (USD) |
|------|------|----------|----------------|
| Free | ¥0 | 20 | 0.00 |
| Pro | ¥129 | 5000 | 50.00 |
| Max | ¥499 | 20000 | 200.00 |
| Ultra | ¥1699 | 99999 | 800.00 |

## API 接口

### 1. 获取用户信息
```bash
GET /api/user/info
Authorization: Bearer SSO_TOKEN
```

### 2. 查看套餐列表
```bash
GET /api/package/list
Authorization: Bearer SSO_TOKEN
```

### 3. 创建支付订单
```bash
POST /api/payment/create-package
Authorization: Bearer SSO_TOKEN
Content-Type: application/json

{
  "package_id": 2
}
```

### 4. 查询订单状态
```bash
GET /api/payment/order/:out_trade_no
Authorization: Bearer SSO_TOKEN
```

### 5. 查看 API 密钥列表
```bash
GET /api/api-key/list
Authorization: Bearer SSO_TOKEN
```

### 6. 调用模型
```bash
POST /v1/chat/completions
Authorization: Bearer API_KEY
Content-Type: application/json

{
  "model": "claude-sonnet-4-6",
  "messages": [
    {"role": "user", "content": "你好"}
  ]
}
```

## 数据库验证

### 查看用户余额
```sql
SELECT bl.user_id, u.username, bl.balance_after as balance
FROM balance_logs bl
JOIN users u ON bl.user_id = u.id
WHERE bl.id IN (SELECT MAX(id) FROM balance_logs GROUP BY user_id)
ORDER BY bl.user_id;
```

### 查看订单记录
```sql
SELECT * FROM recharge_orders
WHERE user_id = YOUR_USER_ID
ORDER BY created_at DESC
LIMIT 5;
```

### 查看 API 密钥
```sql
SELECT ak.*, p.name as package_name
FROM openclaw_api_keys ak
LEFT JOIN openclaw_packages p ON ak.package_id = p.id
WHERE ak.user_id = YOUR_USER_ID
ORDER BY ak.created_at DESC;
```

### 查看用户套餐
```sql
SELECT up.*, p.name as package_name
FROM openclaw_user_packages up
JOIN openclaw_packages p ON up.package_id = p.id
WHERE up.user_id = YOUR_USER_ID
ORDER BY up.started_at DESC;
```

### 查看调用日志
```sql
SELECT * FROM openclaw_call_logs
WHERE user_id = YOUR_USER_ID
ORDER BY created_at DESC
LIMIT 10;
```

## 常见问题

### 1. Token 验证失败

**原因**: SSO Token 过期或无效

**解决方案**:
- 重新登录主站获取新的 Token
- 检查 Token 是否完整复制

### 2. 支付回调未收到

**原因**: 支付宝回调地址配置错误或网络问题

**解决方案**:
- 检查支付宝配置: `SELECT * FROM settings WHERE key LIKE 'alipay%';`
- 查看后端日志: `pm2 logs openclaw-backend`
- 手动查询支付宝订单状态

### 3. API 密钥未生成

**原因**: 订单状态未更新为 'paid' 或用户已有 10 个密钥

**解决方案**:
- 检查订单状态: `SELECT * FROM recharge_orders WHERE out_trade_no = 'XXX';`
- 检查密钥数量: `SELECT COUNT(*) FROM openclaw_api_keys WHERE user_id = X AND status = 'active';`
- 查看后端日志

### 4. 余额未扣除

**原因**: 数据库事务失败或余额计算错误

**解决方案**:
- 查看 balance_logs 表最新记录
- 检查后端日志
- 手动补充余额日志

## 测试检查清单

- [ ] 主站 SSO 认证正常
- [ ] 控制台可以正常访问
- [ ] 用户信息显示正确
- [ ] 余额显示正确
- [ ] 套餐列表显示正确
- [ ] 完全余额支付（余额 ≥ 套餐价格）
- [ ] 混合支付（0 < 余额 < 套餐价格）
- [ ] 完全支付宝支付（余额 = 0）
- [ ] 支付回调正确处理
- [ ] API 密钥正确生成
- [ ] 套餐信息正确关联
- [ ] 余额正确扣除
- [ ] 订单记录完整
- [ ] 模型调用成功
- [ ] 计费正确扣除

## 下一步

测试完成后，请记录：
1. 每个场景的测试结果
2. 遇到的问题和解决方案
3. 需要优化的地方
4. 用户体验反馈
