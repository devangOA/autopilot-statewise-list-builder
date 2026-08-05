// Runs the real orchestrator (src/index.js) against three local fixture sites,
// one per host, and asserts the resulting CSV. This is the end-to-end proof that
// discovery-seeding, enrichment, exclusion and CSV writing work together.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { COLUMNS } from '../src/schema.js';

const root = path.join(import.meta.dirname, '..');
const fixtures = path.join(import.meta.dirname, 'fixtures');

function serve(file) {
  const body = fs.readFileSync(path.join(fixtures, file));
  const s = http.createServer((req, res) => {
    if (req.url !== '/') return res.writeHead(404).end('nope');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  return new Promise((r) => s.listen(0, () => r(s)));
}

const servers = await Promise.all(['club.html', 'outdoor.html', 'park.html'].map(serve));
const urls = servers.map((s) => `http://127.0.0.1:${s.address().port}/`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'listbuilder-e2e-'));
const seedFile = path.join(tmp, 'seed.json');
const outFile = path.join(tmp, 'out.csv');
fs.writeFileSync(seedFile, JSON.stringify(urls));

// Must be async: a sync child would block this process's event loop, leaving the
// fixture servers above unable to answer the crawler's requests.
const { stdout: runLog } = await promisify(execFile)(
  process.execPath,
  ['src/index.js', '--sites-file', seedFile, '--out', outFile, '--concurrency', '3', '--cache', path.join(tmp, 'cache')],
  { cwd: root, env: { ...process.env, CRAWLER_DISABLE_PROXY: '1' }, encoding: 'utf8' },
);

if (process.env.E2E_DEBUG) console.log(runLog);
const csv = fs.readFileSync(outFile, 'utf8');
const lines = csv.trim().split('\n');

let pass = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ok  ${label}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${label}: ${e.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
};

check('header matches the required schema exactly', () =>
  assert.equal(lines[0], COLUMNS.join(',')));
check('exactly one qualifying facility survives', () => assert.equal(lines.length, 2));
check('the qualifying row is the indoor+outdoor club', () => {
  const row = lines[1];
  assert.match(row, /^Empire Racquet & Fitness Club,/);
  assert.match(row, /Indoor and Outdoor/);
  assert.match(row, /Dana,Whitfield,General Manager/);
  assert.match(row, /dwhitfield@empireracquet\.test/);
  assert.match(row, /info@empireracquet\.test/);
  assert.match(row, /,Rochester,NY,/);
});
check('outdoor-only and municipal fixtures are absent', () => {
  assert.ok(!csv.includes('Lakeside'));
  assert.ok(!csv.includes('Greenview'));
});

for (const s of servers) s.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} e2e checks passed${process.exitCode ? ' (with failures)' : ''}`);
