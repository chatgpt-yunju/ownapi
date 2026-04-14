# AI Gateway - OpenAI 兼容 API 网关

`api.yunjunet.cn` 是一个功能完善的 OpenAI 兼容 AI 网关 + 内容管理系统，支持多上游路由、API Key 管理、计费系统和会员订阅。

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-blue.svg)](https://expressjs.com/)
[![MySQL](https://img.shields.io/badge/MySQL-8.0-orange.svg)](https://www.mysql.com/)
[![Redis](https://img.shields.io/badge/Redis-6.0-red.svg)](https://redis.io/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 在线演示

**主站**: https://api.yunjunet.cn

**用户控制台**: https://api.yunjunet.cn/console.html

**管理后台**: https://api.yunjunet.cn/admin.html

---

## 主要功能

### 🤖 AI 网关
- **OpenAI/Gemini 兼容 API** - 完全兼容 OpenAI API 格式，支持 `/v1/chat/completions`、`/v1/models` 等端点
- **多上游路由** - 同一模型可配置多个上游服务商，支持加权负载均衡
- **智能 Key 管理** - 自动监控上游 Key 限流状态，智能冷却与恢复
- **双余额计费体系** - Token 计费（语言/视觉模型）+ 按次计费（特定模型）
- **请求队列** - 防止并发过载的自我保护机制

### 👥 用户系统
- **JWT 认证** - 安全的多端认证机制
- **API Key 管理** - 用户可创建和管理自己的 API Keys
- **会员订阅** - 支持多种套餐和订阅管理

### 📦 插件化架构
- **子站系统** - planet、fubao、opc、openclaw 等多子站管理
- **AI 应用** - 图像生成、视频生成、会议总结、PPT 生成等
- **求职助手** - AI 驱动的求职辅助功能

### 💰 支付系统
- **支付宝集成** - 支持国内主流支付方式
- **套餐管理** - 灵活的订阅套餐配置
- **钱包系统** - 充值和消费管理

---

## 项目结构

```
├── backend/                    # Express 后端
│   ├── src/
│   │   ├── app.js             # 应用入口
│   │   ├── routes/            # API 路由
│   │   ├── plugins/           # 插件系统
│   │   │   ├── ai-gateway/    # AI 网关插件
│   │   │   │   ├── routes/    # OpenAI/Gemini 兼容路由
│   │   │   │   ├── middleware/# 认证、计费、限流中间件
│   │   │   │   └── utils/     # 计费、缓存、调试工具
│   │   │   ├── planet/        # planet 子站插件
│   │   │   ├── fubao/         # 福报子站插件
│   │   │   └── ...            # 其他插件
│   │   ├── middleware/        # 全局中间件
│   │   └── utils/             # 通用工具
│   ├── .env                   # 环境变量配置
│   └── package.json
├── public/                    # 静态前端
│   ├── index.html            # 主站点
│   ├── console.html          # 用户控制台
│   └── admin.html            # 管理后台
├── scripts/                   # 工具脚本
└── api_yunjunet_cn/          # 部署目录
```

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Node.js + Express |
| 数据库 | MySQL 8.0 |
| 缓存 | Redis + LRU 内存缓存 |
| 前端 | 原生 HTML/CSS/JS |
| 进程管理 | PM2 |
| 支付 | 支付宝 SDK |

---

## 快速开始

### 环境要求

- Node.js 18+
- MySQL 8.0+
- Redis 6.0+

### 1. 克隆项目

```bash
git clone <repository-url>
cd ownapi
```

### 2. 安装依赖

```bash
cd backend && npm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，配置数据库、Redis、密钥等
```

### 4. 启动服务

```bash
# 开发模式
cd backend && npm run dev

# 生产模式 (使用 PM2)
cd backend && npm start
```

### 5. 验证服务

```bash
curl http://localhost:3000/api/health
```

---

## 环境变量配置

创建 `backend/.env` 文件：

```env
# 数据库配置
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=wechat_cms

# JWT 密钥
JWT_SECRET=your-jwt-secret-key

# Redis 配置
REDIS_URL=redis://127.0.0.1:6379

# 服务端口
PORT=3000

# CORS 白名单（逗号分隔）
ALLOWED_ORIGINS=http://localhost:3000,https://api.yunjunet.cn

# 豆包 API Key（可选）
DOUBAO_API_KEY=your-doubao-api-key
```

---

## AI Gateway 核心功能

### 支持的 API 端点

| 端点 | 说明 |
|------|------|
| `POST /v1/chat/completions` | OpenAI 标准对话接口 |
| `GET /v1/models` | 获取可用模型列表 |
| `GET /v1beta/models` | Google Gemini 兼容接口 |

### 认证方式

**方式 1: Bearer Token**
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

**方式 2: x-api-key**
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "x-api-key: sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### 核心数据表

| 表名 | 用途 |
|------|------|
| `openclaw_models` | AI 模型目录 |
| `openclaw_model_upstreams` | 上游服务商配置 |
| `openclaw_api_keys` | 用户 API Keys |
| `openclaw_quota` | Token 余额 |
| `openclaw_wallet` | 钱包余额 |
| `openclaw_packages` | 订阅套餐 |
| `openclaw_request_logs` | 请求计费日志 |

---

## 插件开发

插件目录: `backend/src/plugins/`

每个插件需要包含：
- `plugin.json` - 插件元信息
- `routes.js` - Express Router 导出
- `migrate.js` - 数据库迁移（可选）

### 创建新插件

1. 复制 `_example` 目录:
```bash
cp -r backend/src/plugins/_example backend/src/plugins/my-plugin
```

2. 修改 `plugin.json`:
```json
{
  "name": "my-plugin",
  "routePrefix": "/api/plugins/my-plugin",
  "displayName": "我的插件",
  "description": "插件描述"
}
```

3. 实现 `routes.js`:
```javascript
const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ message: 'Hello from my plugin' });
});

module.exports = router;
```

4. 重启服务，插件自动加载

---

## 部署

### 生产环境部署

```bash
# 1. 确保环境变量配置正确
cp backend/.env.example backend/.env
# 编辑 .env

# 2. 安装依赖
cd backend && npm install --production

# 3. 使用 PM2 启动服务
cd backend && npm start
# 或
pm2 start src/app.js --name backend -i 4

# 4. 配置 Nginx 反向代理
```

### Nginx 配置示例

```nginx
server {
    listen 80;
    server_name api.yunjunet.cn;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

---

## 开发指南

### 常用命令

```bash
# 开发模式
cd backend && npm run dev

# 生产启动
cd backend && npm start

# 重启 PM2 服务
pm2 restart backend

# 查看服务状态
pm2 status

# 查看日志
pm2 logs backend
```

### 数据库迁移

项目使用增量迁移模式：

```javascript
// migrate.js
module.exports = async (db) => {
  // 幂等操作: 添加列
  await db.query('ALTER TABLE foo ADD COLUMN bar VARCHAR(100)')
    .catch(() => {});
};
```

### 缓存失效

模型/上游配置变更后需手动清缓存：
```javascript
const cache = require('./utils/cache');
await cache.del(`model:${modelId}`);
await cache.delByPrefix('upstreams:');
```

---

## 文档

- [CLAUDE.md](CLAUDE.md) - 项目详细说明
- [QUICK-START.md](QUICK-START.md) - 快速上手指南
- [CONSOLE_INTEGRATION_COMPLETE.md](CONSOLE_INTEGRATION_COMPLETE.md) - 控制台集成说明
- [PAYMENT_TEST_GUIDE.md](PAYMENT_TEST_GUIDE.md) - 支付测试指南

---

## 贡献

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

---

## 许可证

[MIT](LICENSE) © yunjunet

---

## 相关链接

- **主站**: https://api.yunjunet.cn
- **用户控制台**: https://api.yunjunet.cn/console.html
- **管理后台**: https://api.yunjunet.cn/admin.html
- **API 文档**: https://platform.openai.com/docs/api-reference
