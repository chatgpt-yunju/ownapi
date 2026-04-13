# 开源授权追踪系统

## 概述
本系统用于管理开源项目的部署使用情况。代码在 GitHub 上免费下载，部署上线后会自动发送邮件通知到开发者邮箱。

## 核心功能
1. **自动域名追踪** - 收集部署域名信息
2. **实时邮件通知** - 新域名部署时即时通知
3. **每日统计汇总** - 每晚 20:00 发送当日新增域名
4. **隐私保护** - 不收集敏感数据，支持禁用追踪

## 配置说明

### 环境变量
```bash
# 通知邮箱（默认 2743319061@qq.com）
LICENSE_NOTIFY_EMAIL=your@email.com

# 禁用追踪（尊重用户隐私）
DISABLE_TELEMETRY=1
```

### 隐私声明
在 `README.md` 中添加以下说明：
```markdown
## 隐私声明
本项目默认会收集匿名部署统计（域名、IP、部署时间），用于了解项目使用情况。
数据仅用于授权管理，不会 collect 用户敏感信息。
如需禁用追踪，请设置环境变量：`DISABLE_TELEMETRY=1`
```

## 使用说明

### 部署到自己的服务器
1. 克隆代码
2. 配置 SMTP（系统设置中配置邮件服务器）
3. 部署启动后会自动发送部署通知

### 查看追踪统计
```bash
curl http://localhost:3000/api/license/stats \
  -H "X-Admin-Key: $INTERNAL_API_SECRET"

# 查看域名列表
curl http://localhost:3000/api/license/domains \
  -H "X-Admin-Key: $INTERNAL_API_SECRET"
```

## 数据存储
追踪数据存储在 MySQL 表 `license_domain_tracking` 中：
- `domain` - 部署域名
- `first_seen_at` - 首次发现时间
- `last_seen_at` - 最后访问时间
- `request_count` - 请求次数统计
- `first_ip` - 首次访问 IP
- `notified_at` - 通知发送时间

## 过滤规则
以下情况不会触发通知：
- localhost、127.0.0.1、内网 IP (192.168.x.x, 10.x.x.x)
- 爬虫/自动化工具 (Bot、Crawler 等)
- 健康检查端点 (/api/health)
- 静态资源文件

## License
个人使用免费，商业使用请联系获取授权。
