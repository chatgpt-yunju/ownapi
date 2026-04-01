const mysql = require('mysql2/promise');
require('dotenv').config();

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT, 10) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'wechat_cms',
      waitForConnections: true,
      connectionLimit: Math.max(10, parseInt(process.env.DB_POOL_LIMIT, 10) || 60),
      queueLimit: 0,
      charset: 'utf8mb4',
    });
  }
  return pool;
}

const proxyPool = new Proxy({}, {
  get(_, prop) {
    return getPool()[prop];
  },
});

module.exports = proxyPool;
module.exports.getPool = getPool;
