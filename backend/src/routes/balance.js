const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { auth } = require('../middleware/auth');
const { getSettingCached } = require('./quota');

// 运行时迁移：添加余额字段
db.query(`
  ALTER TABLE user_quota
  ADD COLUMN balance DECIMAL(10,2) DEFAULT 0.00 COMMENT '余额（元）'
`).catch(() => {});

// 创建余额流水表
db.query(`
  CREATE TABLE IF NOT EXISTS balance_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    amount DECIMAL(10,2) NOT NULL COMMENT '变动金额',
    balance_before DECIMAL(10,2) NOT NULL COMMENT '变动前余额',
    balance_after DECIMAL(10,2) NOT NULL COMMENT '变动后余额',
    type ENUM('recharge', 'withdraw', 'buy_quota', 'buy_vip', 'refund') NOT NULL COMMENT '类型',
    related_order_id VARCHAR(100) COMMENT '关联订单号',
    description VARCHAR(500) COMMENT '描述',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_created_at (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`).catch(() => {});

// 创建提现申请表
db.query(`
  CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    amount DECIMAL(10,2) NOT NULL COMMENT '提现金额',
    status ENUM('pending', 'approved', 'rejected', 'completed') DEFAULT 'pending' COMMENT '状态',
    alipay_account VARCHAR(100) NOT NULL COMMENT '支付宝账号',
    real_name VARCHAR(100) NOT NULL COMMENT '真实姓名',
    admin_note VARCHAR(500) COMMENT '管理员备注',
    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP NULL COMMENT '处理时间',
    INDEX idx_user_id (user_id),
    INDEX idx_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`).catch(() => {});

// GET /api/balance/info — 获取余额信息
router.get('/info', auth, async (req, res) => {
  try {
    const [[user]] = await db.query(
      'SELECT balance, extra_quota FROM user_quota WHERE user_id = ?',
      [req.user.id]
    );
    res.json({
      balance: user?.balance || 0,
      quota: user?.extra_quota || 0
    });
  } catch (error) {
    console.error('获取余额信息失败:', error);
    res.status(500).json({ message: '服务器错误' });
  }
});

// POST /api/balance/convert-to-quota — 余额购买积分（1元 = 10积分）
router.post('/convert-to-quota', auth, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ message: '金额必须大于0' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [[user]] = await connection.query(
      'SELECT balance FROM user_quota WHERE user_id = ? FOR UPDATE',
      [req.user.id]
    );

    const currentBalance = user?.balance || 0;
    if (currentBalance < amount) {
      await connection.rollback();
      return res.status(400).json({
        message: '余额不足',
        required: amount,
        current: currentBalance
      });
    }

    const conversionRate = parseInt(await getSettingCached('balance_conversion_rate', '10'));
    const quotaToAdd = Math.floor(amount * conversionRate);
    const newBalance = currentBalance - amount;

    await connection.query(
      'UPDATE user_quota SET balance = ? WHERE user_id = ?',
      [newBalance, req.user.id]
    );

    await connection.query(
      'UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?',
      [quotaToAdd, req.user.id]
    );

    await connection.query(
      'INSERT INTO balance_logs (user_id, amount, balance_before, balance_after, type, description) VALUES (?, ?, ?, ?, "buy_quota", ?)',
      [req.user.id, -amount, currentBalance, newBalance, `购买${quotaToAdd}积分`]
    );

    await connection.commit();
    res.json({
      message: '兑换成功',
      balance: newBalance,
      quota_added: quotaToAdd
    });
  } catch (error) {
    await connection.rollback();
    console.error('兑换积分失败:', error);
    res.status(500).json({ message: '服务器错误' });
  } finally {
    connection.release();
  }
});

// POST /api/balance/withdraw — 申请提现
router.post('/withdraw', auth, async (req, res) => {
  const { amount, alipay_account, real_name } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ message: '提现金额必须大于0' });
  }
  if (!alipay_account || !real_name) {
    return res.status(400).json({ message: '请填写支付宝账号和真实姓名' });
  }

  try {
    const [[user]] = await db.query(
      'SELECT balance FROM user_quota WHERE user_id = ?',
      [req.user.id]
    );

    const currentBalance = user?.balance || 0;
    if (currentBalance < amount) {
      return res.status(400).json({
        message: '余额不足',
        required: amount,
        current: currentBalance
      });
    }

    await db.query(
      'INSERT INTO withdrawal_requests (user_id, amount, alipay_account, real_name) VALUES (?, ?, ?, ?)',
      [req.user.id, amount, alipay_account, real_name]
    );

    res.json({ message: '提现申请已提交，等待管理员审核' });
  } catch (error) {
    console.error('提现申请失败:', error);
    res.status(500).json({ message: '服务器错误' });
  }
});

// GET /api/balance/logs — 获取余额流水
router.get('/logs', auth, async (req, res) => {
  try {
    const [logs] = await db.query(
      'SELECT * FROM balance_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json(logs);
  } catch (error) {
    console.error('获取余额流水失败:', error);
    res.status(500).json({ message: '服务器错误' });
  }
});

// GET /api/balance/withdrawals — 获取提现记录
router.get('/withdrawals', auth, async (req, res) => {
  try {
    const [withdrawals] = await db.query(
      'SELECT * FROM withdrawal_requests WHERE user_id = ? ORDER BY requested_at DESC',
      [req.user.id]
    );
    res.json(withdrawals);
  } catch (error) {
    console.error('获取提现记录失败:', error);
    res.status(500).json({ message: '服务器错误' });
  }
});

module.exports = router;
