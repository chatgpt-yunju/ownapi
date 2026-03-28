module.exports = async function migrate(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS openclaw_money_cases (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(500) NOT NULL,
      content TEXT,
      source_url VARCHAR(1000),
      platform VARCHAR(50) DEFAULT 'other',
      author VARCHAR(100),
      income_keyword VARCHAR(200),
      status ENUM('active','hidden') DEFAULT 'active',
      collected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_platform (platform),
      INDEX idx_status (status),
      INDEX idx_collected (collected_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});
};
