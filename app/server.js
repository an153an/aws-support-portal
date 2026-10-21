require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const cookieSession = require('cookie-session');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const auth = require('./auth');
const { pool, migrate } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Behind the ALB the client's connection is HTTP; trust X-Forwarded-* from it.
app.set('trust proxy', 1);
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not set; using a random key (sessions reset on restart).');
app.use(cookieSession({
  name: 'sp_session',
  keys: [process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')],
  maxAge: 8 * 60 * 60 * 1000, // matches the 8h Cognito ID token lifetime
  httpOnly: true,
  sameSite: 'lax', // blocks cross-site form POSTs, which is the CSRF vector for this app
  secure: process.env.COOKIE_SECURE === 'true', // set once the ALB serves HTTPS
}));
app.use(auth.attachUser);

// Express 4 does not catch rejected promises from async handlers; without this
// a failed query would crash the process.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const { requireLogin, requireRole, isStaff } = auth;
const staffOnly = requireRole('agent', 'admin');
const adminOnly = requireRole('admin');

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

// ---- Sign in / sign up / sign out ----
// Only same-site relative paths are honoured, so ?next= can't be an open redirect.
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/tickets');

async function startSession(req, user) {
  await pool.query(
    `INSERT INTO users (sub, email, name, role, last_login) VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name), role = VALUES(role), last_login = NOW()`,
    [user.sub, user.email, user.name, user.role]
  );
  req.session.user = user;
}

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/tickets');
  res.render('login', { error: null, email: '', next: safeNext(req.query.next) });
});

app.post('/login', wrap(async (req, res) => {
  const { email = '', password = '', next } = req.body;
  try {
    await startSession(req, await auth.login(email.trim().toLowerCase(), password));
  } catch (err) {
    if (!(err instanceof auth.AuthError)) throw err;
    return res.status(401).render('login', { error: err.message, email, next: safeNext(next) });
  }
  res.redirect(safeNext(next));
}));

app.get('/register', (req, res) => {
  if (req.user) return res.redirect('/tickets');
  res.render('register', { error: null, name: '', email: '' });
});

app.post('/register', wrap(async (req, res) => {
  const { name = '', email = '', password = '', confirm = '' } = req.body;
  const cleanEmail = email.trim().toLowerCase();
  const fail = (message) => res.status(400).render('register', { error: message, name, email });
  if (!name.trim()) return fail('Please enter your name.');
  if (password !== confirm) return fail('Passwords do not match.');
  try {
    await auth.register(name.trim(), cleanEmail, password);
    await startSession(req, await auth.login(cleanEmail, password));
  } catch (err) {
    if (!(err instanceof auth.AuthError)) throw err;
    return fail(err.message);
  }
  res.redirect('/tickets');
}));

app.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

// Everything below requires a signed-in user.
app.use(requireLogin);

// The role in the cookie can be stale after an admin changes it, so take the
// current one from the users table on every request.
app.use(wrap(async (req, res, next) => {
  const [rows] = await pool.query('SELECT role FROM users WHERE sub = ?', [req.user.sub]);
  if (rows.length) req.user.role = res.locals.user.role = rows[0].role;
  next();
}));

const getStaff = async () => (await pool.query(
  "SELECT sub, name, role FROM users WHERE role IN ('agent', 'admin') ORDER BY name"))[0];

app.get('/', (req, res) => res.redirect('/tickets'));

// ---- Tickets ----
// Customers only ever see tickets they created; agents and admins see all.
app.get('/tickets', wrap(async (req, res) => {
  const select = 'SELECT t.*, a.name AS assignee_name FROM tickets t LEFT JOIN users a ON a.sub = t.assignee_sub';
  const [rows] = isStaff(req.user)
    ? await pool.query(`${select} ORDER BY t.created_at DESC`)
    : await pool.query(`${select} WHERE t.created_by = ? ORDER BY t.created_at DESC`, [req.user.sub]);
  res.render('tickets', { tickets: rows, staff: isStaff(req.user) ? await getStaff() : [] });
}));

app.post('/tickets', wrap(async (req, res) => {
  const { subject, description } = req.body;
  await pool.query(
    'INSERT INTO tickets (subject, requester, description, created_by) VALUES (?, ?, ?, ?)',
    [subject, req.user.name, description, req.user.sub]
  );
  res.redirect('/tickets');
}));

app.post('/tickets/:id/status', staffOnly, wrap(async (req, res) => {
  const { status } = req.body;
  if (!['open', 'in_progress', 'closed'].includes(status)) return res.redirect('/tickets');
  await pool.query('UPDATE tickets SET status = ? WHERE id = ?', [status, req.params.id]);
  res.redirect('/tickets');
}));

app.post('/tickets/:id/assign', staffOnly, wrap(async (req, res) => {
  const assignee = req.body.assignee || null;
  if (assignee) {
    const [rows] = await pool.query("SELECT sub FROM users WHERE sub = ? AND role IN ('agent', 'admin')", [assignee]);
    if (!rows.length) return res.status(400).render('error', { title: 'Invalid assignee', message: 'Tickets can only be assigned to agents or admins.' });
  }
  await pool.query('UPDATE tickets SET assignee_sub = ? WHERE id = ?', [assignee, req.params.id]);
  res.redirect('/tickets');
}));

app.post('/tickets/:id/delete', adminOnly, wrap(async (req, res) => {
  await pool.query('DELETE FROM tickets WHERE id = ?', [req.params.id]);
  res.redirect('/tickets');
}));

// ---- Knowledge Base ----
app.get('/kb', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM articles ORDER BY created_at DESC');
  res.render('kb', { articles: rows });
}));

app.get('/kb/:id', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM articles WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.redirect('/kb');
  res.render('article', { article: rows[0] });
}));

app.post('/kb', staffOnly, wrap(async (req, res) => {
  const { title, category, body } = req.body;
  await pool.query(
    'INSERT INTO articles (title, category, body) VALUES (?, ?, ?)',
    [title, category, body]
  );
  res.redirect('/kb');
}));

app.post('/kb/:id/delete', adminOnly, wrap(async (req, res) => {
  await pool.query('DELETE FROM articles WHERE id = ?', [req.params.id]);
  res.redirect('/kb');
}));

// ---- User management (admin) ----
app.get('/admin/users', adminOnly, wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT sub, email, name, role, last_login FROM users ORDER BY name');
  res.render('users', { users: rows, roles: auth.ROLES, message: req.query.msg || null });
}));

app.post('/admin/users/:sub/role', adminOnly, wrap(async (req, res) => {
  const { role } = req.body;
  if (!auth.ROLES.includes(role)) return res.redirect('/admin/users');
  if (req.params.sub === req.user.sub) return res.redirect('/admin/users?msg=' + encodeURIComponent("You can't change your own role."));
  const [rows] = await pool.query('SELECT email FROM users WHERE sub = ?', [req.params.sub]);
  if (!rows.length) return res.redirect('/admin/users');
  await auth.setRole(rows[0].email, role);
  await pool.query('UPDATE users SET role = ? WHERE sub = ?', [role, req.params.sub]);
  res.redirect('/admin/users?msg=' + encodeURIComponent('Role updated.'));
}));

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
});

fetchStaticAsset()
  .catch((err) => console.error('Could not fetch static asset from S3, using bundled copy:', err.message))
  .then(() => migrate())
  .then(() => {
    app.listen(PORT, () => console.log(`Support portal running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
