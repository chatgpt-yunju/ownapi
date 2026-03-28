const { validationResult } = require('express-validator');

/**
 * 验证中间件：检查 express-validator 的验证结果
 * 若有错误，返回 400 和第一个错误信息
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }
  next();
}

module.exports = { validate };
