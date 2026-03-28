const ssoClient = require('../lib/sso-client');

// 验证用户登录状态
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      message: '请先登录',
      redirect: '/auth/login'
    });
  }
  next();
}

// 验证用户积分
function requireQuota(minQuota) {
  return async (req, res, next) => {
    if (!req.session.user) {
      return res.status(401).json({
        message: '请先登录',
        redirect: '/auth/login'
      });
    }

    try {
      // 重新获取最新积分
      const userInfo = await ssoClient.getUserInfo(req.session.token);
      req.session.user = userInfo;

      if (userInfo.extra_quota < minQuota) {
        return res.status(402).json({
          message: '积分不足',
          required: minQuota,
          current: userInfo.extra_quota
        });
      }
      next();
    } catch (error) {
      console.error('requireQuota error:', error);
      return res.status(401).json({
        message: '请重新登录',
        redirect: '/auth/login'
      });
    }
  };
}

module.exports = { requireAuth, requireQuota };
