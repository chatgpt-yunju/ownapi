# 🤖 AI Gateway 管理配置面板

## 📋 概述

**AI Gateway 配置面板** 是一个可视化 Web 界面，用于管理 AI 网关的所有配置变量，无需编辑代码文件。

---

## 🚀 快速开始

### 访问地址

```
http://localhost:3000/api/plugins/ai-gateway/admin
```

或者 (如果直接访问 admin 路径)

```
http://your-domain/api/plugins/ai-gateway/admin
```

---

## 📊 功能模块

### 1. 总览 Dashboard

**显示内容：**
- ✅ 上游 Endpoint 总数
- ✅ 活跃 Endpoint 数量
- ✅ 今日请求数量
- ✅ 系统健康率
- ✅ 实时系统日志

### 2. Endpoint 管理

**功能：**
- ✅ 添加上游 Endpoint
- ✅ 编辑 Endpoint 配置
- ✅ 删除 Endpoint
- ✅ 测试 Endpoint 连通性
- ✅ 启用/禁用 Endpoint
- ✅ 查看权重分配

**配置项：**
| 字段 | 说明 | 示例 |
|------|------|------|
| 提供商名称 | 上游提供商 | OpenAI, Claude, Gemini |
| Base URL | API 基础地址 | https://api.openai.com/v1 |
| API Key | 认证密钥 | sk-... |
| 权重 | 流量分配权重 | 100 |
| 优先级 | 优先级排序 | 0 |
| 启用状态 | 是否启用 | 启用/禁用 |

### 3. 调度配置

**可配置项：**

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 调度算法 | weighted | weighted / round-robin / least-connections |
| 最大并发数 | 10 | 单 Endpoint 最大并发 |
| 熔断触发阈值 | 5 | 连续失败次数 |
| 熔断持续时间 | 60000ms | 熔断恢复时间 |
| 健康检查 | ✅ | 自动健康检查开关 |
| 熔断保护 | ✅ | 熔断开关 |

**调度算法说明：**
- **weighted**: 加权轮询，按权重分配请求
- **round-robin**: 简单轮询，均匀分配
- **least-connections**: 最少连接，优先选择连接数少的
- **health-weighted**: 健康加权，根据健康状态动态调整权重

### 4. 限流配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 启用限流 | ✅ | 限流开关 |
| 每分钟请求数 | 60 | rpm 限制 |
| 突发容量 | 10 | 允许的突发请求 |

### 5. 缓存配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 启用缓存 | ✅ | 缓存开关 |
| 缓存时间 | 600s | 缓存有效期 |
| 最大条目数 | 1000 | 缓存条目上限 |

### 6. 模型映射

**功能：**
- ✅ 添加模型映射
- ✅ 编辑映射关系
- ✅ 配置上游模型ID
- ✅ 设置模型参数

**示例：**
```
本地模型: gpt-4
上游提供商: OpenAI
上游模型ID: gpt-4-turbo
```

### 7. 日志配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 日志级别 | info | debug/info/warn/error |
| 日志轮转 | 7d | 每天/每周/每月 |
| 保存请求日志 | ✅ | 记录请求详情 |
| 保存响应日志 | ❌ | 记录响应内容 |

---

## 🔧 API 接口

### 获取配置
```
GET /gateway/admin/api/config
```

**返回：**
```json
{
  "endpoints": {
    "maxInflight": 10,
    "failureThreshold": 5,
    ...
  },
  "scheduler": { ... },
  "rateLimit": { ... },
  ...
}
```

### 更新配置
```
POST /gateway/admin/api/config
Content-Type: application/json

{
  "scheduler": {
    "algorithm": "weighted",
    "maxInflight": 20
  }
}
```

### 获取 Endpoint 列表
```
GET /gateway/admin/api/endpoints
```

### 添加 Endpoint
```
POST /gateway/admin/api/endpoints
Content-Type: application/json

{
  "provider_name": "OpenAI",
  "base_url": "https://api.openai.com/v1",
  "api_key": "sk-...",
  "weight": 100,
  "is_enabled": 1
}
```

### 更新 Endpoint
```
PUT /gateway/admin/api/endpoints/:id
```

### 删除 Endpoint
```
DELETE /gateway/admin/api/endpoints/:id
```

### 测试 Endpoint
```
POST /gateway/admin/api/endpoints/:id/test
```

**返回：**
```json
{
  "success": true,
  "latency": 156,
  "message": "Endpoint is healthy"
}
```

### 获取统计
```
GET /gateway/admin/api/stats
```

**返回：**
```json
{
  "endpoints": {
    "total": 10,
    "active": 8,
    "disabled": 2
  },
  "today": {
    "requests": 1523
  }
}
```

---

## 💾 数据存储

### 配置文件
- **路径**: `backend/src/plugins/ai-gateway/config/system-config.json`
- **格式**: JSON
- **用途**: 存储系统配置

### 数据库表
- **openclaw_model_upstreams**: 存储 Endpoint 信息
- **openclaw_request_logs**: 请求日志（自动清理30天前）

---

## 🔒 安全说明

1. **API Key 存储**
   - Endpoint 的 API Key 存储在数据库中
   - 建议使用环境变量或密钥管理服务

2. **访问控制**
   - 建议添加 IP 白名单
   - 生产环境配置 HTTPS

3. **日志敏感信息**
   - 默认不保存响应日志
   - API Key 在日志中脱敏显示

---

## 📱 使用流程

### Step 1: 访问配置面板

```
http://localhost:3000/api/plugins/ai-gateway/admin
```

### Step 2: 配置 Endpoint

1. 点击 "Endpoint" 标签
2. 点击 "+ 添加上游 Endpoint"
3. 填写信息：
   - 提供商名称: OpenAI
   - Base URL: https://api.openai.com/v1
   - API Key: sk-...
   - 权重: 100
4. 点击 "保存"

### Step 3: 配置调度策略

1. 点击 "调度配置" 标签
2. 选择算法: Weighted
3. 设置参数
4. 点击 "保存配置"

### Step 4: 测试连通性

1. 返回 "Endpoint" 标签
2. 点击 "测试" 按钮
3. 查看延迟和状态

### Step 5: 监控运行

1. 返回 "总览" 标签
2. 查看实时统计数据
3. 查看系统日志

---

## 🛠️ 配置示例

### 双上游配置 (OpenAI + Claude)

**Endpoint 1:**
```
提供商: OpenAI
URL: https://api.openai.com/v1
Key: sk-openai-xxx
权重: 60
```

**Endpoint 2:**
```
提供商: Claude
URL: https://api.anthropic.com
Key: sk-claude-xxx
权重: 40
```

**调度算法:** Weighted

**结果:** 60% 流量 -> OpenAI, 40% 流量 -> Claude

### 启用熔断保护

```json
{
  "endpoints": {
    "failureThreshold": 3,
    "circuitOpenMs": 30000
  },
  "scheduler": {
    "circuitBreaker": true
  }
}
```

**效果:** 连续3次失败后熔断30秒，自动切换到健康 Endpoint

---

## 📊 监控指标

### 实时监控
- Endpoint 可用性
- 响应延迟
- 错误率
- 熔断状态
- QPS (每秒查询数)

### 历史数据
- 请求总数
- 成功/失败次数
- 平均延迟
- 峰值流量

---

## 🎨 界面预览

### 总览页面
```
┌─────────────────────────────────────┐
│  AI Gateway 管理配置面板            │
├─────────────────────────────────────┤
│  [Endpoint] [调度配置] [限流] ...   │
├─────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐          │
│  │  Endpoints│ │   Active  │          │
│  │    10    │ │     8     │          │
│  └──────────┘ └──────────┘          │
│  ┌──────────┐ ┌──────────┐          │
│  │  Requests│ │ Health Rate│          │
│  │   1523   │ │    80%    │          │
│  └──────────┘ └──────────┘          │
├─────────────────────────────────────┤
│  系统日志:                          │
│  [2024-01-15 10:23:45] ...          │
└─────────────────────────────────────┘
```

---

## 🆘 故障排查

### 问题1: 配置面板打不开

```bash
# 检查服务是否运行
curl http://localhost:3000/api/plugins/ai-gateway/admin

# 查看路由是否正确挂载
# 检查 backend/src/plugins/ai-gateway/routes.js
```

### 问题2: Endpoint 测试失败

**检查:**
- ✅ Base URL 是否正确
- ✅ API Key 是否有效
- ✅ 网络是否可达
- ✅ 提供商服务是否正常

### 问题3: 调度不生效

**检查:**
- ✅ Endpoint 是否启用
- ✅ 权重是否正确设置
- ✅ 调度算法是否正确选择
- ✅ 是否有健康节点

### 问题4: 配置保存失败

**检查:**
- ✅ config 目录是否存在
- ✅ 文件权限是否正确
- ✅ 数据库连接是否正常

---

## 🔧 高级配置

### 自定义调度器

```javascript
// 在 upstreamScheduler.js 中添加
function customScheduler(endpoints, request) {
  // 自定义调度逻辑
  return selectEndpoint(endpoints);
}
```

### 添加新的推送渠道

```javascript
// 在 config.js 中添加
alerts: {
  custom: {
    enabled: false,
    url: '',
    name: '自定义推送'
  }
}
```

---

## 📚 相关文档

- API 文档: `/api/plugins/ai-gateway/admin/api/config`
- 健康检查: `/api/health`
- 指标监控: `/api/internal/metrics`

---

## ✅ 完成检查

- [x] 配置面板可访问
- [x] Endpoint 管理
- [x] 调度配置
- [x] 限流配置
- [x] 缓存配置
- [x] 模型映射
- [x] 日志配置
- [x] API 接口
- [x] 统计监控

---

## 💡 提示

1. **配置修改即时生效**: 无需重启服务
2. **批量操作**: 支持导入/导出配置
3. **自动备份**: 配置变更自动备份
4. **权限控制**: 建议配置访问权限

---

**AI Gateway 管理配置面板已就绪！** 🎉
