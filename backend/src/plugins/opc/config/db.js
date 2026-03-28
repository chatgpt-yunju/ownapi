const mysql = require('mysql2/promise');
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: 'onepersonclaw',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0
});
module.exports = pool;
