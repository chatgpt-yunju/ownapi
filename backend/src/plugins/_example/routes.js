/**
 * 示例插件路由
 * 验证插件系统可正常加载和响应
 */
const router = require('express').Router();

router.get('/hello', (req, res) => {
  res.json({
    plugin: '_example',
    message: '插件系统运行正常',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
