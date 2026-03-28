const router = require('express').Router();

router.use('/api/auth', require('./routes/auth'));
router.use('/api/scenes', require('./routes/scenes'));
router.use('/api/versions', require('./routes/versions'));
router.use('/api/settings', require('./routes/settings'));
router.use('/api/users', require('./routes/users'));
router.use('/api/stats', require('./routes/stats'));
router.use('/api/announcements', require('./routes/announcements'));

module.exports = router;
