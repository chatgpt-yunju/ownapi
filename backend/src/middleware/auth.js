/**
 * JWT 认证中间件 — 委托到 yunjunet-common 公共基础
 * 保持原有 require('../middleware/auth') 路径兼容
 */
module.exports = require('yunjunet-common/backend-core/auth/middleware');
