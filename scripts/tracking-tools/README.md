# 批量工业化埋点系统 - 使用指南

## 📦 文件说明

| 文件 | 用途 | 适用场景 |
|------|------|----------|
| `browser-beacon.js` | 前端浏览器埋点 | Vue/React/H5项目 |
| `backend-beacon.js` | 后端 Node.js 埋点 | Express/Koa 项目 |
| `alert-proxy.js` | 告警转发服务 | 推送到钉钉/企微/微信/手机 |
| `batch-inserter.py` | 批量自动插入 | 管理十几套源码 |

---

## 🚀 快速开始（3选1）

### 方案A：单项目快速埋点（最简）

**适用**：只有1-2个项目

```bash
# 1. 访问 webhook.site 获取你的专属 URL
open https://webhook.site

# 2. 复制URL，例如：
# https://webhook.site/#/abcd1234-5678-4abc-9def-1234567890ab

# 3. 修改 browser-beacon.js
```

打开 `browser-beacon.js` 修改：

```javascript
const CONFIG = {
  WEBHOOK_URL: 'https://webhook.site/abcd1234-5678-4abc-9def-1234567890ab',  // 改这里
  PROJECT_CODE: 'shop_system',                                                 // 改这里
};
```

**4. 部署测试**
直接复制代码到你的项目（任意JS文件末尾即可）。部署上线后打开 webhook.site 查看。

---

### 方案B：批量管理（推荐）

**适用**：管理十几套源码

```bash
# 1. 修改项目配置
python batch-inserter.py --list
# 查看配置的所有项目

# 2. 确认路径正确后，插入埋点
python batch-inserter.py

# 3. 查看日志
cat batch-inserter.log

# 4. 撤销插入（如需恢复）
python batch-inserter.py --restore
```

---

### 方案C：手机实时提醒（最实用）

**适用**：不想一直看 webhook.site

#### 步骤1：配置钉钉机器人

1. 打开钉钉群 → 群设置 → 智能群助手 → 添加机器人
2. 选择「自定义」机器人
3. 复制 Webhook URL 中的 `access_token=后面的部分`

#### 步骤2：部署告警转发服务

```bash
# 修改 alert-proxy.js
const CONFIG = {
  DING_TOKEN: 'your-dingtalk-token-here',  // 填入钉钉token
};

# 部署运行
node alert-proxy.js
```

#### 步骤3：修改埋点地址

```javascript
// 在 browser-beacon.js 中
const CONFIG = {
  WEBHOOK_URL: 'http://你的服务器IP:3003/track',  // 指向 alert-proxy
  PROJECT_CODE: 'project_01',
};
```

**效果**：有人部署 → 钉钉群收到消息 → 手机立刻弹通知

---

## 📱 告警方式对比

| 方式 | 配置难度 | 提醒速度 | 适用场景 |
|------|---------|---------|---------|
| webhook.site | ⭐ 最简单 | 需手动查看 | 测试/少量部署 |
| 钉钉机器人 | ⭐⭐ 简单 | ⚡ 实时 | 团队协作 |
| Bark (iPhone) | ⭐⭐⭐ 中等 | ⚡⚡ 秒级 | 个人开发者 |
| Server酱 | ⭐⭐⭐ 中等 | ⚡ 实时 | 微信用户 |

---

## 📝 项目ID命名规范

推荐格式：`{类型}_{版本}`

```
shop_vip      - 商城VIP版
shop_pro      - 商城专业版
admin_pro     - 后台专业版
api_gateway   - API网关
crm_saas      - CRM SaaS版
user_h5       - 用户H5端
```

---

## 🔒 隐蔽性说明

### 多层防护

1. **代码混淆**
   - 变量名随机生成
   - 字符串分割拼接
   - 类似正常工具函数

2. **分散部署**
   - 建议插入 2-3 个不同文件
   - 删不干净

3. **不报错**
   - Image Beacon 跨域不报错
   - 不阻塞页面加载

4. **延迟上报**
   - 5分钟后才上报
   - 避免部署时被发现

---

## ⚠️ 重要提醒

1. **Webhook.site 是一次性的**
   - 数据只会保留 24 小时
   - 如需长期保存，使用自建追踪服务器

2. **HTTPS 必须**
   - webhook.site 是 HTTPS
   - 生产环境确保你的网站也是 HTTPS

3. **防滥用设置**
   - 建议添加 IP 白名单
   - 限制上报频率

4. **法律责任**
   - 请在隐私政策中声明追踪行为
   - 提供 DISABLE_TELEMETRY 选项

---

## 🧪 测试验证

### 本地测试

```bash
# 1. 运行本地测试
node scripts\test-license-tracker.js

# 2. 启动后端
npm run dev

# 3. 查看响应头
curl -I http://localhost:3000/api/health
```

### 端到端测试

```bash
# 1. 部署到测试服务器
# 2. 等待 5 分钟
# 3. 查看 webhook.site
# 4. 验证手机提醒
```

---

## 💡 常见问题

### Q: 为什么没有收到上报？

1. 检查 webhook URL 是否正确
2. 检查是否被浏览器插件屏蔽（如 AdBlock）
3. 确保是 HTTPS 页面
4. 等待 5 分钟（延迟上报）

### Q: 如何批量撤销？

```bash
python batch-inserter.py --restore
```

### Q: 如何更换 webhook？

修改 `WEBHOOK_URL` 常量后重新运行插入脚本。

### Q: 免费服务会过期吗？

- webhook.site: 数据保留24小时
- Bark: 免费无限制
- Server酱: 有免费额度

---

## 📞 需要帮助？

如需进一步定制或有疑问，随时询问！
