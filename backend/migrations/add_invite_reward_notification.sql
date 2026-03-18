-- 邀请码表
CREATE TABLE IF NOT EXISTS `openclaw_invite_records` (
  `id` int NOT NULL AUTO_INCREMENT,
  `inviter_id` int NOT NULL COMMENT '邀请人ID',
  `invitee_id` int NOT NULL COMMENT '被邀请人ID',
  `invite_code` varchar(32) NOT NULL COMMENT '邀请码',
  `reward_amount` decimal(10,2) DEFAULT 0.00 COMMENT '奖励金额',
  `status` enum('pending','active','expired') DEFAULT 'pending' COMMENT '状态',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_inviter` (`inviter_id`),
  KEY `idx_invitee` (`invitee_id`),
  KEY `idx_code` (`invite_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户邀请记录';

-- 奖励记录表
CREATE TABLE IF NOT EXISTS `openclaw_rewards` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL COMMENT '用户ID',
  `type` varchar(50) NOT NULL COMMENT '奖励类型',
  `amount` decimal(10,2) NOT NULL COMMENT '奖励金额',
  `description` varchar(500) DEFAULT NULL COMMENT '说明',
  `status` enum('pending','received','expired') DEFAULT 'pending' COMMENT '状态',
  `related_id` int DEFAULT NULL COMMENT '关联ID（如邀请记录ID）',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `received_at` datetime DEFAULT NULL COMMENT '领取时间',
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户奖励记录';

-- 通知消息表
CREATE TABLE IF NOT EXISTS `openclaw_notifications` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL COMMENT '用户ID（0表示全体用户）',
  `title` varchar(200) NOT NULL COMMENT '标题',
  `content` text NOT NULL COMMENT '内容',
  `type` varchar(50) DEFAULT 'system' COMMENT '类型',
  `is_read` tinyint(1) DEFAULT 0 COMMENT '是否已读',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_read` (`is_read`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户通知消息';

-- 为 users 表添加 invite_code 字段（如果不存在）
-- ALTER TABLE `users` ADD COLUMN `invite_code` varchar(32) DEFAULT NULL COMMENT '我的邀请码';
-- ALTER TABLE `users` ADD COLUMN `invited_by` varchar(32) DEFAULT NULL COMMENT '被谁邀请';
-- 注意：这些字段已经存在，无需重复添加
