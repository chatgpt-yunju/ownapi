# OpenClaw AI 控制台功能说明

## ✅ 已添加的功能

### 1. 概览
- **仪表盘** - 显示余额、今日调用、tokens、费用等核心数据
- **数据统计** - 详细的统计数据，包括总调用次数、总费用、模型分布等

### 2. 套餐
- **套餐商城** - 查看和购买套餐（Free/Pro/Max/Ultra）
- **加油包** - 快速充值余额（¥50/¥100/¥500/¥1000）

### 3. 密钥管理
- **API Keys** - 创建、查看、启用/禁用、删除 API 密钥
- **调用日志** - 查看 API 调用历史，支持按模型和状态筛选

### 4. 邀请奖励
- **邀请码** - 生成和分享邀请码，查看邀请统计和记录
- **我的奖励** - 查看累计奖励、已领取、待领取的奖励

### 5. 其他
- **消息通知** - 查看系统通知和消息
- **API 调试** - 在线测试 API 调用

## 菜单结构

```
概览
├── 📊 仪表盘
└── 📊 数据统计

套餐
├── 📦 套餐商城
└── ⚡ 加油包

密钥管理
├── 🔑 API Keys
└── 📝 调用日志

邀请奖励
├── 🎁 邀请码
└── 💰 我的奖励

其他
├── 🔔 消息通知
└── 🧪 API 调试

管理后台（仅管理员）
└── ⚙️ 管理面板
```

## 功能详情

### 数据统计
- 总调用次数
- 总 Tokens 使用量
- 总费用
- 平均费用
- 模型使用分布图表
- 近30天趋势图表
- 刷新按钮

### 加油包
提供4种充值选项：
- **小额充值**: ¥50 - 适合轻度使用
- **标准充值**: ¥100 - 最受欢迎
- **大额充值**: ¥500 - 送 ¥50 额外余额
- **超值充值**: ¥1000 - 送 ¥150 额外余额

### 邀请码
- 显示个人邀请码
- 一键复制邀请码
- 邀请统计：
  - 邀请人数
  - 累计奖励
  - 待发放奖励
- 邀请记录列表

### 我的奖励
- 累计奖励金额
- 已领取金额
- 待领取金额
- 奖励记录详情（时间、类型、金额、说明、状态）

### 消息通知
- 显示所有通知消息
- 标记已读/未读
- 一键全部标记为已读
- 空状态提示

## 后端 API 需求

为了支持这些新功能，需要以下后端接口：

### 统计相关
```
GET /api/logs/statistics
返回: {
  total_calls: number,
  total_tokens: number,
  total_cost: number,
  avg_cost: number
}
```

### 充值相关
```
POST /api/payment/create-recharge
参数: { amount: number }
返回: { payUrl: string, out_trade_no: string }
```

### 邀请相关
```
GET /api/user/invite
返回: {
  invite_code: string,
  invite_count: number,
  total_rewards: number,
  pending_rewards: number,
  invites: [
    {
      username: string,
      created_at: string,
      status: string,
      reward: number
    }
  ]
}
```

### 奖励相关
```
GET /api/user/rewards
返回: {
  total: number,
  received: number,
  pending: number,
  rewards: [
    {
      created_at: string,
      type: string,
      amount: number,
      description: string,
      status: string
    }
  ]
}
```

### 通知相关
```
GET /api/user/notifications
返回: {
  notifications: [
    {
      title: string,
      content: string,
      is_read: boolean,
      created_at: string
    }
  ]
}

POST /api/user/notifications/read-all
标记所有通知为已读
```

## 使用说明

1. **访问控制台**: https://api.yunjunet.cn/console.html
2. **登录**: 使用主站 SSO 登录
3. **导航**: 点击左侧菜单切换不同功能页面
4. **刷新数据**: 部分页面提供刷新按钮

## 注意事项

1. 所有新功能都需要对应的后端 API 支持
2. 如果后端 API 未实现，前端会显示错误提示
3. 邀请码、奖励、通知等功能需要数据库表支持
4. 加油包充值会调用支付宝支付接口

## 下一步

需要实现以下后端功能：
1. ✅ 套餐购买和支付（已完成）
2. ⏳ 加油包充值接口
3. ⏳ 邀请码系统
4. ⏳ 奖励系统
5. ⏳ 通知系统
6. ⏳ 详细统计接口

## 测试

访问控制台后，你应该能看到：
- ✅ 左侧菜单包含所有新增的功能项
- ✅ 点击菜单项可以切换页面
- ✅ 每个页面都有对应的 UI 界面
- ⚠️ 部分功能可能显示"加载失败"（因为后端 API 未实现）
