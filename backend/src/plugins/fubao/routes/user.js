const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

// 获取当前用户信息
router.get('/me', requireAuth, (req, res) => {
  res.json(req.session.user);
});

module.exports = router;
