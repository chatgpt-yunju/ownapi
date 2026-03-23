# QQ 登录流程测试

## 问题描述
QQ 登录后没有跳转到 OpenClaw AI 控制台

## 根本原因
主站 Login.vue 的 `qqLoginUrl` 计算属性使用了 `window.location.href` 作为 return_url，导致 QQ 登录后跳转回登录页面，而不是目标页面（console.html）。

## 修复内容

### 1. 修改主站 Login.vue（已完成）
**文件**：`/home/ubuntu/AI-Short-Video-Management-System/frontend/user/src/views/Login.vue`

**修改前**（第 65-69 行）：
```javascript
const qqLoginUrl = computed(() => {
  const relay = config.raw?.login_relay_domain || 'https://login.yunjunet.cn'
  const returnUrl = encodeURIComponent(window.location.href)
  return `/api/auth/qq?return_url=${returnUrl}`
})
```

**修改后**：
```javascript
const qqLoginUrl = computed(() => {
  const relay = config.raw?.login_relay_domain || 'https://login.yunjunet.cn'
  // 优先使用 URL 参数中的 return_url（跨站 SSO），否则使用当前页面 URL
  const params = new URLSearchParams(window.location.search)
  const targetReturnUrl = params.get('return_url') || window.location.href
  const returnUrl = encodeURIComponent(targetReturnUrl)
  return `/api/auth/qq?return_url=${returnUrl}`
})
```

### 2. 增强 OpenClaw AI 的错误处理（已完成）
**文件**：`/home/ubuntu/api_yunjunet_cn/public/js/api.js`

**修改**：在 `checkSSOCallback()` 函数中添加了错误处理，显示 QQ 登录失败的提示。

## 测试步骤

### 测试 1：未登录用户访问控制台
1. 清除浏览器 localStorage（清除 token）
2. 访问 `https://api.yunjunet.cn/console.html`
3. **预期**：自动跳转到 `https://yunjunet.cn/login?return_url=https://api.yunjunet.cn/console.html`

### 测试 2：QQ 登录流程
1. 在登录页面点击"QQ登录"按钮
2. **预期**：跳转到 QQ 授权页面，URL 应该包含 `return_url=https://api.yunjunet.cn/console.html`
3. 完成 QQ 授权
4. **预期**：跳转回 `https://api.yunjunet.cn/console.html?token=xxx`
5. **预期**：控制台页面正常加载，显示用户信息

### 测试 3：QQ 登录失败处理
1. 模拟 QQ 登录失败（访问 `https://api.yunjunet.cn/console.html?error=qq_login_failed&msg=测试错误`）
2. **预期**：显示错误提示"测试错误"

## 完整流程图

```
用户访问 console.html（未登录）
    ↓
api.js 检测无 token
    ↓
跳转到 https://yunjunet.cn/login?return_url=https://api.yunjunet.cn/console.html
    ↓
用户点击 QQ 登录
    ↓
Login.vue 读取 URL 参数中的 return_url
    ↓
跳转到 /api/auth/qq?return_url=https://api.yunjunet.cn/console.html
    ↓
QQ OAuth 授权
    ↓
回调到 /api/auth/qq/callback
    ↓
后端生成 JWT token
    ↓
跳转到 https://api.yunjunet.cn/console.html?token=xxx
    ↓
api.js 的 checkSSOCallback() 提取 token 并保存
    ↓
console.html 的 init() 调用 api.getUserInfo()
    ↓
控制台正常加载
```

## 验证命令

```bash
# 检查主站前端是否已构建
ls -lh /home/ubuntu/AI-Short-Video-Management-System/frontend/user/dist/assets/Login-*.js

# 检查 OpenClaw AI 后端是否运行
curl http://localhost:3021/api/health

# 检查主站后端是否运行
curl http://localhost:3000/api/health
```

## 注意事项

1. 主站前端已重新构建，修改已生效
2. OpenClaw AI 的 api.js 已增强错误处理
3. 需要确保 QQ 登录配置正确（settings 表中的 qq_app_id、qq_app_key、qq_login_enabled）
4. 需要确保 login_relay_domain 配置正确（默认 https://login.yunjunet.cn）
