# GEO生成式引擎优化系统 — Roadmap

**Project:** GEO生成式引擎优化系统 (GEO SaaS Platform)
**Tech Stack:** Vue3 + SpringBoot 3.x + MySQL 8.0 + Redis 7.x + Docker
**Goal:** 构建多租户GEO SaaS管理平台，实现品牌在生成式AI平台的可见度诊断、监控、内容优化全链路

---

## Milestone 1: MVP核心系统 (4周)

### Phase 1: 基础架构与用户权限模块
**Goal:** 搭建项目基础架构，完成多租户用户权限体系，实现JWT鉴权、RBAC权限控制、版本配额管理
**Deliverables:**
- SpringBoot 3.x 项目骨架（多模块结构）
- Vue3 + Vite + Element Plus 前端骨架
- MySQL数据库初始化脚本（sys_tenant, sys_user, sys_role, sys_version等核心表）
- JWT鉴权拦截器、登录/注册/退出接口
- RBAC角色权限体系（超管/租户管理员/代理商/只读）
- 版本配额管理（月度诊断次数、监控个数、创作次数）
- Docker Compose基础部署配置
**Requirements:** REQ-001, REQ-002, REQ-003, REQ-004
**Plans:** 4 plans
- [x] 01-01-PLAN.md — SpringBoot多模块项目骨架、数据库初始化、异常处理 (✓ 2026-04-22)
- [ ] 01-02-PLAN.md — JWT鉴权、登录/注册/退出、密码加密、账号锁定
- [ ] 01-03-PLAN.md — RBAC权限体系、多租户隔离、权限检查
- [ ] 01-04-PLAN.md — 版本配额管理、定时重置、Docker Compose部署

### Phase 2: 多LLM适配网关模块
**Goal:** 实现统一LLM调用抽象层，支持豆包/DeepSeek/文心一言/通义千问/OpenAI等主流平台，租户级自定义配置
**Deliverables:**
- LLMBaseService统一接口定义
- OpenAI协议兼容实现（覆盖90%+主流大模型）
- 豆包/DeepSeek/文心一言/通义千问专属适配实现
- 租户LLM配置管理（tenant_llm_config表）
- 限流/重试/熔断机制
- LLM调用日志审计、Token消耗统计
- 前端LLM配置管理页面
**Requirements:** REQ-005, REQ-006, REQ-007

### Phase 3: AI可见度诊断模块
**Goal:** 实现品牌GEO可见度一键诊断，多平台数据采集、品牌提及检测、指标计算、报告生成
**Deliverables:**
- 诊断任务管理（创建/列表/详情/删除）
- 多平台数据采集引擎（Jsoup+Playwright）
- 品牌实体识别（HanLP中文NLP）
- GEO健康度评分算法实现
- 品牌提及率/首位推荐率/收录数指标计算
- 信源反查分析
- 竞品对标分析
- 诊断报告生成（PDF/Excel导出）
- 提问词挖掘功能
- 前端诊断模块完整UI
**Requirements:** REQ-008, REQ-009, REQ-010, REQ-011

### Phase 4: 品牌监控模块
**Goal:** 实现7*24小时品牌GEO效果持续监控、趋势分析、异常预警、竞品追踪
**Deliverables:**
- 监控任务管理（创建/配置/暂停/重启/删除）
- 定时任务调度（XXL-Job集成）
- 时序数据采集与存储（geo_monitor_data分表）
- 移动平均趋势分析算法
- 3σ异常检测算法
- 预警规则引擎（配置化阈值/渠道/级别）
- 多渠道预警推送（系统消息/邮件/企业微信/钉钉）
- 监控趋势图表、竞品对比
- 前端监控模块完整UI
**Requirements:** REQ-012, REQ-013, REQ-014

### Phase 5: GEO内容创作模块
**Goal:** 实现符合LLM检索偏好的GEO内容生成、优化、管理全流程
**Deliverables:**
- AI内容生成（单篇/批量，多内容类型）
- WangEditor富文本编辑器集成
- GEO内容优化Prompt模板引擎
- 内容GEO健康度实时评分
- 内容结构化优化（权威来源标注、实体标注）
- 合规校验（广告法/敏感词/医疗内容）
- 草稿自动保存（30秒间隔）
- 素材库管理（MinIO/本地存储）
- 内容导出（md/txt/doc格式）
- 前端内容创作模块完整UI
**Requirements:** REQ-015, REQ-016, REQ-017

### Phase 6: 数据中心与系统管理模块
**Goal:** 实现全维度GEO效果数据看板、报表分析，以及系统管理后台
**Deliverables:**
- 数据总览看板（核心指标/趋势/异常提醒）
- 收录报表（各平台统计/趋势/竞品对比）
- 平台分析（各AI平台数据占比/效果对比）
- 内容效果分析（收录情况/引流效果/GEO评分趋势）
- ECharts可视化图表组件库
- 报表导出（Excel/PDF）
- 系统管理：平台配置/LLM网关管理/操作日志/定时任务管理
- 前端数据中心+系统管理完整UI
**Requirements:** REQ-018, REQ-019, REQ-020

### Phase 7: 部署、安全加固与测试
**Goal:** 完成生产环境Docker部署、安全加固、全量测试，达到上线标准
**Deliverables:**
- Docker Compose完整部署配置（MySQL/Redis/MinIO/Backend/Frontend/Nginx）
- Nginx反向代理配置（HTTPS/Gzip/限流）
- 安全加固（BCrypt密码/JWT黑名单/SQL注入防护/XSS过滤/接口限流）
- Prometheus+Grafana监控配置
- 数据库备份脚本
- 单元测试（核心算法覆盖率≥80%）
- 集成测试（核心业务流程）
- 性能测试（100并发，核心接口≤200ms）
- 部署文档、操作手册
**Requirements:** REQ-021, REQ-022, REQ-023

---

## Milestone 2: 功能完善 (2周)

### Phase 8: 预警体系完善与算法优化
**Goal:** 完善多渠道预警推送，优化GEO内容优化算法，新增竞品深度分析
**Requirements:** REQ-024, REQ-025

---

## Milestone 3: SaaS化扩展 (3周)

### Phase 9: 多租户SaaS体系与代理商管理
**Goal:** 完善多租户SaaS体系，支持代理商渠道管理、分佣结算，新增企业版功能
**Requirements:** REQ-026, REQ-027

### Phase 10: API开放平台与运维监控完善
**Goal:** 新增API开放平台，完善运维监控体系，提升系统高可用性
**Requirements:** REQ-028, REQ-029
