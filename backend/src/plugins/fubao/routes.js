const router = require('express').Router();

router.use('/auth', require('./routes/auth'));
router.use('/api/user', require('./routes/user'));
router.use('/api/profile', require('./routes/profile'));
router.use('/api/tasks', require('./routes/tasks'));

router.get('/health', (req, res) => {
  res.json({ status: 'ok', message: '福报系统插件运行中' });
});

module.exports = router;
