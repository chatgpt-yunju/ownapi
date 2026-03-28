const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../config/db');

// 获取任务列表
router.get('/list', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const today = new Date().toISOString().split('T')[0];

    // 获取所有启用的任务
    const [tasks] = await db.query(
      `SELECT id, task_key, task_name, task_desc, task_type, reward_quota, target_count, sort_order
       FROM tasks
       WHERE is_enabled = 1
       ORDER BY sort_order ASC, id ASC`
    );

    // 获取用户任务进度
    const [userTasks] = await db.query(
      'SELECT task_key, current_count, is_completed, completed_at, last_reset_date FROM user_tasks WHERE user_id = ?',
      [userId]
    );

    // 创建任务进度映射
    const userTaskMap = {};
    userTasks.forEach(ut => {
      userTaskMap[ut.task_key] = ut;
    });

    // 合并任务信息和用户进度
    const result = tasks.map(task => {
      const userTask = userTaskMap[task.task_key];

      // 每日任务需要检查是否需要重置
      let needReset = false;
      if (task.task_type === 'daily' && userTask) {
        needReset = userTask.last_reset_date !== today;
      }

      return {
        id: task.id,
        task_key: task.task_key,
        task_name: task.task_name,
        task_desc: task.task_desc,
        task_type: task.task_type,
        reward_quota: task.reward_quota,
        target_count: task.target_count,
        current_count: needReset ? 0 : (userTask?.current_count || 0),
        is_completed: needReset ? false : (userTask?.is_completed || false),
        completed_at: needReset ? null : userTask?.completed_at,
        progress: Math.min(100, Math.round(((needReset ? 0 : (userTask?.current_count || 0)) / task.target_count) * 100))
      };
    });

    res.json(result);
  } catch (error) {
    console.error('获取任务列表失败:', error);
    res.status(500).json({ message: '获取任务列表失败' });
  }
});

// 完成任务
router.post('/complete', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { task_key } = req.body;
    const today = new Date().toISOString().split('T')[0];

    if (!task_key) {
      return res.status(400).json({ message: '缺少任务标识' });
    }

    // 获取任务信息
    const [[task]] = await db.query(
      'SELECT id, task_name, task_type, reward_quota, target_count FROM tasks WHERE task_key = ? AND is_enabled = 1',
      [task_key]
    );

    if (!task) {
      return res.status(404).json({ message: '任务不存在或已禁用' });
    }

    // 获取用户任务进度
    const [[userTask]] = await db.query(
      'SELECT id, current_count, is_completed, last_reset_date FROM user_tasks WHERE user_id = ? AND task_key = ?',
      [userId, task_key]
    );

    // 每日任务检查是否需要重置
    let needReset = false;
    if (task.task_type === 'daily' && userTask) {
      needReset = userTask.last_reset_date !== today;
    }

    // 如果需要重置或没有记录，创建/重置记录
    if (!userTask || needReset) {
      if (userTask) {
        await db.query(
          'UPDATE user_tasks SET current_count = 1, is_completed = 0, completed_at = NULL, last_reset_date = ? WHERE id = ?',
          [today, userTask.id]
        );
      } else {
        await db.query(
          'INSERT INTO user_tasks (user_id, task_key, current_count, last_reset_date) VALUES (?, ?, 1, ?)',
          [userId, task_key, today]
        );
      }

      const newCount = 1;
      const isCompleted = newCount >= task.target_count;

      // 如果完成了，发放奖励
      if (isCompleted) {
        await db.query(
          'UPDATE user_tasks SET is_completed = 1, completed_at = NOW() WHERE user_id = ? AND task_key = ?',
          [userId, task_key]
        );

        await db.query(
          'UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?',
          [task.reward_quota, userId]
        );

        return res.json({
          message: `恭喜完成任务"${task.task_name}"！获得 ${task.reward_quota} 积分`,
          reward: task.reward_quota,
          completed: true,
          current_count: newCount,
          target_count: task.target_count
        });
      }

      return res.json({
        message: '任务进度已更新',
        completed: false,
        current_count: newCount,
        target_count: task.target_count
      });
    }

    // 检查是否已完成
    if (userTask.is_completed && !needReset) {
      return res.status(400).json({ message: '该任务已完成' });
    }

    // 增加进度
    const newCount = userTask.current_count + 1;
    const isCompleted = newCount >= task.target_count;

    await db.query(
      'UPDATE user_tasks SET current_count = ?, is_completed = ?, completed_at = ? WHERE id = ?',
      [newCount, isCompleted ? 1 : 0, isCompleted ? new Date() : null, userTask.id]
    );

    // 如果完成了，发放奖励
    if (isCompleted) {
      await db.query(
        'UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?',
        [task.reward_quota, userId]
      );

      return res.json({
        message: `恭喜完成任务"${task.task_name}"！获得 ${task.reward_quota} 积分`,
        reward: task.reward_quota,
        completed: true,
        current_count: newCount,
        target_count: task.target_count
      });
    }

    res.json({
      message: '任务进度已更新',
      completed: false,
      current_count: newCount,
      target_count: task.target_count
    });
  } catch (error) {
    console.error('完成任务失败:', error);
    res.status(500).json({ message: '完成任务失败' });
  }
});

// 初始化默认任务（仅在数据库为空时执行）
router.post('/init', requireAuth, async (req, res) => {
  try {
    // 检查是否已有任务
    const [[count]] = await db.query('SELECT COUNT(*) as count FROM tasks');

    if (count.count > 0) {
      return res.json({ message: '任务已初始化' });
    }

    // 插入默认任务
    const defaultTasks = [
      {
        task_key: 'daily_login',
        task_name: '每日登录',
        task_desc: '每天登录系统一次',
        task_type: 'daily',
        reward_quota: 5,
        target_count: 1,
        sort_order: 1
      },
      {
        task_key: 'daily_assessment',
        task_name: '完成基础定品',
        task_desc: '完成一次基础定品评估',
        task_type: 'daily',
        reward_quota: 10,
        target_count: 1,
        sort_order: 2
      },
      {
        task_key: 'daily_log',
        task_name: '日用省察',
        task_desc: '记录3条省察日志',
        task_type: 'daily',
        reward_quota: 15,
        target_count: 3,
        sort_order: 3
      },
      {
        task_key: 'newbie_first_assessment',
        task_name: '首次评估',
        task_desc: '完成第一次基础定品',
        task_type: 'newbie',
        reward_quota: 50,
        target_count: 1,
        sort_order: 10
      },
      {
        task_key: 'newbie_woodenfish',
        task_name: '敲响木鱼',
        task_desc: '使用电子木鱼功能',
        task_type: 'newbie',
        reward_quota: 30,
        target_count: 1,
        sort_order: 11
      }
    ];

    for (const task of defaultTasks) {
      await db.query(
        `INSERT INTO tasks (task_key, task_name, task_desc, task_type, reward_quota, target_count, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [task.task_key, task.task_name, task.task_desc, task.task_type, task.reward_quota, task.target_count, task.sort_order]
      );
    }

    res.json({ message: '默认任务初始化成功', count: defaultTasks.length });
  } catch (error) {
    console.error('初始化任务失败:', error);
    res.status(500).json({ message: '初始化任务失败' });
  }
});

module.exports = router;
