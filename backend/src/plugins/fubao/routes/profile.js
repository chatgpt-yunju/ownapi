const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../config/db');

// 获取用户个人信息（包含积分、VIP等）
router.get('/me', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // 获取用户基本信息
    const [[user]] = await db.query(
      'SELECT id, username, role, email, level, created_at FROM users WHERE id = ?',
      [userId]
    );

    if (!user) {
      return res.status(404).json({ message: '用户不存在' });
    }

    // 获取用户积分和VIP信息
    const [[quota]] = await db.query(
      'SELECT extra_quota, last_checkin_date, last_daily_reward_date, vip_expires_at FROM user_quota WHERE user_id = ?',
      [userId]
    );

    // 如果没有积分记录，创建一条
    if (!quota) {
      await db.query(
        'INSERT INTO user_quota (user_id, extra_quota) VALUES (?, 0)',
        [userId]
      );
    }

    // 获取用户统计信息
    const [[stats]] = await db.query(
      `SELECT
        COUNT(*) as total_tasks,
        SUM(CASE WHEN is_completed = 1 THEN 1 ELSE 0 END) as completed_tasks
       FROM user_tasks
       WHERE user_id = ?`,
      [userId]
    );

    res.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        email: user.email,
        level: user.level,
        created_at: user.created_at
      },
      quota: {
        extra_quota: quota?.extra_quota || 0,
        last_checkin_date: quota?.last_checkin_date,
        last_daily_reward_date: quota?.last_daily_reward_date,
        vip_expires_at: quota?.vip_expires_at,
        is_vip: quota?.vip_expires_at && new Date(quota.vip_expires_at) > new Date()
      },
      stats: {
        total_tasks: stats?.total_tasks || 0,
        completed_tasks: stats?.completed_tasks || 0
      }
    });
  } catch (error) {
    console.error('获取个人信息失败:', error);
    res.status(500).json({ message: '获取个人信息失败' });
  }
});

// 每日签到
router.post('/checkin', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const today = new Date().toISOString().split('T')[0];

    // 获取用户积分信息
    const [[quota]] = await db.query(
      'SELECT last_checkin_date, extra_quota FROM user_quota WHERE user_id = ?',
      [userId]
    );

    if (!quota) {
      // 创建积分记录
      await db.query(
        'INSERT INTO user_quota (user_id, extra_quota, last_checkin_date) VALUES (?, 10, ?)',
        [userId, today]
      );
      return res.json({
        message: '签到成功！获得 10 积分',
        reward: 10,
        total: 10
      });
    }

    // 检查今天是否已签到
    if (quota.last_checkin_date === today) {
      return res.status(400).json({ message: '今天已经签到过了' });
    }

    // 签到奖励
    const reward = 10;
    await db.query(
      'UPDATE user_quota SET extra_quota = extra_quota + ?, last_checkin_date = ? WHERE user_id = ?',
      [reward, today, userId]
    );

    res.json({
      message: `签到成功！获得 ${reward} 积分`,
      reward,
      total: quota.extra_quota + reward
    });
  } catch (error) {
    console.error('签到失败:', error);
    res.status(500).json({ message: '签到失败' });
  }
});

module.exports = router;
