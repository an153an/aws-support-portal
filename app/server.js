require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cookieSession = require('cookie-session');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // behind the load balancer
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Admin sign-in is a single shared password (from Secrets Manager on AWS) that
// sets a signed, HTTP-only session cookie. Everyone else sees the user view.
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET not set; admin sessions reset on every restart.');
app.use(cookieSession({
  name: 'sp_admin',
  keys: [process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')],
  maxAge: 8 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax', // stops other sites from submitting admin forms for you
}));
app.use((req, res, next) => {
  res.locals.isAdmin = !!req.session.admin;
  next();
});

const requireAdmin = (req, res, next) => (req.session.admin ? next() : res.redirect('/admin/login'));
// Express 4 doesn't catch rejected promises from async handlers; this does.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

const STATUSES = ['open', 'in_progress', 'closed'];

async function addColumnIfMissing(table, column, definition) {
  const [rows] = await pool.query(
    'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, column]);
  if (!rows.length) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

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
  // Added with the user/admin split; safe to run on a database that already has tickets.
  await addColumnIfMissing('tickets', 'email', "VARCHAR(255) NOT NULL DEFAULT ''");
  await addColumnIfMissing('tickets', 'response', 'TEXT NULL');
  await addColumnIfMissing('tickets', 'responded_at', 'TIMESTAMP NULL');
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

// =====================  USER VIEW  =====================

// Submit a ticket
app.get('/', (req, res) => res.render('home', { error: null, form: {} }));

app.post('/tickets', wrap(async (req, res) => {
  const form = {
    requester: (req.body.requester || '').trim(),
    email: (req.body.email || '').trim().toLowerCase(),
    subject: (req.body.subject || '').trim(),
    description: (req.body.description || '').trim(),
  };
  if (!form.requester || !form.subject || !form.description || !/^\S+@\S+\.\S+$/.test(form.email)) {
    return res.status(400).render('home', { error: 'Please fill in every field with a valid email address.', form });
  }
  const [result] = await pool.query(
    'INSERT INTO tickets (subject, requester, email, description) VALUES (?, ?, ?, ?)',
    [form.subject, form.requester, form.email, form.description]
  );
  res.render('submitted', { ticketId: result.insertId });
}));

// Check a ticket's status and read the support team's response. Without
// accounts, the ticket number plus the email it was filed with is the key.
app.get('/status', (req, res) => res.render('status', { ticket: null, error: null, form: {} }));

app.post('/status', wrap(async (req, res) => {
  const form = { ticketId: (req.body.ticketId || '').replace(/[^0-9]/g, ''), email: (req.body.email || '').trim().toLowerCase() };
  // Tickets filed before email was collected have an empty email; never match those.
  const [rows] = form.email
    ? await pool.query("SELECT * FROM tickets WHERE id = ? AND email <> '' AND LOWER(email) = ?", [form.ticketId || 0, form.email])
    : [[]];
  if (!rows.length) {
    return res.status(404).render('status', { ticket: null, form, error: 'We could not find a ticket with that number and email.' });
  }
  res.render('status', { ticket: rows[0], error: null, form });
}));

// Knowledge base: anyone can read; only admins see the publish/delete controls
app.get('/kb', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM articles ORDER BY created_at DESC');
  res.render('kb', { articles: rows });
}));

app.get('/kb/:id', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM articles WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.redirect('/kb');
  res.render('article', { article: rows[0] });
}));

// Old bookmark: the ticket list is now the admin view
app.get('/tickets', (req, res) => res.redirect(req.session.admin ? '/admin' : '/'));

// =====================  ADMIN VIEW  =====================

app.get('/admin/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.render('admin-login', { error: null });
});

app.post('/admin/login', wrap(async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  // Compare fixed-length hashes in constant time so timing doesn't leak the password.
  const hash = (v) => crypto.createHash('sha256').update(String(v || '')).digest();
  const ok = !!expected && crypto.timingSafeEqual(hash(req.body.password), hash(expected));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 600)); // slows down password guessing
    const error = expected ? 'Incorrect password.' : 'Admin sign-in is not configured on this server.';
    return res.status(401).render('admin-login', { error });
  }
  req.session.admin = true;
  res.redirect('/admin');
}));

app.post('/admin/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// All tickets, with counts and a status filter
app.get('/admin', requireAdmin, wrap(async (req, res) => {
  const filter = STATUSES.includes(req.query.status) ? req.query.status : '';
  const [counts] = await pool.query('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status');
  const count = (s) => Number((counts.find((c) => c.status === s) || {}).n || 0);
  const [tickets] = filter
    ? await pool.query('SELECT * FROM tickets WHERE status = ? ORDER BY created_at DESC', [filter])
    : await pool.query('SELECT * FROM tickets ORDER BY created_at DESC');
  res.render('admin-tickets', {
    tickets, filter,
    counts: { open: count('open'), in_progress: count('in_progress'), closed: count('closed') },
  });
}));

// One ticket: read it, respond, change status
app.get('/admin/tickets/:id', requireAdmin, wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.redirect('/admin');
  res.render('admin-ticket', { ticket: rows[0], saved: req.query.saved === '1' });
}));

app.post('/admin/tickets/:id', requireAdmin, wrap(async (req, res) => {
  const response = (req.body.response || '').trim();
  const status = STATUSES.includes(req.body.status) ? req.body.status : 'open';
  const [rows] = await pool.query('SELECT response FROM tickets WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.redirect('/admin');
  // responded_at only moves when the response text actually changes
  const changed = response !== (rows[0].response || '');
  await pool.query(
    `UPDATE tickets SET status = ?, response = ?, responded_at = ${changed && response ? 'NOW()' : 'responded_at'} WHERE id = ?`,
    [status, response || null, req.params.id]);
  res.redirect(`/admin/tickets/${req.params.id}?saved=1`);
}));

app.post('/admin/tickets/:id/delete', requireAdmin, wrap(async (req, res) => {
  await pool.query('DELETE FROM tickets WHERE id = ?', [req.params.id]);
  res.redirect('/admin');
}));

// Knowledge base management (admin only)
app.post('/kb', requireAdmin, wrap(async (req, res) => {
  const { title, category, body } = req.body;
  await pool.query('INSERT INTO articles (title, category, body) VALUES (?, ?, ?)', [title, category, body]);
  res.redirect('/kb');
}));

app.post('/kb/:id/delete', requireAdmin, wrap(async (req, res) => {
  await pool.query('DELETE FROM articles WHERE id = ?', [req.params.id]);
  res.redirect('/kb');
}));

app.use((req, res) => res.status(404).render('message', { title: 'Page not found', message: 'That page does not exist.' }));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).render('message', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
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
