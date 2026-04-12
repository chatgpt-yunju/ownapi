# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

`api.yunjunet.cn` 是一个 OpenAI 兼容 AI 网关 + 内容管理系统，主要提供：
- OpenAI/Gemini 兼容的 AI 代理（多上游路由、API Key 管理、计费）
- CC Club 会员订阅与套餐管理
- 多子站内容管理（planet、fubao、opc、openclaw 等）

## 常用命令

```bash
# 后端开发
cd backend && npm run dev        # 开发模式（nodemon），端口 3000
cd backend && npm start          # 生产启动

# 生产重启
pm2 restart backend              # 重启所有 backend cluster 实例

# 测试接口
curl http://localhost:3000/api/health
```

**无前端构建步骤**：前端是 `public/` 下的静态 HTML，直接生效，无需构建。

## 架构

### 后端入口
- `backend/src/app.js` — Express 配置、中间件、路由挂载、插件加载
- 运行端口：3000，pm2 cluster 模式（4 个实例）

### 路由层级
1. **核心路由**（`backend/src/routes/`）：auth、users、content、categories、quota、pay、shop、admin 等 30+ 个模块
2. **AI Gateway 兼容路由**：`/v1/*`、`/v1beta/*`、`/api/models` 等直接映射到 `ai-gateway` 插件
3. **插件路由**（`/api/plugins/<name>/`）：通过插件系统自动加载

### 插件系统
插件目录：`backend/src/plugins/`，每个插件须包含：
- `plugin.json` — 元信息（name、routePrefix、quotaCost 等）
- `routes.js` — Express Router 导出
- `migrate.js`（可选）— 启动时自动执行的数据库迁移，签名：`async (db) => {}`

插件由 `backend/src/plugin-loader.js` 自动发现、写入 `plugins` 表、执行迁移、挂载路由。`_example` 目录是新插件模板。

**已有插件：**
| 插件 | 路由前缀 | 功能 |
|------|---------|------|
| `ai-gateway` | `/api/plugins/ai-gateway` + `/v1/*` | OpenAI/Gemini 兼容代理、计费、API Key 管理 |
| `planet` | `/api/plugins/planet` | planet.yunjunet.cn 子站 |
| `fubao` | `/api/plugins/fubao` | 福报子站 |
| `opc` | `/api/plugins/opc` | OPC 子站 |
| `openclaw-app` | `/api/plugins/openclaw-app` | Openclaw APP |
| `aijob` | `/api/plugins/aijob` | AI 求职助手 |
| `aikaoyan` | `/api/plugins/aikaoyan` | AI 考研 |
| `study-cases` | `/api/plugins/study-cases` | 学习案例 |
| `ai-image/video/meeting/ppt` | 各自前缀 | AI 多媒体功能 |

### AI Gateway 核心机制
- **双余额体系**：`openclaw_quota`（按 token 计费）和 `openclaw_wallet`（按次计费）
- **多上游路由**：`openclaw_model_upstreams` 表，同一模型可配多个上游并加权
- **缓存层**：Redis（优先）+ 内存降级，模型配置缓存 10 分钟，API Key 缓存 5 分钟
- **CC Club Key 守护**：`ccClubKeyGuard.js` 监控上游 key 限流，自动冷却与恢复
- **请求队列中间件**：`requestQueueMiddleware` 防止并发过载
- **调试追踪**：每个请求有 `aiGatewayRequestId`，通过 `requestDebug.js` 记录分步状态

### 数据库与缓存
- MySQL，库名：`wechat_cms`，localhost:3306，用户 root，无密码
- 连接池：委托给本地包 `yunjunet-common`（位于 `../../yunjunet-common`）
- 迁移方式：各文件启动时 `ALTER TABLE ... ADD COLUMN ... .catch(() => {})` 幂等执行
- Redis：localhost:6379（`REDIS_URL` 环境变量覆盖）

### 关键数据表
| 表名 | 用途 |
|------|------|
| `openclaw_models` | AI 模型目录（model_id、price、provider、category） |
| `openclaw_model_upstreams` | 每个模型的上游配置（base_url、api_key、weight） |
| `openclaw_api_keys` | 用户 API Key（hash 存储，`sk-` 前缀） |
| `openclaw_quota` | Token 余额（语言/视觉/代码模型） |
| `openclaw_wallet` | 钱包余额（按次计费模型） |
| `openclaw_packages` / `openclaw_user_packages` | 订阅套餐 |
| `openclaw_request_logs` | 请求计费日志 |
| `openclaw_ccclub_key_resets` | 上游 key 冷却记录 |
| `settings` | 键值配置（支付宝密钥、汇率、SMTP 等） |

### 认证体系
- **用户 JWT**（`backend/src/middleware/auth.js`）：Bearer token，存 `users` 表
- **API Key 认证**（`ai-gateway/middleware/apiKeyAuth.js`）：hash 比对，支持 `Authorization: Bearer` 或 `x-api-key`
- **内部服务认证**（`internalAuth.js`）：`/v1/internal/*` 路由专用

### 环境变量（`backend/.env`）
- `DB_HOST/USER/PASSWORD/NAME`（默认库名 `wechat_cms`）
- `JWT_SECRET`
- `REDIS_URL`（默认 `redis://127.0.0.1:6379`）
- `PORT`（默认 3000）
- `ALLOWED_ORIGINS`（逗号分隔 CORS 白名单）
- `DOUBAO_API_KEY`

### 前端
静态 HTML，目录 `public/`，无构建步骤：
- `console.html` — 用户控制台
- `admin.html` — 管理后台
- `index.html` — 主文档站

## 开发规范

### 添加新插件
1. 复制 `backend/src/plugins/_example/` 为新目录
2. 修改 `plugin.json`（name、routePrefix、displayName）
3. 实现 `routes.js`（导出 Express Router）
4. 可选 `migrate.js`（导出 `async (db) => {}`，每条 DDL 用 `.catch(() => {})` 包裹）
5. 重启 backend，插件自动注册

### 数据库迁移模式
```js
// 正确：幂等 ADD COLUMN
await db.query('ALTER TABLE foo ADD COLUMN bar VARCHAR(100)').catch(() => {});
// 禁止：DROP TABLE / DROP COLUMN / TRUNCATE
```

### 计费操作
使用 `ai-gateway/utils/billing.js` 的 `adjustBalance(userId, balanceType, delta, logType, desc)`：
- `balanceType = 'quota'`：按 token 扣费
- `balanceType = 'wallet'`：按次扣费

### 缓存失效
模型/上游配置变更后需手动清缓存：
```js
const cache = require('./utils/cache');
await cache.del(`model:${modelId}`);
await cache.delByPrefix('upstreams:');
