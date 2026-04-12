# OpenClaw 教程中心实施计划

## 目标
将 clawcn.net 抓取的 278 篇文档导入网站，创建独立的教程中心页面 `/tutorials.html`。

## 架构方案
- **数据库存储**：新建 `openclaw_tutorials` 表存储教程内容
- **后端 API**：新增教程路由，提供列表/详情/搜索接口
- **前端页面**：创建 `public/tutorials.html`，支持分类浏览、搜索、侧边栏导航

## 实施步骤

### Step 1: 数据库表
在 `ai-gateway/migrate.js` 中添加 `openclaw_tutorials` 表：
- `id` INT AUTO_INCREMENT
- `slug` VARCHAR(200) UNIQUE — URL 路径标识
- `title` VARCHAR(300) — 标题
- `category` VARCHAR(50) — 分类（guides/channels/tools/providers 等）
- `subcategory` VARCHAR(100) — 子分类（可选）
- `content` MEDIUMTEXT — Markdown 内容
- `source_url` VARCHAR(500) — 原始 URL
- `sort_order` INT DEFAULT 0
- `status` ENUM('active','hidden') DEFAULT 'active'
- `created_at`, `updated_at`

### Step 2: 后端 API
新增路由文件或在现有路由中添加：
- `GET /api/tutorials` — 列表（支持 ?category=&search=&page=&limit=）
- `GET /api/tutorials/categories` — 分类列表及计数
- `GET /api/tutorials/:slug` — 获取单篇教程内容

### Step 3: 数据导入脚本
编写 Node.js 脚本将 `/tmp/clawcn_clean.json` 导入数据库。

### Step 4: 前端 tutorials.html
- 左侧分类侧边栏（折叠分组）
- 右侧内容区（教程列表 / 教程详情）
- 顶部搜索框
- 响应式设计，复用现有 CSS 风格
- Markdown 渲染用 marked.js

### Step 5: 导航更新
在 navbar 中添加"教程"链接。

## 涉及文件
1. `backend/src/plugins/ai-gateway/migrate.js` — 新增表
2. `backend/src/plugins/ai-gateway/routes/` — 新增教程路由（或在现有路由中）
3. `public/tutorials.html` — 新建前端页面
4. `public/index.html`, `public/docs.html` — 添加导航链接
5. 导入脚本（一次性）
