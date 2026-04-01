const db = require('../../../config/db');
const { adjustBalance } = require('./billing');

const REGISTER_INVITER_REWARD = 1;
const REGISTER_INVITEE_REWARD = 1;
const FIRST_PAID_MIN_AMOUNT_CNY = 10;
const FIRST_PAID_INVITER_REWARD_RATE = 0.10;

function roundRewardAmount(amount) {
  return Number(Number(amount || 0).toFixed(2));
}

async function insertRewardRecord(conn, {
  userId,
  type,
  amount,
  description,
  relatedId = null,
  status = 'received',
}) {
  const rewardAmount = roundRewardAmount(amount);
  if (!rewardAmount || rewardAmount <= 0) return null;

  const receivedAt = status === 'received' ? 'NOW()' : 'NULL';
  const [result] = await conn.query(
    `INSERT INTO openclaw_rewards
      (user_id, type, amount, description, status, related_id, created_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), ${receivedAt})`,
    [userId, type, rewardAmount, description || null, status, relatedId]
  );
  return result.insertId;
}

async function grantRegisterInviteRewards({
  conn,
  inviteCode,
  inviteeUserId,
  inviteeUsername,
}) {
  const normalizedCode = String(inviteCode || '').trim().toUpperCase();
  if (!normalizedCode) return { awarded: false };

  const [[inviter]] = await conn.query(
    'SELECT id FROM users WHERE invite_code = ? LIMIT 1',
    [normalizedCode]
  );
  if (!inviter || Number(inviter.id) === Number(inviteeUserId)) {
    return { awarded: false };
  }

  const [[existingRecord]] = await conn.query(
    'SELECT id FROM openclaw_invite_records WHERE invitee_id = ? LIMIT 1 FOR UPDATE',
    [inviteeUserId]
  );
  if (existingRecord) {
    return { awarded: false, inviterId: inviter.id, inviteRecordId: existingRecord.id };
  }

  const [recordResult] = await conn.query(
    `INSERT INTO openclaw_invite_records
      (inviter_id, invitee_id, invite_code, reward_amount, register_reward_amount, first_paid_reward_amount, first_paid_rewarded, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 'active', NOW(), NOW())`,
    [inviter.id, inviteeUserId, normalizedCode, REGISTER_INVITER_REWARD, REGISTER_INVITER_REWARD]
  );
  const inviteRecordId = recordResult.insertId;

  await adjustBalance(
    inviter.id,
    'wallet',
    REGISTER_INVITER_REWARD,
    'invite_register',
    `邀请用户 ${inviteeUsername} 注册奖励`,
    { source: 'invite_register', role: 'inviter', invite_record_id: inviteRecordId, invitee_user_id: inviteeUserId },
    conn
  );
  await insertRewardRecord(conn, {
    userId: inviter.id,
    type: 'invite_register',
    amount: REGISTER_INVITER_REWARD,
    description: `邀请用户 ${inviteeUsername} 注册奖励`,
    relatedId: inviteRecordId,
    status: 'received',
  });

  await adjustBalance(
    inviteeUserId,
    'wallet',
    REGISTER_INVITEE_REWARD,
    'invitee_register_bonus',
    '使用邀请码注册奖励',
    { source: 'invite_register', role: 'invitee', invite_record_id: inviteRecordId, inviter_user_id: inviter.id },
    conn
  );
  await insertRewardRecord(conn, {
    userId: inviteeUserId,
    type: 'invitee_register_bonus',
    amount: REGISTER_INVITEE_REWARD,
    description: '使用邀请码注册奖励',
    relatedId: inviteRecordId,
    status: 'received',
  });

  return {
    awarded: true,
    inviterId: inviter.id,
    inviteRecordId,
    inviterReward: REGISTER_INVITER_REWARD,
    inviteeReward: REGISTER_INVITEE_REWARD,
  };
}

async function grantFirstPaidInviteReward({
  conn,
  inviteeUserId,
  outTradeNo,
  paidAmount,
}) {
  const actualPaid = roundRewardAmount(paidAmount);
  if (actualPaid < FIRST_PAID_MIN_AMOUNT_CNY) {
    return { awarded: false, reason: 'below_minimum' };
  }

  const [[inviteRecord]] = await conn.query(
    'SELECT * FROM openclaw_invite_records WHERE invitee_id = ? LIMIT 1 FOR UPDATE',
    [inviteeUserId]
  );
  if (!inviteRecord) return { awarded: false, reason: 'no_invite_record' };
  if (Number(inviteRecord.first_paid_rewarded || 0) === 1) {
    return { awarded: false, reason: 'already_awarded' };
  }

  const [[previousPaidOrder]] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM recharge_orders
     WHERE user_id = ? AND status = 'paid' AND order_type IN ('recharge', 'package') AND out_trade_no <> ?`,
    [inviteeUserId, outTradeNo]
  );
  if (Number(previousPaidOrder?.cnt || 0) > 0) {
    return { awarded: false, reason: 'not_first_paid_order' };
  }

  const rewardAmount = roundRewardAmount(actualPaid * FIRST_PAID_INVITER_REWARD_RATE);
  if (!rewardAmount || rewardAmount <= 0) {
    return { awarded: false, reason: 'zero_reward' };
  }

  const description = `邀请用户首单支付奖励（订单 ${outTradeNo}）`;
  await adjustBalance(
    inviteRecord.inviter_id,
    'wallet',
    rewardAmount,
    'invite_first_paid',
    description,
    { source: 'invite_first_paid', invite_record_id: inviteRecord.id, invitee_user_id: inviteeUserId, out_trade_no: outTradeNo },
    conn
  );
  await insertRewardRecord(conn, {
    userId: inviteRecord.inviter_id,
    type: 'invite_first_paid',
    amount: rewardAmount,
    description,
    relatedId: inviteRecord.id,
    status: 'received',
  });

  await conn.query(
    `UPDATE openclaw_invite_records
     SET reward_amount = ?,
         first_paid_reward_amount = ?,
         first_paid_rewarded = 1,
         first_paid_order_no = ?,
         first_paid_at = NOW(),
         status = 'active',
         updated_at = NOW()
     WHERE id = ?`,
    [
      roundRewardAmount(Number(inviteRecord.reward_amount || 0) + rewardAmount),
      rewardAmount,
      outTradeNo,
      inviteRecord.id,
    ]
  );

  return {
    awarded: true,
    rewardAmount,
    inviterId: inviteRecord.inviter_id,
    inviteRecordId: inviteRecord.id,
  };
}

module.exports = {
  REGISTER_INVITER_REWARD,
  REGISTER_INVITEE_REWARD,
  FIRST_PAID_MIN_AMOUNT_CNY,
  FIRST_PAID_INVITER_REWARD_RATE,
  roundRewardAmount,
  grantRegisterInviteRewards,
  grantFirstPaidInviteReward,
};
