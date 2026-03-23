const jwt = require('jsonwebtoken');

const JWT_SECRET = 'afa5469ba65ffa2f257b0456d7ae288fd8e0329008c5968ca3f08e553c315da0';

// 生成 admin 用户的 token (使用 id 而不是 userId)
const token = jwt.sign(
  { id: 1, username: 'admin', role: 'admin' },
  JWT_SECRET,
  { expiresIn: '30d' }
);

console.log(token);
