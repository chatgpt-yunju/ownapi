const express = require('express');
const router = express.Router();

/**
 * GET /api/accounts
 * 获取账号列表
 */
router.get('/', (req, res) => {
  // TODO: 从数据库查询
  res.json({
    accounts: [
      { id: 'default', name: '默认账号', status: 'active', lastLogin: new Date() }
    ]
  });
});

/**
 * POST /api/accounts
 * 添加新账号
 */
router.post('/', (req, res) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: '缺少账号名称' });
  }

  // TODO: 保存到数据库
  res.json({
    success: true,
    accountId: `account_${Date.now()}`,
    message: '账号已创建，请扫码登录'
  });
});

/**
 * POST /api/accounts/switch/:id
 * 切换当前账号
 */
router.post('/switch/:id', (req, res) => {
  const accountId = req.params.id;

  // TODO: 更新当前账号状态
  res.json({
    success: true,
    accountId,
    message: '账号已切换'
  });
});

module.exports = router;
