const jwt = require('jsonwebtoken');

function auth(req, res, next) {
  const header = req.headers.authorization;
  const token = (header && header.startsWith('Bearer ') ? header.slice(7) : null) || req.query.token;
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = (header && header.startsWith('Bearer ') ? header.slice(7) : null) || req.query.token;
  if (!token) { req.user = null; return next(); }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    req.user = null;
    next();
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
}

function requireReviewer(req, res, next) {
  if (req.user?.role !== 'reviewer' && req.user?.role !== 'admin') {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
}

module.exports = { auth, optionalAuth, requireAdmin, requireReviewer };
