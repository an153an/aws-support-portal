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
  {
    id: 4,
    name: 'ticket priority and category',
    sql: [
      `ALTER TABLE tickets ADD COLUMN priority VARCHAR(20) NOT NULL DEFAULT 'medium'`,
      `ALTER TABLE tickets ADD COLUMN category VARCHAR(100) NOT NULL DEFAULT 'general'`,
    ],
  },
  {
    id: 5,
    name: 'ticket comments, history and closed_at',
    sql: [
      `ALTER TABLE tickets ADD COLUMN closed_at TIMESTAMP NULL`,
      // parent_id makes replies threaded; deleting a ticket (or a parent comment) cascades.
      `CREATE TABLE IF NOT EXISTS ticket_comments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ticket_id INT NOT NULL,
        parent_id INT NULL,
        author_sub VARCHAR(64) NOT NULL,
        author_name VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_comments_ticket (ticket_id),
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES ticket_comments(id) ON DELETE CASCADE
      )`,
      // One row per change to a ticket field: who, what, from, to, when.
      `CREATE TABLE IF NOT EXISTS ticket_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ticket_id INT NOT NULL,
        actor_sub VARCHAR(64) NOT NULL,
        actor_name VARCHAR(255) NOT NULL,
        field VARCHAR(50) NOT NULL,
        old_value VARCHAR(255) NULL,
        new_value VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_history_ticket (ticket_id),
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
      )`,
    ],
  },
  {
    id: 6,
    name: 'updated_at for edited tickets and articles',
    sql: [
      `ALTER TABLE tickets ADD COLUMN updated_at TIMESTAMP NULL`,
      `ALTER TABLE articles ADD COLUMN updated_at TIMESTAMP NULL`,
    ],
  },
  {
    id: 7,
    name: 'ticket attachments',
    sql: [
      // The file itself lives in S3 under s3_key; this row is its metadata.
      `CREATE TABLE IF NOT EXISTS ticket_attachments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ticket_id INT NOT NULL,
        s3_key VARCHAR(512) NOT NULL,
        filename VARCHAR(255) NOT NULL,
        content_type VARCHAR(255) NOT NULL,
        size_bytes BIGINT NOT NULL,
        uploaded_by_sub VARCHAR(64) NOT NULL,
        uploaded_by_name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_attachments_ticket (ticket_id),
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
      )`,
    ],
  },
];
