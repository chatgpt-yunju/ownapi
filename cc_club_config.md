# CC Club Claude 接入配置

## 配置信息
- **Base URL**: https://claude-code.club/api
- **API Endpoint**: https://claude-code.club/api/v1/chat/completions
- **API Token**: cr_51ba3976067d2d2ad7d2e0d4e9647a2dd4edc8a1f58410ef25567d26089ff691
- **账户**: cfati9089@gmail.com_1
- **用户ID**: user_b94dade1-52f0-4f07-99db-8f48ad544534

## 配额限制
- **限额**: $7.00
- **使用期限**: 2026-03-18 08:15 至 2026-03-25 08:15 (7天)
- **通知邮箱**: 2743319061@qq.com

## 支持的模型
根据 CC Club API 返回的模型列表：
- ✅ claude-sonnet-4-6 (Claude 4.6 Sonnet)
- ✅ claude-opus-4-6 (Claude 4.6 Opus)
- ✅ claude-haiku-4-5-20251001 (Claude 4.5 Haiku)
- ✅ claude-opus-4-5-20251101 (Claude 4.5 Opus)
- ✅ claude-sonnet-4-5-20250929 (Claude 4.5 Sonnet)

## 当前状态
❌ **权限问题**: API 密钥返回错误 "This API key does not have permission to access Claude"

### 错误详情
```json
{
  "error": {
    "message": "This API key does not have permission to access Claude",
    "type": "permission_denied",
    "code": "permission_denied"
  }
}
```

### 测试命令
```bash
curl -X POST https://claude-code.club/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer cr_51ba3976067d2d2ad7d2e0d4e9647a2dd4edc8a1f58410ef25567d26089ff691" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 50
  }'
```

## 可能的解决方案
1. **联系 CC Club 支持**: 确认账户是否需要额外激活 Claude 访问权限
2. **检查账户设置**: 登录 CC Club 控制台查看权限配置
3. **验证密钥类型**: 确认该密钥是否支持 Claude 模型
4. **重新生成密钥**: 尝试生成新的 API 密钥并指定 Claude 权限

## OpenClaw AI 配置
已在数据库中配置以下模型（当前状态：active）：

| 模型ID | 显示名称 | 输入价格/1K | 输出价格/1K | 上游模型ID |
|--------|---------|------------|------------|-----------|
| claude-sonnet-4-6 | Claude Sonnet 4.6 | ¥0.003 | ¥0.015 | claude-sonnet-4-6 |
| claude-opus-4-6 | Claude Opus 4.6 | ¥0.015 | ¥0.075 | claude-opus-4-6 |
| claude-haiku-4-5 | Claude Haiku 4.5 | ¥0.0008 | ¥0.004 | claude-haiku-4-5-20251001 |
| claude-3-5-sonnet-20241022 | Claude 3.5 Sonnet | ¥0.003 | ¥0.015 | - |

## 监控脚本
配额监控脚本已创建：`/home/ubuntu/api_yunjunet_cn/cc_club_monitor.sh`

功能：
- 检查使用期限
- 监控配额使用情况
- 超过 80% 时发送预警邮件
- 超出配额或过期时发送通知邮件

## 下一步
1. ⚠️ **解决权限问题**: 联系 CC Club 或检查账户设置
2. 权限解决后，使用 OpenClaw AI 测试 Claude 模型调用
3. 设置定时任务运行监控脚本：`crontab -e` 添加 `0 */6 * * * /home/ubuntu/api_yunjunet_cn/cc_club_monitor.sh`

## 联系方式
- **管理员邮箱**: 2743319061@qq.com
- **CC Club 网站**: https://claude-code.club
