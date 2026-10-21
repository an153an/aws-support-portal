const crypto = require('crypto');

// One JSON object per line on stdout. ECS ships stdout to CloudWatch Logs, where
// Logs Insights and metric filters can query fields like level, status, duration_ms.
function log(level, msg, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

const info = (msg, fields) => log('info', msg, fields);
const warn = (msg, fields) => log('warn', msg, fields);
const error = (msg, fields) => log('error', msg, fields);

// Errors carry their stack in a field so it stays inside one log event.
const errorFields = (err) => ({ error: err && err.message, stack: err && err.stack });

// Access log: one line per request, written when the response finishes. 5xx is
// logged at error level (this feeds the "app errors" alarm), 4xx at warn.
function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  req.id = req.headers['x-amzn-trace-id'] || crypto.randomUUID();
  res.on('finish', () => {
    if (req.path === '/health') return; // ALB polls this every few seconds
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log(level, 'request', {
      req_id: req.id,
      method: req.method,
      path: req.path, // no query string: searches can contain personal data
      status: res.statusCode,
      duration_ms: Math.round(Number(process.hrtime.bigint() - start) / 1e6),
      user: req.user ? req.user.sub : undefined,
      role: req.user ? req.user.role : undefined,
    });
  });
  next();
}

module.exports = { log, info, warn, error, errorFields, requestLogger };
