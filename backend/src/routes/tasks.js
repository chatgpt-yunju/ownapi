const router = require('express').Router();
const db = require('../config/db');
const { auth } = require('../middleware/auth');

function todayCST() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

// 更新任务进度（内部函数，供其他路由调用）
async function updateTaskProgress(userId, taskKey, increment = 1) {
  try {
    const [[task]] = await db.query('SELECT * FROM tasks WHERE task_key = ? AND is_enabled = 1', [taskKey]);
    if (!task) return;

    const today = todayCST();

    // 确保用户任务记录存在
    await db.query(
      'INSERT IGNORE INTO user_tasks (user_id, task_key, current_count, last_reset_date) VALUES (?, ?, 0, ?)',
      [userId, taskKey, today]
    );

    // 每日任务：检查是否需要重置
    if (task.task_type === 'daily') {
      await db.query(
        'UPDATE user_tasks SET current_count = 0, is_completed = 0, last_reset_date = ? WHERE user_id = ? AND task_key = ? AND (last_reset_date IS NULL OR last_reset_date != ?)',
        [today, userId, taskKey, today]
      );
    }

    // 更新进度
    const [result] = await db.query(
      'UPDATE user_tasks SET current_count = current_count + ?, updated_at = NOW() WHERE user_id = ? AND task_key = ? AND is_completed = 0',
      [increment, userId, taskKey]
    );

    if (result.affectedRows > 0) {
      // 检查是否达成目标
      const [[userTask]] = await db.query(
        'SELECT * FROM user_tasks WHERE user_id = ? AND task_key = ?',
        [userId, taskKey]
      );

      if (userTask && userTask.current_count >= task.target_count && !userTask.is_completed) {
        // 自动标记完成并发放奖励
        await db.query(
          'UPDATE user_tasks SET is_completed = 1, completed_at = NOW() WHERE user_id = ? AND task_key = ?',
          [userId, taskKey]
        );

        // 发放奖励积分
        await db.query(
          'INSERT INTO user_quota (user_id, extra_quota) VALUES (?, ?) ON DUPLICATE KEY UPDATE extra_quota = extra_quota + ?',
          [userId, task.reward_quota, task.reward_quota]
        );

        const { addQuotaLog } = require('./quota');
        await addQuotaLog(userId, task.reward_quota, `任务奖励：${task.task_name}`);
      }
    }
  } catch (e) {
    console.error('[Task] updateTaskProgress error:', e.message);
  }
}

// GET /api/tasks — 获取任务列表及用户进度
router.get('/', auth, async (req, res) => {
  const today = todayCST();

  // 获取所有启用的任务
  const [tasks] = await db.query(
    'SELECT * FROM tasks WHERE is_enabled = 1 ORDER BY sort_order, id'
  );

  // 获取用户任务进度
  const [userTasks] = await db.query(
    'SELECT * FROM user_tasks WHERE user_id = ?',
    [req.user.id]
  );

  const userTaskMap = {};
  userTasks.forEach(ut => {
    userTaskMap[ut.task_key] = ut;
  });

  // 合并数据
  const result = tasks.map(task => {
    const userTask = userTaskMap[task.task_key];
    let currentCount = 0;
    let isCompleted = false;
    let canClaim = false;

    if (userTask) {
      // 每日任务：检查是否需要重置
      if (task.task_type === 'daily') {
        const lastReset = userTask.last_reset_date ?
          new Date(userTask.last_reset_date.getTime() + 8 * 3600000).toISOString().slice(0, 10) : null;
        if (lastReset !== today) {
          currentCount = 0;
          isCompleted = false;
        } else {
          currentCount = userTask.current_count;
          isCompleted = userTask.is_completed;
        }
      } else {
        currentCount = userTask.current_count;
        isCompleted = userTask.is_completed;
      }
    }

    // 判断是否可以领取奖励
    canClaim = currentCount >= task.target_count && !isCompleted;

    return {
      task_key: task.task_key,
      task_name: task.task_name,
      task_desc: task.task_desc,
      task_type: task.task_type,
      reward_quota: task.reward_quota,
      target_count: task.target_count,
      current_count: currentCount,
      is_completed: isCompleted,
      can_claim: canClaim,
    };
  });

  // 按类型分组
  const grouped = {
    daily: result.filter(t => t.task_type === 'daily'),
    newbie: result.filter(t => t.task_type === 'newbie'),
    achievement: result.filter(t => t.task_type === 'achievement'),
  };

  res.json(grouped);
});

// POST /api/tasks/:taskKey/claim — 领取任务奖励
router.post('/:taskKey/claim', auth, async (req, res) => {
  const { taskKey } = req.params;
  const today = todayCST();

  const [[task]] = await db.query('SELECT * FROM tasks WHERE task_key = ? AND is_enabled = 1', [taskKey]);
  if (!task) return res.status(404).json({ message: '任务不存在' });

  // 获取用户任务进度
  const [[userTask]] = await db.query(
    'SELECT * FROM user_tasks WHERE user_id = ? AND task_key = ?',
    [req.user.id, taskKey]
  );

  if (!userTask) {
    return res.status(400).json({ message: '任务未开始' });
  }

  // 每日任务：检查是否需要重置
  let currentCount = userTask.current_count;
  let isCompleted = userTask.is_completed;

  if (task.task_type === 'daily') {
    const lastReset = userTask.last_reset_date ?
      new Date(userTask.last_reset_date.getTime() + 8 * 3600000).toISOString().slice(0, 10) : null;
    if (lastReset !== today) {
      return res.status(400).json({ message: '任务进度已重置，请重新完成' });
    }
  }

  // 检查是否已完成
  if (isCompleted) {
    return res.status(400).json({ message: '任务奖励已领取' });
  }

  // 检查是否达成目标
  if (currentCount < task.target_count) {
    return res.status(400).json({ message: `任务未完成，当前进度 ${currentCount}/${task.target_count}` });
  }

  // 标记为已完成并发放奖励
  await db.query(
    'UPDATE user_tasks SET is_completed = 1, completed_at = NOW() WHERE user_id = ? AND task_key = ?',
    [req.user.id, taskKey]
  );

  await db.query(
    'INSERT INTO user_quota (user_id, extra_quota) VALUES (?, ?) ON DUPLICATE KEY UPDATE extra_quota = extra_quota + ?',
    [req.user.id, task.reward_quota, task.reward_quota]
  );

  const { addQuotaLog } = require('./quota');
  await addQuotaLog(req.user.id, task.reward_quota, `任务奖励：${task.task_name}`);

  res.json({
    message: `任务完成！获得 ${task.reward_quota} 积分`,
    reward_quota: task.reward_quota
  });
});

module.exports = { router, updateTaskProgress };
