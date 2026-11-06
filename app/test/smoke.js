// Quick checks that need no database or AWS access. The CI pipeline runs this
// before building anything: `npm test`.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ejs = require('ejs');

const root = path.join(__dirname, '..');
let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok   ${name}`); } catch (err) { failed++; console.error(`FAIL ${name}: ${err.message}`); }
};

check('server.js has valid syntax', () => execFileSync(process.execPath, ['--check', path.join(root, 'server.js')]));

const views = path.join(root, 'views');
for (const file of fs.readdirSync(views).filter((f) => f.endsWith('.ejs'))) {
  check(`view compiles: ${file}`, () => ejs.compile(fs.readFileSync(path.join(views, file), 'utf8'), { filename: path.join(views, file) }));
}

if (failed) process.exit(1);
console.log('All smoke checks passed');
