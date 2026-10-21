// Fast checks that need no database, AWS credentials or network. Run in CI
// before anything is built or deployed: `npm test`.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const root = path.join(__dirname, '..');
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok   ${name}`); } catch (err) { failures++; console.error(`FAIL ${name}\n     ${err.message}`); }
};

// Every view must at least compile (catches EJS syntax errors before deploy).
const viewsDir = path.join(root, 'views');
for (const file of fs.readdirSync(viewsDir).filter((f) => f.endsWith('.ejs'))) {
  check(`view compiles: ${file}`, () => ejs.compile(fs.readFileSync(path.join(viewsDir, file), 'utf8'), { filename: path.join(viewsDir, file) }));
}

// Migrations are append-only and must stay in order with no gaps or repeats.
check('migrations are sequential', () => {
  const migrations = require('../migrations');
  migrations.forEach((m, i) => {
    assert.strictEqual(m.id, i + 1, `migration at position ${i + 1} has id ${m.id}`);
    assert.ok(m.name && Array.isArray(m.sql) && m.sql.length, `migration ${m.id} needs a name and sql`);
  });
});

check('auth role resolution', () => {
  const { roleFromGroups } = require('../auth');
  assert.strictEqual(roleFromGroups(['customer', 'agent']), 'agent');
  assert.strictEqual(roleFromGroups(['admin', 'agent']), 'admin');
  assert.strictEqual(roleFromGroups([]), 'customer');
});

check('attachment filenames are sanitised', () => {
  const { safeName } = require('../storage');
  assert.strictEqual(safeName('../../etc/passwd'), 'passwd');
  assert.strictEqual(safeName('a b?.pdf'), 'a b_.pdf');
});

check('logger emits JSON', () => {
  const out = [];
  const real = process.stdout.write;
  process.stdout.write = (c) => { out.push(c); return true; };
  try { require('../logger').info('hello', { a: 1 }); } finally { process.stdout.write = real; }
  const line = JSON.parse(out.join(''));
  assert.strictEqual(line.msg, 'hello');
  assert.strictEqual(line.level, 'info');
});

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('All smoke checks passed');
