CREATE DATABASE IF NOT EXISTS wechat_cms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE wechat_cms;

CREATE TABLE IF NOT EXISTS users (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  username   VARCHAR(64) UNIQUE NOT NULL,
  password   VARCHAR(255) NOT NULL,
  role       ENUM('admin','user','reviewer') DEFAULT 'user',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS content (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  title       VARCHAR(255) NOT NULL,
  category    VARCHAR(64) DEFAULT NULL,
  copy        TEXT,
  image_path  VARCHAR(512),
  video_path  VARCHAR(512),
  created_by  INT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS claims (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  content_id INT NOT NULL,
  claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_claim (user_id, content_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (content_id) REFERENCES content(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS publish_stats (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  claim_id          INT NOT NULL UNIQUE,
  user_id           INT NOT NULL,
  content_id        INT NOT NULL,
  likes             INT DEFAULT 0,
  comments          INT DEFAULT 0,
  favorites         INT DEFAULT 0,
  completion_rate   DECIMAL(5,2) DEFAULT 0,
  rate_3s           DECIMAL(5,2) DEFAULT 0,
  submitted_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (content_id) REFERENCES content(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS categories (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(64) UNIQUE NOT NULL,
  sort_order  INT DEFAULT 0,
  daily_quota INT DEFAULT 3,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO categories (name, sort_order) VALUES
('美食', 1), ('旅行', 2), ('时尚', 3), ('科技', 4),
('教育', 5), ('娱乐', 6), ('生活', 7), ('健身', 8), ('DIY', 9), ('其他', 10);

INSERT IGNORE INTO users (username, password, role)
VALUES ('admin', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'admin');

CREATE TABLE IF NOT EXISTS settings (
  `key`   VARCHAR(64) PRIMARY KEY,
  `value` TEXT NOT NULL
);

INSERT IGNORE INTO settings (`key`, `value`) VALUES
('daily_free_quota', '3'),
('checkin_reward', '1'),
('recharge_options', '[{"amount":1,"quota":5},{"amount":5,"quota":30},{"amount":10,"quota":70}]'),
('alipay_app_id', ''),
('alipay_private_key', ''),
('alipay_public_key', '');

CREATE TABLE IF NOT EXISTS user_quota (
  user_id                INT PRIMARY KEY,
  extra_quota            INT DEFAULT 0,
  last_checkin_date      DATE DEFAULT NULL,
  last_daily_reward_date DATE DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quota_logs (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  delta      INT NOT NULL,
  reason     VARCHAR(128) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recharge_orders (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  out_trade_no  VARCHAR(64) UNIQUE NOT NULL,
  user_id       INT NOT NULL,
  amount        DECIMAL(10,2) NOT NULL,
  quota         INT NOT NULL,
  status        ENUM('pending','paid','failed') DEFAULT 'pending',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  paid_at       DATETIME DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 任务定义表
CREATE TABLE IF NOT EXISTS tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_key VARCHAR(64) UNIQUE NOT NULL COMMENT '任务唯一标识',
  task_name VARCHAR(128) NOT NULL COMMENT '任务名称',
  task_desc TEXT COMMENT '任务描述',
  task_type ENUM('daily', 'newbie', 'achievement') NOT NULL COMMENT '任务类型',
  reward_quota INT NOT NULL COMMENT '奖励积分',
  target_count INT DEFAULT 1 COMMENT '目标次数',
  sort_order INT DEFAULT 0 COMMENT '排序',
  is_enabled TINYINT(1) DEFAULT 1 COMMENT '是否启用',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 用户任务进度表
CREATE TABLE IF NOT EXISTS user_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  task_key VARCHAR(64) NOT NULL COMMENT '任务标识',
  current_count INT DEFAULT 0 COMMENT '当前进度',
  is_completed TINYINT(1) DEFAULT 0 COMMENT '是否完成',
  completed_at DATETIME DEFAULT NULL COMMENT '完成时间',
  last_reset_date DATE DEFAULT NULL COMMENT '最后重置日期',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uk_user_task (user_id, task_key),
  INDEX idx_user_completed (user_id, is_completed)
);

-- 初始化任务数据
INSERT IGNORE INTO tasks (task_key, task_name, task_desc, task_type, reward_quota, target_count, sort_order) VALUES
-- 每日任务
('daily_claim_3', '每日领取素材', '每天领取3个素材', 'daily', 3, 3, 1),
('daily_use_ai', '使用AI工具', '每天使用AI工具1次', 'daily', 2, 1, 2),
-- 新手任务
('newbie_first_claim', '首次领取', '首次领取素材', 'newbie', 5, 1, 10),
('newbie_first_ai', '首次使用AI', '首次使用AI工具', 'newbie', 3, 1, 11),
('newbie_profile', '完善资料', '完善个人资料（设置昵称）', 'newbie', 8, 1, 12),
-- 成就任务
('achievement_claim_10', '素材达人', '累计领取10个素材', 'achievement', 10, 10, 20),
('achievement_claim_50', '素材专家', '累计领取50个素材', 'achievement', 30, 50, 21),
('achievement_checkin_7', '签到新星', '连续签到7天', 'achievement', 15, 7, 22),
('achievement_checkin_30', '签到达人', '连续签到30天', 'achievement', 80, 30, 23);

-- 对标素材投稿表
CREATE TABLE IF NOT EXISTS benchmark_submissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  social_link VARCHAR(512) NOT NULL COMMENT '社媒链接',
  reason TEXT NOT NULL COMMENT '投稿原因',
  category VARCHAR(64) NOT NULL COMMENT '分类',
  status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending' COMMENT '审核状态',
  admin_note TEXT COMMENT '管理员备注',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_date (user_id, created_at),
  INDEX idx_status (status),
  INDEX idx_link (social_link(255))
);
