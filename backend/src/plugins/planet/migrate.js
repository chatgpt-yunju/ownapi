const db = require('../../config/db');

module.exports = async function migrate() {
  const cols = [
    "ALTER TABLE planet_posts ADD COLUMN rewrite_status ENUM('pending','completed','failed') DEFAULT 'completed'",
    "ALTER TABLE planet_posts ADD COLUMN publish_status ENUM('draft','scheduled','published') DEFAULT 'published'",
    "ALTER TABLE planet_posts ADD COLUMN published_at DATETIME DEFAULT NULL",
    "ALTER TABLE planet_circles ADD COLUMN ai_rewrite_enabled TINYINT DEFAULT 0",
    "ALTER TABLE planet_circles ADD COLUMN ai_rewrite_model VARCHAR(100) DEFAULT NULL",
  ];
  for (const sql of cols) {
    await db.query(sql).catch(() => {});
  }
};
