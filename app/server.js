require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      subject VARCHAR(255) NOT NULL,
      requester VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'open',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS articles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      category VARCHAR(100) NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Pulls the static asset from the private S3 bucket, authenticated via the
// ECS task's IAM role — no credentials in the image or the environment.
async function fetchStaticAsset() {
  const bucket = process.env.ASSETS_BUCKET;
  const key = process.env.ASSETS_KEY;
  if (!bucket || !key) return;

  const client = new S3Client({});
  const { Body } = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await pipeline(Body, fs.createWriteStream(path.join(__dirname, 'public', 'style.css')));
}

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/', (req, res) => res.redirect('/tickets'));

// ---- Tickets ----
app.get('/tickets', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM tickets ORDER BY created_at DESC');
  res.render('tickets', { tickets: rows });
});

app.post('/tickets', async (req, res) => {
  const { subject, requester, description } = req.body;
  await pool.query(
    'INSERT INTO tickets (subject, requester, description) VALUES (?, ?, ?)',
    [subject, requester, description]
  );
  res.redirect('/tickets');
});

app.post('/tickets/:id/status', async (req, res) => {
  const { status } = req.body;
  await pool.query('UPDATE tickets SET status = ? WHERE id = ?', [status, req.params.id]);
  res.redirect('/tickets');
});

app.post('/tickets/:id/delete', async (req, res) => {
  await pool.query('DELETE FROM tickets WHERE id = ?', [req.params.id]);
  res.redirect('/tickets');
});

// ---- Knowledge Base ----
app.get('/kb', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM articles ORDER BY created_at DESC');
  res.render('kb', { articles: rows });
});

app.get('/kb/:id', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM articles WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.redirect('/kb');
  res.render('article', { article: rows[0] });
});

app.post('/kb', async (req, res) => {
  const { title, category, body } = req.body;
  await pool.query(
    'INSERT INTO articles (title, category, body) VALUES (?, ?, ?)',
    [title, category, body]
  );
  res.redirect('/kb');
});

app.post('/kb/:id/delete', async (req, res) => {
  await pool.query('DELETE FROM articles WHERE id = ?', [req.params.id]);
  res.redirect('/kb');
});

fetchStaticAsset()
  .catch((err) => console.error('Could not fetch static asset from S3, using bundled copy:', err.message))
  .then(() => initDb())
  .then(() => {
    app.listen(PORT, () => console.log(`Support portal running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
