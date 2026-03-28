const router = require('express').Router();

router.use('/api/auth', require('./routes/auth'));
router.use('/api/resume', require('./routes/resume'));
router.use('/api/jobs', require('./routes/jobs'));
router.use('/api/match', require('./routes/match'));

router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;
