// Ordered, append-only schema migrations. Each runs once (tracked in the
// schema_migrations table) so new columns reach databases that already exist —
// including ones restored from a snapshot. Never edit a migration after it has
// shipped; add a new one instead.
module.exports = [
  {
    id: 1,
    name: 'baseline tickets and articles',
    sql: [
      `CREATE TABLE IF NOT EXISTS tickets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        subject VARCHAR(255) NOT NULL,
        requester VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS articles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        category VARCHAR(100) NOT NULL,
        body TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
    ],
  },
  {
    id: 2,
    name: 'users and ticket ownership',
    sql: [
      // Local mirror of Cognito users (filled in at sign-in) so the app can list
      // people and resolve names without calling Cognito on every page.
      `CREATE TABLE IF NOT EXISTS users (
        sub VARCHAR(64) PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'customer',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP NULL
      )`,
      // NULL for tickets created before accounts existed; only staff can see those.
      `ALTER TABLE tickets ADD COLUMN created_by VARCHAR(64) NULL`,
      `ALTER TABLE tickets ADD INDEX idx_tickets_created_by (created_by)`,
    ],
  },
  {
    id: 3,
    name: 'ticket assignment',
    sql: [
      `ALTER TABLE tickets ADD COLUMN assignee_sub VARCHAR(64) NULL`,
      `ALTER TABLE tickets ADD INDEX idx_tickets_assignee (assignee_sub)`,
    ],
  },
];
