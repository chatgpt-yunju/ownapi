const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads');

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const sub = file.mimetype.startsWith('video/') ? 'videos' : 'images';
    const dir = path.join(UPLOAD_DIR, sub);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter(req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'];
    cb(null, allowed.includes(file.mimetype));
  },
});

module.exports = upload;
