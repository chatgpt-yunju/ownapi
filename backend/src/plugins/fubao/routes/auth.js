const express = require('express');
const router = express.Router();
const ssoClient = require('../lib/sso-client');

// 登录：跳转到 SSO 授权页面
router.get('/login', (req, res) => {
  const state = Math.random().toString(36).slice(2);
  req.session.oauth_state = state;
  const authUrl = ssoClient.getAuthUrl(state);
  res.redirect(authUrl);
});

// 回调：处理 SSO 返回的 code
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    // 验证 state 防止 CSRF
    if (state !== req.session.oauth_state) {
      return res.status(400).send('Invalid state parameter');
    }
    delete req.session.oauth_state;

    // 用 code 换取 token
    const tokenData = await ssoClient.getToken(code);

    // 获取用户信息
    const userInfo = await ssoClient.getUserInfo(tokenData.token);

    // 保存到 session
    req.session.user = userInfo;
    req.session.token = tokenData.token;

    // 重定向到前端首页
    res.redirect('/');
  } catch (error) {
    console.error('SSO callback error:', error.message);
    res.status(500).send(`登录失败: ${error.message}`);
  }
});

// 登出
router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destroy error:', err);
    }
    res.redirect('/');
  });
});

module.exports = router;
