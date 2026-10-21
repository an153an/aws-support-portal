require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const cookieSession = require('cookie-session');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const auth = require('./auth');
const storage = require('./storage');
const logger = require('./logger');
const { pool, migrate } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Behind the ALB the client's connection is HTTP; trust X-Forwarded-* from it.
app.set('trust proxy', 1);
if (!process.env.SESSION_SECRET) logger.warn('SESSION_SECRET is not set; using a random key (sessions reset on restart).');
app.use(cookieSession({
  name: 'sp_session',
  keys: [process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')],
  maxAge: 8 * 60 * 60 * 1000, // matches the 8h Cognito ID token lifetime
  httpOnly: true,
  sameSite: 'lax', // blocks cross-site form POSTs, which is the CSRF vector for this app
  secure: process.env.COOKIE_SECURE === 'true', // set once the ALB serves HTTPS
}));
app.use(auth.attachUser);
app.use(logger.requestLogger);

// Express 4 does not catch rejected promises from async handlers; without this
// a failed query would crash the process.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.log', '.csv', '.json', '.zip', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
app.locals.formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

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

app.get('/', (req, res) => res.redirect(isStaff(req.user) ? '/dashboard' : '/tickets'));

// ---- Dashboard (staff) ----
// "12m", "3h 5m", "2d 4h" — for the average-time-to-close figure.
function formatMinutes(mins) {
  if (mins == null) return '—';
  const m = Math.round(mins);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

app.get('/dashboard', staffOnly, wrap(async (req, res) => {
  const [[byStatus], [openByPriority], [[stats]]] = await Promise.all([
    pool.query('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status'),
    pool.query("SELECT priority, COUNT(*) AS n FROM tickets WHERE status <> 'closed' GROUP BY priority"),
    pool.query(`SELECT
      COUNT(*) AS total,
      SUM(status <> 'closed' AND assignee_sub IS NULL) AS unassigned_open,
      SUM(status <> 'closed' AND assignee_sub = ?) AS mine_open,
      SUM(created_at >= NOW() - INTERVAL 7 DAY) AS opened_7d,
      SUM(closed_at >= NOW() - INTERVAL 7 DAY) AS closed_7d,
      AVG(CASE WHEN status = 'closed' AND closed_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, created_at, closed_at) END) AS avg_close_min,
      SUM(status = 'closed' AND closed_at IS NOT NULL) AS closed_measured
      FROM tickets`, [req.user.sub]),
  ]);
  const count = (rows, key, value) => Number((rows.find((r) => r[key] === value) || {}).n || 0);
  res.render('dashboard', {
    total: Number(stats.total),
    status: Object.fromEntries(STATUSES.map((s) => [s, count(byStatus, 'status', s)])),
    priority: Object.fromEntries(PRIORITIES.map((p) => [p, count(openByPriority, 'priority', p)])),
    unassignedOpen: Number(stats.unassigned_open || 0),
    mineOpen: Number(stats.mine_open || 0),
    opened7d: Number(stats.opened_7d || 0),
    closed7d: Number(stats.closed_7d || 0),
    avgClose: formatMinutes(stats.avg_close_min == null ? null : Number(stats.avg_close_min)),
    closedMeasured: Number(stats.closed_measured || 0),
  });
}));

// ---- Pagination, sorting ----
const PAGE_SIZE = 10;
function paginate(req, total) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);
  return { page, pages, total, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE };
}

// Whitelisted ORDER BY expressions: the sort key from the URL is only ever a
// lookup key, never interpolated into SQL.
const TICKET_SORTS = {
  newest: 't.created_at DESC, t.id DESC',
  oldest: 't.created_at ASC, t.id ASC',
  priority: "FIELD(t.priority, 'urgent', 'high', 'medium', 'low'), t.created_at DESC",
  status: "FIELD(t.status, 'open', 'in_progress', 'closed'), t.created_at DESC",
  subject: 't.subject ASC, t.id ASC',
};
const ARTICLE_SORTS = {
  newest: 'created_at DESC, id DESC',
  oldest: 'created_at ASC, id ASC',
  title: 'title ASC, id ASC',
};

// Lets views build links that keep the current search/sort: qs({ page: 2 }).
app.use((req, res, next) => {
  res.locals.qs = (overrides = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...req.query, ...overrides })) if (v !== '' && v != null) p.set(k, v);
    const str = p.toString();
    return str ? `?${str}` : '';
  };
  next();
});

// ---- Search helpers ----
// Escapes % and _ so user input is matched literally inside LIKE.
const like = (v) => `%${String(v).replace(/[\\%_]/g, '\\$&')}%`;
const STATUSES = ['open', 'in_progress', 'closed'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const CATEGORIES = ['general', 'account', 'billing', 'bug', 'feature request', 'other'];
const pick = (value, allowed, fallback = '') => (allowed.includes(value) ? value : fallback);
app.locals.PRIORITIES = PRIORITIES;
app.locals.CATEGORIES = CATEGORIES;

// Builds the WHERE clause for the ticket list from the query string.
// Customers are always restricted to their own tickets, whatever they ask for.
function ticketFilters(req) {
  const q = (req.query.q || '').trim();
  const requester = isStaff(req.user) ? (req.query.requester || '').trim() : '';
  const status = pick(req.query.status, STATUSES);
  const priority = pick(req.query.priority, PRIORITIES);
  const category = pick(req.query.category, CATEGORIES);
  const where = [];
  const params = [];
  if (!isStaff(req.user)) { where.push('t.created_by = ?'); params.push(req.user.sub); }
  if (q) { where.push('(t.subject LIKE ? OR t.description LIKE ?)'); params.push(like(q), like(q)); }
  if (requester) { where.push('t.requester LIKE ?'); params.push(like(requester)); }
  if (status) { where.push('t.status = ?'); params.push(status); }
  if (priority) { where.push('t.priority = ?'); params.push(priority); }
  if (category) { where.push('t.category = ?'); params.push(category); }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params, filters: { q, requester, status, priority, category } };
}

// ---- Tickets ----
app.get('/tickets', wrap(async (req, res) => {
  const { where, params, filters } = ticketFilters(req);
  const sort = pick(req.query.sort, Object.keys(TICKET_SORTS), 'newest');
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM tickets t ${where}`, params);
  const pager = paginate(req, n);
  const [rows] = await pool.query(
    `SELECT t.*, a.name AS assignee_name FROM tickets t LEFT JOIN users a ON a.sub = t.assignee_sub
     ${where} ORDER BY ${TICKET_SORTS[sort]} LIMIT ? OFFSET ?`, [...params, pager.limit, pager.offset]);
  res.render('tickets', { tickets: rows, filters, sort, sorts: Object.keys(TICKET_SORTS), pager, path: '/tickets', staff: isStaff(req.user) ? await getStaff() : [] });
}));

app.post('/tickets', wrap(async (req, res) => {
  const { subject, description } = req.body;
  await pool.query(
    'INSERT INTO tickets (subject, requester, description, created_by, priority, category) VALUES (?, ?, ?, ?, ?, ?)',
    [subject, req.user.name, description, req.user.sub, pick(req.body.priority, PRIORITIES, 'medium'), pick(req.body.category, CATEGORIES, 'general')]
  );
  res.redirect('/tickets');
}));

// Returns the ticket if this user may see it. Customers get a 404 (not a 403)
// for other people's tickets so ticket ids can't be probed.
async function loadTicket(req, res) {
  const [rows] = await pool.query(
    `SELECT t.*, a.name AS assignee_name FROM tickets t LEFT JOIN users a ON a.sub = t.assignee_sub WHERE t.id = ?`,
    [req.params.id]);
  const ticket = rows[0];
  if (!ticket || (!isStaff(req.user) && ticket.created_by !== req.user.sub)) {
    res.status(404).render('error', { title: 'Not found', message: 'That ticket does not exist.' });
    return null;
  }
  return ticket;
}

const logChange = (ticketId, user, field, from, to) => pool.query(
  'INSERT INTO ticket_history (ticket_id, actor_sub, actor_name, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)',
  [ticketId, user.sub, user.name, field, from, to]);

// Forms on the detail page send back=detail so staff land where they were.
const backTo = (req, id) => (req.body.back === 'detail' ? `/tickets/${id}` : '/tickets');

app.get('/tickets/:id', wrap(async (req, res) => {
  const ticket = await loadTicket(req, res);
  if (!ticket) return;
  const [comments] = await pool.query('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at, id', [ticket.id]);
  const [history] = await pool.query('SELECT * FROM ticket_history WHERE ticket_id = ? ORDER BY created_at, id', [ticket.id]);
  const [attachments] = await pool.query('SELECT * FROM ticket_attachments WHERE ticket_id = ? ORDER BY created_at, id', [ticket.id]);
  // Nest replies under their parent comment.
  const byId = new Map(comments.map((c) => [c.id, { ...c, replies: [] }]));
  const thread = [];
  for (const c of byId.values()) (byId.get(c.parent_id) ? byId.get(c.parent_id).replies : thread).push(c);
  res.render('ticket', { ticket, attachments, uploadsEnabled: storage.enabled(), maxMb: MAX_UPLOAD_BYTES / 1048576, canEdit: canEdit(req.user, ticket), thread, commentCount: comments.length, history, staff: isStaff(req.user) ? await getStaff() : [] });
}));

app.post('/tickets/:id/comments', wrap(async (req, res) => {
  const ticket = await loadTicket(req, res);
  if (!ticket) return;
  const body = (req.body.body || '').trim();
  if (body) {
    let parentId = null;
    if (req.body.parent_id) {
      const [p] = await pool.query('SELECT id FROM ticket_comments WHERE id = ? AND ticket_id = ?', [req.body.parent_id, ticket.id]);
      parentId = p.length ? p[0].id : null;
    }
    await pool.query(
      'INSERT INTO ticket_comments (ticket_id, parent_id, author_sub, author_name, body) VALUES (?, ?, ?, ?, ?)',
      [ticket.id, parentId, req.user.sub, req.user.name, body]);
  }
  res.redirect(`/tickets/${ticket.id}#comments`);
}));

// Staff can edit any ticket; a customer can edit their own until it is closed.
const canEdit = (user, ticket) => isStaff(user) || (ticket.created_by === user.sub && ticket.status !== 'closed');

app.get('/tickets/:id/edit', wrap(async (req, res) => {
  const ticket = await loadTicket(req, res);
  if (!ticket) return;
  if (!canEdit(req.user, ticket)) return res.status(403).render('error', { title: 'Not allowed', message: 'Closed tickets can only be edited by staff.' });
  res.render('ticket-edit', { ticket, error: null });
}));

app.post('/tickets/:id/edit', wrap(async (req, res) => {
  const ticket = await loadTicket(req, res);
  if (!ticket) return;
  if (!canEdit(req.user, ticket)) return res.status(403).render('error', { title: 'Not allowed', message: 'Closed tickets can only be edited by staff.' });
  const subject = (req.body.subject || '').trim();
  const description = (req.body.description || '').trim();
  if (!subject || !description) {
    return res.status(400).render('ticket-edit', { ticket: { ...ticket, subject, description }, error: 'Subject and description are required.' });
  }
  const next = {
    subject, description,
    priority: pick(req.body.priority, PRIORITIES, ticket.priority),
    category: pick(req.body.category, CATEGORIES, ticket.category),
  };
  // Record each field that actually changed (the description is long, so only note that it changed).
  for (const field of ['subject', 'priority', 'category']) {
    if (next[field] !== ticket[field]) await logChange(ticket.id, req.user, field, ticket[field], next[field].slice(0, 255));
  }
  if (next.description !== ticket.description) await logChange(ticket.id, req.user, 'description', null, 'edited');
  await pool.query('UPDATE tickets SET subject = ?, description = ?, priority = ?, category = ?, updated_at = NOW() WHERE id = ?',
    [next.subject, next.description, next.priority, next.category, ticket.id]);
  res.redirect(`/tickets/${ticket.id}`);
}));

// ---- Attachments ----
// multer runs first, so a too-large file is rejected before any ticket lookup;
// its errors are turned into a friendly page rather than a 500.
const receiveFile = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  const tooBig = err.code === 'LIMIT_FILE_SIZE';
  res.status(tooBig ? 413 : 400).render('error', {
    title: 'Upload failed',
    message: tooBig ? `Files can be at most ${MAX_UPLOAD_BYTES / 1048576} MB.` : 'The upload could not be processed.',
  });
});

app.post('/tickets/:id/attachments', receiveFile, wrap(async (req, res) => {
  const ticket = await loadTicket(req, res);
  if (!ticket) return;
  const fail = (message) => res.status(400).render('error', { title: 'Upload failed', message });
  if (!storage.enabled()) return fail('File storage is not configured.');
  if (!req.file) return fail('Choose a file to attach.');
  const filename = storage.safeName(req.file.originalname);
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return fail(`Files of type "${ext || 'unknown'}" are not allowed.`);
  const key = storage.keyFor(ticket.id, filename);
  await storage.put(key, req.file.buffer, req.file.mimetype || 'application/octet-stream');
  await pool.query(
    `INSERT INTO ticket_attachments (ticket_id, s3_key, filename, content_type, size_bytes, uploaded_by_sub, uploaded_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ticket.id, key, filename, req.file.mimetype || 'application/octet-stream', req.file.size, req.user.sub, req.user.name]);
  await logChange(ticket.id, req.user, 'attachment', null, `added ${filename}`.slice(0, 255));
  res.redirect(`/tickets/${ticket.id}#attachments`);
}));

// Redirects to a short-lived presigned S3 URL after the access check, so the
// bucket stays private and the link can't be shared for long.
app.get('/tickets/:id/attachments/:aid', wrap(async (req, res) => {
  const ticket = await loadTicket(req, res);
  if (!ticket) return;
  const [rows] = await pool.query('SELECT * FROM ticket_attachments WHERE id = ? AND ticket_id = ?', [req.params.aid, ticket.id]);
  if (!rows.length) return res.status(404).render('error', { title: 'Not found', message: 'That attachment does not exist.' });
  res.redirect(await storage.downloadUrl(rows[0].s3_key, rows[0].filename));
}));

app.post('/tickets/:id/attachments/:aid/delete', wrap(async (req, res) => {
  const ticket = await loadTicket(req, res);
  if (!ticket) return;
  const [rows] = await pool.query('SELECT * FROM ticket_attachments WHERE id = ? AND ticket_id = ?', [req.params.aid, ticket.id]);
  const file = rows[0];
  if (file) {
    if (!isStaff(req.user) && file.uploaded_by_sub !== req.user.sub) {
      return res.status(403).render('error', { title: 'Not allowed', message: 'You can only remove files you uploaded.' });
    }
    await storage.remove(file.s3_key);
    await pool.query('DELETE FROM ticket_attachments WHERE id = ?', [file.id]);
    await logChange(ticket.id, req.user, 'attachment', `removed ${file.filename}`.slice(0, 255), null);
  }
  res.redirect(`/tickets/${ticket.id}#attachments`);
}));

app.post('/tickets/:id/status', staffOnly, wrap(async (req, res) => {
  const status = pick(req.body.status, STATUSES);
  const [rows] = await pool.query('SELECT status FROM tickets WHERE id = ?', [req.params.id]);
  if (status && rows.length && rows[0].status !== status) {
    // closed_at powers the "average time to close" metric; reopening clears it.
    await pool.query("UPDATE tickets SET status = ?, closed_at = IF(? = 'closed', NOW(), NULL) WHERE id = ?", [status, status, req.params.id]);
    await logChange(req.params.id, req.user, 'status', rows[0].status, status);
  }
  res.redirect(backTo(req, req.params.id));
}));

app.post('/tickets/:id/assign', staffOnly, wrap(async (req, res) => {
  const assignee = req.body.assignee || null;
  let newName = null;
  if (assignee) {
    const [rows] = await pool.query("SELECT name FROM users WHERE sub = ? AND role IN ('agent', 'admin')", [assignee]);
    if (!rows.length) return res.status(400).render('error', { title: 'Invalid assignee', message: 'Tickets can only be assigned to agents or admins.' });
    newName = rows[0].name;
  }
  const [cur] = await pool.query('SELECT a.name FROM tickets t LEFT JOIN users a ON a.sub = t.assignee_sub WHERE t.id = ?', [req.params.id]);
  if (!cur.length) return res.redirect('/tickets');
  if ((cur[0].name || null) !== newName) {
    await pool.query('UPDATE tickets SET assignee_sub = ? WHERE id = ?', [assignee, req.params.id]);
    await logChange(req.params.id, req.user, 'assignee', cur[0].name || null, newName);
  }
  res.redirect(backTo(req, req.params.id));
}));

app.post('/tickets/:id/delete', adminOnly, wrap(async (req, res) => {
  // The rows cascade, but the S3 objects don't — remove them first (best effort).
  const [files] = await pool.query('SELECT s3_key FROM ticket_attachments WHERE ticket_id = ?', [req.params.id]);
  await Promise.all(files.map((f) => storage.remove(f.s3_key).catch((err) => logger.warn('Could not delete attachment', { key: f.s3_key, error: err.message }))));
  await pool.query('DELETE FROM tickets WHERE id = ?', [req.params.id]);
  res.redirect('/tickets');
}));

// ---- Knowledge Base ----
app.get('/kb', wrap(async (req, res) => {
  const q = (req.query.q || '').trim();
  const category = (req.query.category || '').trim();
  const where = [];
  const params = [];
  if (q) { where.push('(title LIKE ? OR body LIKE ? OR category LIKE ?)'); params.push(like(q), like(q), like(q)); }
  if (category) { where.push('category = ?'); params.push(category); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const sort = pick(req.query.sort, Object.keys(ARTICLE_SORTS), 'newest');
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM articles ${clause}`, params);
  const pager = paginate(req, n);
  const [rows] = await pool.query(
    `SELECT * FROM articles ${clause} ORDER BY ${ARTICLE_SORTS[sort]} LIMIT ? OFFSET ?`, [...params, pager.limit, pager.offset]);
  const [cats] = await pool.query('SELECT DISTINCT category FROM articles ORDER BY category');
  res.render('kb', { articles: rows, categories: cats.map((c) => c.category), filters: { q, category }, sort, sorts: Object.keys(ARTICLE_SORTS), pager, path: '/kb' });
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

app.get('/kb/:id/edit', staffOnly, wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM articles WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.redirect('/kb');
  res.render('article-edit', { article: rows[0], error: null });
}));

app.post('/kb/:id/edit', staffOnly, wrap(async (req, res) => {
  const { title = '', category = '', body = '' } = req.body;
  if (!title.trim() || !category.trim() || !body.trim()) {
    return res.status(400).render('article-edit', { article: { id: req.params.id, title, category, body }, error: 'All fields are required.' });
  }
  await pool.query('UPDATE articles SET title = ?, category = ?, body = ?, updated_at = NOW() WHERE id = ?',
    [title.trim(), category.trim(), body, req.params.id]);
  res.redirect(`/kb/${req.params.id}`);
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
  logger.error('Unhandled error', { req_id: req.id, method: req.method, path: req.path, ...logger.errorFields(err) });
  if (res.headersSent) return next(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
});

fetchStaticAsset()
  .catch((err) => logger.warn('Could not fetch static asset from S3, using bundled copy', { error: err.message }))
  .then(() => migrate())
  .then(() => {
    app.listen(PORT, () => logger.info('Support portal listening', { port: Number(PORT) }));
  })
  .catch((err) => {
    logger.error('Failed to start', logger.errorFields(err));
    process.exit(1);
  });
