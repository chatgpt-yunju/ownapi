const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// 模拟用户存储 (实际应使用数据库)
const users = new Map();

/**
 * 用户注册
 */
router.post('/register', async (req, res) => {
  try {
    const { phone, password, nickname } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ error: '手机号和密码不能为空' });
    }

    // 检查用户是否存在
    if (Array.from(users.values()).some(u => u.phone === phone)) {
      return res.status(400).json({ error: '该手机号已注册' });
    }

    // 创建用户
    const userId = uuidv4();
    const hashedPassword = await bcrypt.hash(password, 10);

    users.set(userId, {
      id: userId,
      phone,
      password: hashedPassword,
      nickname: nickname || `用户${phone.slice(-4)}`,
      created_at: new Date()
    });

    // 生成token
    const token = jwt.sign({ userId }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d'
    });

    res.json({
      message: '注册成功',
      token,
      user: {
        id: userId,
        phone,
        nickname: nickname || `用户${phone.slice(-4)}`
      }
    });
  } catch (error) {
    console.error('注册错误:', error);
    res.status(500).json({ error: '注册失败' });
  }
});

/**
 * 用户登录
 */
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ error: '手机号和密码不能为空' });
    }

    // 查找用户
    const user = Array.from(users.values()).find(u => u.phone === phone);
    if (!user) {
      return res.status(401).json({ error: '手机号或密码错误' });
    }

    // 验证密码
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: '手机号或密码错误' });
    }

    // 生成token
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d'
    });

    res.json({
      message: '登录成功',
      token,
      user: {
        id: user.id,
        phone: user.phone,
        nickname: user.nickname
      }
    });
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ error: '登录失败' });
  }
});

/**
 * 获取当前用户信息
 */
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: '未登录' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = users.get(decoded.userId);

    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    res.json({
      id: user.id,
      phone: user.phone,
      nickname: user.nickname,
      created_at: user.created_at
    });
  } catch (error) {
    res.status(401).json({ error: 'token无效' });
  }
});

module.exports = router;
