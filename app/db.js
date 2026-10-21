const mysql = require('mysql2/promise');
const migrations = require('./migrations');
const logger = require('./logger');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

// Applies any migrations not yet recorded. A MySQL named lock makes this safe
// when several Fargate tasks start at once: one migrates, the rest wait, then
// find nothing left to do.
async function migrate() {
  const conn = await pool.getConnection();
  try {
    await conn.query("SELECT GET_LOCK('support_portal_migrate', 60)");
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    const [done] = await conn.query('SELECT id FROM schema_migrations');
    const applied = new Set(done.map((r) => r.id));
    for (const m of migrations.filter((x) => !applied.has(x.id))) {
      for (const statement of m.sql) await conn.query(statement);
      await conn.query('INSERT INTO schema_migrations (id, name) VALUES (?, ?)', [m.id, m.name]);
      logger.info('Applied migration', { id: m.id, name: m.name });
    }
  } finally {
    await conn.query("SELECT RELEASE_LOCK('support_portal_migrate')").catch(() => {});
    conn.release();
  }
}

module.exports = { pool, migrate };
