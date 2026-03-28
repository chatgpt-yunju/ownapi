const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

// 注册
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: '参数不完整' });
    const hash = await bcrypt.hash(password, 10);
    await db.query('INSERT INTO users (username,email,password) VALUES (?,?,?)', [username, email, hash]);
    res.json({ message: '注册成功' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: '用户名或邮箱已存在' });
    res.status(500).json({ error: '服务器错误' });
  }
});

// 登录
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const [rows] = await db.query('SELECT * FROM users WHERE username=? AND is_active=1', [username]);
    if (!rows.length) return res.status(401).json({ error: '用户名或密码错误' });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: '用户名或密码错误' });
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES }
    );
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch {
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
