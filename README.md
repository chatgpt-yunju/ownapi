# AI Gateway - OpenAI 兼容 API 网关

一个 OpenAI 兼容的 AI 网关 + 内容管理系统。

## 在线演示

**Demo**: https://api.yunjunet.cn

## 主要功能

- OpenAI/Gemini 兼容的 AI 代理（多上游路由、API Key 管理、计费）
- 会员订阅与套餐管理
- 多子站内容管理

## 项目结构

```
├── backend/          # Express 后端
│   ├── src/
│   │   ├── routes/   # API 路由
│   │   ├── plugins/  # 插件系统
│   │   └── ...
│   └── package.json
├── public/           # 静态前端页面
└── scripts/          # 工具脚本
```

## 快速开始

```bash
# 安装依赖
cd backend && npm install

# 开发模式
cd backend && npm run dev

# 生产启动
cd backend && npm start
```

## 技术栈

- 后端: Node.js + Express
- 数据库: MySQL
- 缓存: Redis
- 前端: 原生 HTML/JS

## 许可证

MIT
