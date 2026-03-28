const router = require('express').Router();
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Support token via query param for <img> tags
function mediaAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = (header && header.startsWith('Bearer ') ? header.slice(7) : null)
    || req.query.token;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
}

// Serve media files (auth-gated)
router.get('/*', mediaAuth, (req, res) => {
  const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads');
  const relativePath = req.params[0];

  // Prevent path traversal
  const filePath = path.resolve(UPLOAD_DIR, relativePath);
  if (!filePath.startsWith(UPLOAD_DIR)) {
    return res.status(400).json({ message: 'Invalid path' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ message: 'File not found' });
  }

  res.sendFile(filePath);
});

module.exports = router;
