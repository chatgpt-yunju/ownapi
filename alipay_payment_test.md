# OpenClaw AI 支付宝支付测试文档

## 实施完成情况

### ✅ 已完成

1. **数据库迁移**
   - 更新套餐价格为 CC Club 价格（Free/Pro ¥129/Max ¥499/Ultra ¥1699）
   - 修改 `recharge_orders` 表，添加字段：
     - `balance_used`: 使用的余额
     - `actual_paid`: 实际支付金额
     - `package_id`: 套餐ID
     - `alipay_trade_no`: 支付宝交易号
   - 支付宝配置已存在于 `settings` 表

2. **后端实现**
   - ✅ 创建 `/backend/src/utils/alipay.js` - 支付宝工具函数
   - ✅ 创建 `/backend/src/routes/payment.js` - 支付路由
   - ✅ 注册路由到 `server.js`
   - ✅ 安装 `alipay-sdk` 依赖
   - ✅ 修复 `chat.js` 语法错误
   - ✅ 服务已成功重启

3. **前端实现**
   - ✅ 修改 `/public/js/api.js` - 添加支付API
   - ✅ 修改 `/public/console.html` - 更新购买逻辑

### 核心功能

#### 1. 余额优先抵扣
- 购买套餐时自动计算余额抵扣
- 余额充足：直接扣除余额，立即发放 API Key
- 余额不足：部分余额 + 支付宝支付
- 余额为0：完全支付宝支付

#### 2. 支付宝支付
- PC端：使用 `alipay.trade.page.pay`（新窗口打开）
- 移动端：使用 `alipay.trade.wap.pay`（H5支付）
- 支持异步回调验证签名
- 支付成功后自动发放 API Key

#### 3. 订单管理
- 订单状态：pending（待支付）、paid（已支付）、failed（失败）
- 记录余额使用和实际支付金额
- 支持订单查询

## API 接口

### 1. 创建套餐购买订单
```http
POST /api/payment/create-package
Authorization: Bearer {token}
Content-Type: application/json

{
  "package_id": 2
}
```

**响应（完全使用余额）**：
```json
{
  "success": true,
  "paid_by_balance": true,
  "api_key": "sk-oc-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "key_display": "sk-oc-xxxxx...xxxxx",
  "message": "已使用余额 ¥129 购买 Pro 套餐"
}
```

**响应（需要支付宝支付）**：
```json
{
  "success": true,
  "paid_by_balance": false,
  "payUrl": "https://openapi.alipay.com/gateway.do?...",
  "mobile": false,
  "out_trade_no": "1710729600000123456",
  "amount": 129.00,
  "balance_used": 50.00,
  "need_pay": 79.00
}
```

### 2. 支付宝异步回调
```http
POST /payment/alipay/notify
Content-Type: application/x-www-form-urlencoded

out_trade_no=1710729600000123456&trade_no=2024031822001234567890&trade_status=TRADE_SUCCESS&...
```

### 3. 查询订单状态
```http
GET /api/payment/order/{out_trade_no}
Authorization: Bearer {token}
```

**响应**：
```json
{
  "id": 123,
  "out_trade_no": "1710729600000123456",
  "alipay_trade_no": "2024031822001234567890",
  "user_id": 1,
  "amount": 129.00,
  "balance_used": 50.00,
  "actual_paid": 79.00,
  "package_id": 2,
  "status": "paid",
  "created_at": "2024-03-18T10:00:00.000Z",
  "paid_at": "2024-03-18T10:05:00.000Z"
}
```

## 测试步骤

### 测试1：完全使用余额购买
1. 确保用户余额 ≥ 套餐价格（例如余额 ¥150，购买 Pro ¥129）
2. 访问 https://api.yunjunet.cn/console.html
3. 点击"套餐"页面
4. 点击"购买"按钮
5. 确认购买
6. **预期结果**：
   - 直接扣除余额 ¥129
   - 弹出 API Key 显示框
   - 余额更新为 ¥21
   - 订单状态为 `paid`

### 测试2：部分使用余额购买
1. 确保用户余额 < 套餐价格（例如余额 ¥50，购买 Pro ¥129）
2. 访问 https://api.yunjunet.cn/console.html
3. 点击"套餐"页面
4. 点击"购买"按钮
5. 确认购买
6. **预期结果**：
   - 提示"请在新窗口完成支付（余额抵扣 ¥50，需支付 ¥79）"
   - 新窗口打开支付宝支付页面
   - 扫码支付 ¥79
   - 支付成功后页面自动刷新
   - 余额更新为 ¥0
   - 获得 API Key

### 测试3：完全使用支付宝购买
1. 确保用户余额 = ¥0
2. 购买 Pro 套餐（¥129）
3. **预期结果**：
   - 跳转支付宝支付 ¥129
   - 支付成功后获得 API Key

### 测试4：移动端支付
1. 使用手机浏览器访问 https://api.yunjunet.cn/console.html
2. 购买套餐
3. **预期结果**：
   - 跳转到支付宝 H5 支付页面
   - 支付成功后返回

## 数据库验证

### 查看订单记录
```sql
SELECT * FROM recharge_orders WHERE order_type = 'package' ORDER BY created_at DESC LIMIT 10;
```

### 查看余额日志
```sql
SELECT * FROM balance_logs WHERE type = 'buy_quota' ORDER BY created_at DESC LIMIT 10;
```

### 查看用户套餐
```sql
SELECT * FROM openclaw_user_packages ORDER BY id DESC LIMIT 10;
```

### 查看 API Keys
```sql
SELECT * FROM openclaw_api_keys ORDER BY id DESC LIMIT 10;
```

## 支付宝配置

当前配置（从 settings 表读取）：
- `alipay_app_id`: 2021004100670333
- `alipay_private_key`: 已配置
- `alipay_public_key`: 已配置
- `alipay_notify_url`: https://api.yunjunet.cn/payment/alipay/notify
- `alipay_return_url`: https://api.yunjunet.cn/console.html?payment=success

## 注意事项

1. **回调地址**：确保 `https://api.yunjunet.cn/payment/alipay/notify` 可以被支付宝服务器访问
2. **签名验证**：支付回调必须验证签名，防止伪造
3. **幂等性**：支付回调可能重复，需要检查订单状态
4. **10密钥上限**：购买套餐时检查密钥上限，超过则拒绝购买
5. **事务保证**：所有涉及余额和订单的操作都使用数据库事务

## 故障排查

### 问题1：支付宝回调失败
- 检查回调地址是否可访问
- 检查签名验证是否通过
- 查看 pm2 日志：`pm2 logs openclaw-backend`

### 问题2：订单状态未更新
- 检查支付宝回调是否成功
- 查询订单表：`SELECT * FROM recharge_orders WHERE out_trade_no = 'xxx'`
- 检查是否有数据库事务回滚

### 问题3：API Key 未创建
- 检查是否达到10密钥上限
- 查看 openclaw_api_keys 表
- 检查 openclaw_user_packages 表

## 服务状态

- 服务名称：`openclaw-backend`
- 端口：3021
- 状态：✅ 运行中
- 重启命令：`pm2 restart openclaw-backend`
- 日志命令：`pm2 logs openclaw-backend`

## 下一步

1. 测试完整支付流程
2. 验证余额抵扣逻辑
3. 测试移动端支付
4. 验证支付回调
5. 检查订单和 API Key 创建
