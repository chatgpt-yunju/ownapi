const path = require('path');
const fs = require('fs');
require('dotenv').config();

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads');

const storage = {
  getPath(filename) {
    return path.join(UPLOAD_DIR, filename);
  },

  getUrl(filename) {
    return `/api/media/${filename}`;
  },

  delete(filename) {
    const filePath = path.join(UPLOAD_DIR, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  },
};

module.exports = storage;
