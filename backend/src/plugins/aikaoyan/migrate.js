module.exports = async function migrate(db) {
  // ky_users
  await db.query(`
    CREATE TABLE IF NOT EXISTS ky_users (
      id INT PRIMARY KEY,
      username VARCHAR(100),
      nickname VARCHAR(100),
      email VARCHAR(200),
      role VARCHAR(20) DEFAULT 'user',
      is_vip TINYINT DEFAULT 0,
      vip_activated_at DATETIME,
      last_login DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  // ky_schools
  await db.query(`
    CREATE TABLE IF NOT EXISTS ky_schools (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      tier VARCHAR(20) DEFAULT '普通',
      province VARCHAR(50),
      logo_url VARCHAR(500),
      paper_count INT DEFAULT 0,
      is_active TINYINT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  // ky_majors
  await db.query(`
    CREATE TABLE IF NOT EXISTS ky_majors (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      name VARCHAR(200) NOT NULL,
      code VARCHAR(20),
      college VARCHAR(200),
      is_hot TINYINT DEFAULT 0,
      paper_count INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_school (school_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  // ky_exam_papers
  await db.query(`
    CREATE TABLE IF NOT EXISTS ky_exam_papers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      school_id INT NOT NULL,
      major_id INT NOT NULL,
      subject_name VARCHAR(200) NOT NULL,
      year INT NOT NULL,
      file_path VARCHAR(500),
      preview_path VARCHAR(500),
      file_type VARCHAR(20),
      file_size INT DEFAULT 0,
      price DECIMAL(10,2) DEFAULT 0,
      is_active TINYINT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_school (school_id),
      INDEX idx_major (major_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  // ky_orders
  await db.query(`
    CREATE TABLE IF NOT EXISTS ky_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_no VARCHAR(50) NOT NULL UNIQUE,
      user_id INT NOT NULL,
      order_type VARCHAR(20) DEFAULT 'single',
      school_id INT,
      major_id INT,
      paper_ids JSON,
      amount DECIMAL(10,2) DEFAULT 0,
      email VARCHAR(200),
      pay_status VARCHAR(20) DEFAULT 'pending',
      deliver_status VARCHAR(20) DEFAULT 'pending',
      paid_at DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id),
      INDEX idx_order_no (order_no)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});

  // ky_email_logs
  await db.query(`
    CREATE TABLE IF NOT EXISTS ky_email_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT,
      user_id INT,
      email VARCHAR(200),
      subject VARCHAR(500),
      status VARCHAR(20) DEFAULT 'pending',
      error_msg TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});
};
