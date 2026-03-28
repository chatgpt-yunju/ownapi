const router = require('express').Router();

router.use('/api/articles', require('./routes/article'));
router.use('/api/hotspots', require('./routes/hotspot'));
router.use('/api/publish', require('./routes/publish'));
router.use('/api/accounts', require('./routes/account'));
router.use('/api/analytics', require('./routes/analytics'));
router.use('/api/comments', require('./routes/comment'));
router.use('/api/covers', require('./routes/cover'));
router.use('/api/cases', require('./routes/cases'));

module.exports = router;
