# AI Gateway - 多协议兼容 API 网关

`api.yunjunet.cn` 是一个专业的 AI 接口网关，**兼容 OpenAI、Gemini、Anthropic 三种主流协议**，提供统一的多上游路由、智能 Key 管理、计费系统和会员订阅。

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-blue.svg)](https://expressjs.com/)
[![MySQL](https://img.shields.io/badge/MySQL-8.0-orange.svg)](https://www.mysql.com/)
[![Redis](https://img.shields.io/badge/Redis-6.0-red.svg)](https://redis.io/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 🌟 核心特性

### 🔄 多协议兼容
- **OpenAI 协议** - 完全兼容 OpenAI API 格式，支持 `/v1/chat/completions`、`/v1/models` 等标准端点
- **Gemini 协议** - 支持 Google Gemini API 格式，`/v1beta/models` 端点
- **Anthropic 协议** - 支持 Anthropic Claude API 原生格式（包括 Claude Code CLI）

### 🚀 智能路由
- **多上游负载均衡** - 同一模型可配置多个上游服务商，支持加权轮询
- **自动故障转移** - 上游 Key 限流或失效时自动切换
- **Key 状态监控** - 实时监控上游 Key 健康状态

### 💳 灵活计费
- **双余额体系** - Token 计费（语言/视觉模型）+ 按次计费（特定模型）
- **实时扣费** - 请求完成后立即扣费，支持精确到小数点
- **请求日志** - 完整的计费记录和用量统计

### 🔐 安全可靠
- **API Key 认证** - 支持 `Authorization: Bearer` 和 `x-api-key` 两种方式
- **JWT 用户认证** - 安全的用户会话管理
- **请求队列** - 防止并发过载的自我保护机制
- **速率限制** - 可配置的请求频率限制

---

## 📡 支持的 API 端点

| 协议 | 端点 | 说明 |
|------|------|------|
| OpenAI | `POST /v1/chat/completions` | 对话完成接口（流式/非流式） |
| OpenAI | `GET /v1/models` | 获取可用模型列表 |
| OpenAI | `GET /v1beta/models` | Gemini 兼容接口 |
| Anthropic | `POST /v1/messages` | Claude API 原生格式 |
| Internal | `POST /v1/internal/*` | 内部服务接口 |

---

## 🔧 快速开始

### 环境要求
- Node.js 18+
- MySQL 8.0+
- Redis 6.0+

### 1. 克隆项目

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
cp backend/.env.example backend/.env
# 编辑 backend/.env 文件，配置数据库、Redis、JWT 密钥等
```

### 4. 启动服务

```bash
# 开发模式（热重载）
cd backend && npm run dev

# 生产模式（使用 PM2）
cd backend && npm start
```

### 5. 验证服务

```bash
curl http://localhost:3000/api/health
```

---

## ⚙️ 环境变量配置

创建 `backend/.env` 文件：

```env
# 数据库配置
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=wechat_cms

# JWT 密钥（必须修改）
JWT_SECRET=your-random-jwt-secret-key-minimum-32-chars

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

## 🗄️ 数据库结构

### 核心数据表

| 表名 | 用途 |
|------|------|
| `openclaw_models` | AI 模型目录（model_id、price、provider、category） |
| `openclaw_model_upstreams` | 每个模型的上游配置（base_url、api_key、weight） |
| `openclaw_api_keys` | 用户 API Key（hash 存储） |
| `openclaw_quota` | Token 余额（按语言/视觉/代码模型分类） |
| `openclaw_wallet` | 钱包余额（按次计费模型） |
| `openclaw_packages` | 订阅套餐配置 |
| `openclaw_user_packages` | 用户订阅记录 |
| `openclaw_request_logs` | 请求计费日志（含 prompt、completion 统计） |

---

## 🔌 插件系统

项目采用插件化架构，AI 网关功能以插件形式实现。

### 插件目录结构

```
backend/src/plugins/
├── ai-gateway/          # AI 网关核心插件
│   ├── routes/          # OpenAI/Gemini/Anthropic 兼容路由
│   ├── middleware/      # 认证、计费、限流中间件
│   └── utils/           # 计费、缓存、调试工具
├── planet/              # planet 子站插件
├── fubao/               # 福报子站插件
└── ...                  # 其他插件
```

### 创建新插件

1. 复制模板目录:

插件目录: `backend/src/plugins/`

每个插件需要包含：
- `plugin.json` - 插件元信息
- `routes.js` - Express Router 导出
- `migrate.js` - 数据库迁移（可选）

### 创建新插件

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

## 🚀 部署

### 生产环境部署

```bash
# 1. 确保环境变量配置正确
cp backend/.env.example backend/.env
# 编辑 backend/.env

# 2. 安装生产依赖
cd backend && npm install --production

# 3. 使用 PM2 启动服务（4 个集群实例）
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

## 💼 商业授权

本项目为开源项目，**免费用于个人学习和非商业用途**。

如需用于商业场景（企业内部分享、对外提供服务、二次开发后销售等），请联系作者获取商业授权：

📧 **邮箱**: [2743319061@qq.com](mailto:2743319061@qq.com)

商业授权包含：
- 完整源代码使用权
- 技术支持服务
- 定制化开发咨询
- 商业部署保障

---

## 📖 开发指南

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

## 📚 相关文档

- **详细说明**: [CLAUDE.md](CLAUDE.md) - 项目架构、插件系统、核心机制
- **快速上手**: [QUICK-START.md](QUICK-START.md) - 部署和配置指南
- **API 参考**: [OpenAI API 文档](https://platform.openai.com/docs/api-reference) - 标准接口规范

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本项目
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

---

## 📄 使用协议

本项目采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)（署名-非商业性使用）协议。

### ✅ 允许（需署名）

- **个人使用** - 学习、研究、个人项目
- **教育用途** - 教学、学术研究
- **非商业组织** - 非营利机构、开源社区项目
- **修改与再分发** - 基于本项目的二次开发（必须保持相同协议）

**要求：**
- 必须适当署名原作者（yunjunet）
- 必须注明是否对原作品进行了修改
- 不得用于商业目的

### ❌ 禁止

- **商业使用** - 任何以盈利为目的的使用场景
- **企业内部分享** - 公司、团队内部的生产环境使用
- **SaaS 服务** - 基于本项目提供在线服务或API收费
- **二次开发销售** - 直接销售或作为付费产品的一部分

### 💼 商业授权

如需用于商业场景，请联系作者获取商业授权：

📧 [2743319061@qq.com](mailto:2743319061@qq.com)

商业授权包含：
- 完整源代码使用权
- 技术支持服务
- 定制化开发咨询
- 商业部署保障

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本项目
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

---

## 🔗 相关链接

- **项目主页**: https://api.yunjunet.cn
- **用户控制台**: https://api.yunjunet.cn/console.html
- **管理后台**: https://api.yunjunet.cn/admin.html
- **GitHub**: https://github.com/chatgpt-yunju/ownapi
