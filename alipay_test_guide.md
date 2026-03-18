# 支付宝支付测试指南

## 测试环境

- **后端地址**: https://api.yunjunet.cn
- **前端地址**: https://api.yunjunet.cn/console.html
- **数据库**: wechat_cms
- **后端端口**: 3021

## 当前状态

### 套餐价格
| 套餐 | 价格 | 每日限额 | 月度配额 |
|------|------|----------|----------|
| Free | ¥0 | 20 | 0.00 |
| Pro | ¥129 | 5000 | 50.00 |
| Max | ¥499 | 20000 | 200.00 |
| Ultra | ¥1699 | 99999 | 800.00 |

### 现有用户
- **admin** (user_id=1): 余额 ¥99.99
- **user001** (user_id=2): 余额 ¥10.00

## 测试方案

### 方案 A: 使用自动化脚本测试

```bash
cd /home/ubuntu/api_yunjunet_cn
./test_alipay_payment.sh
```

脚本会自动：
1. 创建新测试用户
2. 查看套餐列表
3. 创建支付订单
4. 生成支付宝支付链接
5. 等待支付完成
6. 查询订单状态
7. 查看生成的 API 密钥

### 方案 B: 使用浏览器手动测试

#### 测试场景 1: 余额为 0，完全支付宝支付

1. **注册新用户**
   - 访问 https://api.yunjunet.cn/console.html
   - 点击"注册"，创建新账号
   - 登录后查看余额（应该为 ¥0）

2. **购买 Pro 套餐**
   - 点击"Pro 套餐"的"购买"按钮
   - 系统应该显示：需支付 ¥129
   - 点击确认后，会打开支付宝支付页面

3. **完成支付**
   - 在支付宝页面扫码支付
   - 支付完成后，页面会自动跳转回控制台

4. **验证结果**
   - 查看"我的 API 密钥"，应该有一个新的密钥
   - 密钥应该关联到 Pro 套餐
   - 每日限额应该是 5000
   - 月度配额应该是 50.00

#### 测试场景 2: 余额不足，混合支付

1. **给用户充值少量余额**
   ```sql
   -- 给 user001 充值 ¥50
   INSERT INTO balance_logs (user_id, amount, balance_before, balance_after, type, description)
   VALUES (2, 50, 10, 60, 'recharge', '测试充值');
   ```

2. **购买 Pro 套餐**
   - 使用 user001 登录
   - 点击"Pro 套餐"的"购买"按钮
   - 系统应该显示：
     - 余额抵扣：¥60
     - 需支付：¥69
   - 点击确认后，会打开支付宝支付页面（支付 ¥69）

3. **完成支付**
   - 支付 ¥69
   - 支付完成后，系统会：
     - 扣除余额 ¥60
     - 记录支付宝支付 ¥69
     - 创建 API 密钥

4. **验证结果**
   - 余额应该变为 ¥0
   - 应该有新的 API 密钥
   - 查看订单记录：
     - amount: 129.00
     - balance_used: 60.00
     - actual_paid: 69.00

#### 测试场景 3: 余额充足，完全余额支付

1. **给用户充值足够余额**
   ```sql
   -- 给 admin 用户已经有 ¥99.99，再充值 ¥30
   INSERT INTO balance_logs (user_id, amount, balance_before, balance_after, type, description)
   VALUES (1, 30, 99.994342, 129.994342, 'recharge', '测试充值');
   ```

2. **购买 Pro 套餐**
   - 使用 admin 登录
   - 点击"Pro 套餐"的"购买"按钮
   - 系统应该显示：
     - 余额抵扣：¥129
     - 需支付：¥0
   - 点击确认后，直接弹出 API 密钥（不跳转支付宝）

3. **验证结果**
   - 余额应该减少 ¥129
   - 应该有新的 API 密钥
   - 查看订单记录：
     - amount: 129.00
     - balance_used: 129.00
     - actual_paid: 0.00
     - status: paid

### 测试场景 4: 测试模型调用

1. **获取 API 密钥**
   - 从控制台复制完整的 API 密钥

2. **调用 Claude 模型**
   ```bash
   curl -X POST https://api.yunjunet.cn/v1/chat/completions \
     -H "Authorization: Bearer sk-xxxxx" \
     -H "Content-Type: application/json" \
     -d '{
       "model": "claude-sonnet-4-6",
       "messages": [
         {"role": "user", "content": "你好，请介绍一下你自己"}
       ]
     }'
   ```

3. **验证结果**
   - 应该返回 Claude 的回复
   - 查看 openclaw_call_logs 表，应该有调用记录
   - 查看 balance_logs 表，应该有扣费记录（如果使用余额计费）
   - 或者查看套餐的 monthly_quota 使用情况

## 数据库验证

### 查看订单记录
```sql
SELECT * FROM recharge_orders
WHERE user_id = 2
ORDER BY created_at DESC
LIMIT 5;
```

### 查看 API 密钥
```sql
SELECT ak.*, p.name as package_name
FROM openclaw_api_keys ak
LEFT JOIN openclaw_packages p ON ak.package_id = p.id
WHERE ak.user_id = 2
ORDER BY ak.created_at DESC;
```

### 查看用户套餐
```sql
SELECT up.*, p.name as package_name
FROM openclaw_user_packages up
JOIN openclaw_packages p ON up.package_id = p.id
WHERE up.user_id = 2
ORDER BY up.started_at DESC;
```

### 查看余额变化
```sql
SELECT * FROM balance_logs
WHERE user_id = 2
ORDER BY created_at DESC
LIMIT 10;
```

### 查看调用日志
```sql
SELECT * FROM openclaw_call_logs
WHERE api_key_id IN (
  SELECT id FROM openclaw_api_keys WHERE user_id = 2
)
ORDER BY created_at DESC
LIMIT 10;
```

## 支付宝沙箱测试

如果使用支付宝沙箱环境：

1. **沙箱账号**
   - 买家账号：在支付宝开放平台获取
   - 登录密码：111111
   - 支付密码：111111

2. **测试流程**
   - 扫码后使用沙箱买家账号登录
   - 输入支付密码完成支付
   - 支付成功后会触发回调

## 常见问题

### 1. 支付后没有收到回调
- 检查支付宝配置中的 notify_url 是否正确
- 查看后端日志：`pm2 logs openclaw-backend`
- 手动查询支付宝订单状态

### 2. API 密钥没有生成
- 检查订单状态是否为 'paid'
- 查看后端日志是否有错误
- 检查用户是否已有 10 个密钥（达到上限）

### 3. 模型调用失败
- 检查 API 密钥是否正确
- 检查套餐是否过期
- 检查每日限额是否用完
- 查看后端日志

## 测试检查清单

- [ ] 完全支付宝支付（余额=0）
- [ ] 混合支付（0 < 余额 < 套餐价格）
- [ ] 完全余额支付（余额 ≥ 套餐价格）
- [ ] 支付回调正确处理
- [ ] API 密钥正确生成
- [ ] 套餐信息正确关联
- [ ] 余额正确扣除
- [ ] 订单记录完整
- [ ] 模型调用成功
- [ ] 计费正确扣除
- [ ] 每日限额生效
- [ ] 月度配额生效
- [ ] 套餐过期处理

## 下一步

测试完成后，请记录：
1. 每个场景的测试结果
2. 遇到的问题和解决方案
3. 需要优化的地方
