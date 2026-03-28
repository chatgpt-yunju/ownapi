const router = require('express').Router();
const db = require('../../../config/db');
const crypto = require('crypto');
const { adjustBalance } = require('../utils/billing');

/**
 * 生成邀请码
 */
function generateInviteCode(userId) {
  const hash = crypto.createHash('md5').update(`invite_${userId}_${Date.now()}`).digest('hex');
  return hash.substring(0, 8).toUpperCase();
}

/**
 * GET /user/invite
 * 获取邀请信息
 */
router.get('/invite', async (req, res) => {
  const userId = req.user.id;

  try {
    // 获取或创建邀请码
    let [[user]] = await db.query('SELECT invite_code FROM users WHERE id = ?', [userId]);

    if (!user.invite_code) {
      const inviteCode = generateInviteCode(userId);
      await db.query('UPDATE users SET invite_code = ? WHERE id = ?', [inviteCode, userId]);
      user.invite_code = inviteCode;
    }

    // 统计邀请数据
    const [[stats]] = await db.query(
      `SELECT
        COUNT(*) as invite_count,
        COALESCE(SUM(reward_amount), 0) as total_rewards
       FROM openclaw_invite_records
       WHERE inviter_id = ?`,
      [userId]
    );

    // 待发放奖励
    const [[pending]] = await db.query(
      `SELECT COALESCE(SUM(amount), 0) as pending_rewards
       FROM openclaw_rewards
       WHERE user_id = ? AND status = 'pending'`,
      [userId]
    );

    // 邀请记录
    const [invites] = await db.query(
      `SELECT
        u.username,
        ui.created_at,
        ui.status,
        ui.reward_amount as reward
       FROM openclaw_invite_records ui
       JOIN users u ON ui.invitee_id = u.id
       WHERE ui.inviter_id = ?
       ORDER BY ui.created_at DESC
       LIMIT 50`,
      [userId]
    );

    res.json({
      invite_code: user.invite_code,
      invite_count: stats.invite_count || 0,
      total_rewards: stats.total_rewards || 0,
      pending_rewards: pending.pending_rewards || 0,
      invites
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取邀请信息失败' });
  }
});

/**
 * GET /user/rewards
 * 获取奖励信息
 */
router.get('/rewards', async (req, res) => {
  const userId = req.user.id;

  try {
    // 统计数据
    const [[stats]] = await db.query(
      `SELECT
        COALESCE(SUM(amount), 0) as total,
        COALESCE(SUM(CASE WHEN status = 'received' THEN amount ELSE 0 END), 0) as received,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as pending
       FROM openclaw_rewards
       WHERE user_id = ?`,
      [userId]
    );

    // 奖励记录
    const [rewards] = await db.query(
      `SELECT
        id,
        type,
        amount,
        description,
        status,
        created_at,
        received_at
       FROM openclaw_rewards
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 100`,
      [userId]
    );

    res.json({
      total: stats.total || 0,
      received: stats.received || 0,
      pending: stats.pending || 0,
      rewards
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取奖励信息失败' });
  }
});

/**
 * POST /user/rewards/:id/claim
 * 领取奖励
 */
router.post('/rewards/:id/claim', async (req, res) => {
  const userId = req.user.id;
  const rewardId = req.params.id;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 查询奖励
    const [[reward]] = await conn.query(
      'SELECT * FROM openclaw_rewards WHERE id = ? AND user_id = ? AND status = "pending"',
      [rewardId, userId]
    );

    if (!reward) {
      await conn.rollback();
      return res.status(404).json({ error: '奖励不存在或已领取' });
    }

    const walletResult = await adjustBalance(
      userId,
      'wallet',
      Number(reward.amount),
      'reward',
      reward.description,
      { source: 'invite_reward', reward_id: reward.id },
      conn
    );
    const newBalance = walletResult.balance;

    // 更新奖励状态
    await conn.query(
      'UPDATE openclaw_rewards SET status = "received", received_at = NOW() WHERE id = ?',
      [rewardId]
    );

    await conn.commit();

    res.json({
      success: true,
      amount: reward.amount,
      new_balance: newBalance
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: '领取奖励失败' });
  } finally {
    conn.release();
  }
});

/**
 * GET /user/notifications
 * 获取通知列表
 */
router.get('/notifications', async (req, res) => {
  const userId = req.user.id;

  try {
    const [notifications] = await db.query(
      `SELECT
        id,
        title,
        content,
        type,
        is_read,
        created_at
       FROM openclaw_notifications
       WHERE user_id = ? OR user_id = 0
       ORDER BY created_at DESC
       LIMIT 100`,
      [userId]
    );

    res.json({ notifications });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '获取通知失败' });
  }
});

/**
 * POST /user/notifications/read-all
 * 标记所有通知为已读
 */
router.post('/notifications/read-all', async (req, res) => {
  const userId = req.user.id;

  try {
    await db.query(
      'UPDATE openclaw_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0',
      [userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '标记失败' });
  }
});

/**
 * POST /user/notifications/:id/read
 * 标记单个通知为已读
 */
router.post('/notifications/:id/read', async (req, res) => {
  const userId = req.user.id;
  const notificationId = req.params.id;

  try {
    await db.query(
      'UPDATE openclaw_notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
      [notificationId, userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '标记失败' });
  }
});

module.exports = router;
