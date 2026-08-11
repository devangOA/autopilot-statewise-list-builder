// Verifies that every planned discovery query for a state actually completed
// -- not just that the totals line up, which can hide a handful of markets
// starved by rate-limiting inside an otherwise-plausible-looking number.
//
//   node src/check-coverage.mjs --state IL --cache .cache-il
//
// Exits 0 and prints "COVERAGE: 100%" when every planned query is done.
// Exits 1 and lists the specific markets with any gap, plus any market with
// literally zero completed queries, when it is not.
import fs from 'node:fs';
import { TEMPLATES, CORE_TEMPLATES } from './queries.js';
import { stateConfig } from './states.js';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const code = arg('state', '');
if (!code) {
  console.error('usage: node src/check-coverage.mjs --state XX --cache .cache-xx');
  process.exit(2);
}
const cacheDir = arg('cache', `.cache-${code.toLowerCase()}`);
const st = stateConfig(code);

// Build the exact same per-market query set buildQueries() would, but keep
// each query tagged with the market that produced it. A plain q.endsWith(m)
// substring check misattributes queries between markets that are suffixes of
// each other (e.g. "Peoria IL" is a suffix of "East Peoria IL"), which would
// silently double-count or misreport gaps in the per-market breakdown below.
const major = st.majorMarkets ? new Set(st.majorMarkets) : null;
const planned = [];
const marketOf = new Map();
for (const m of st.markets) {
  const set = !major || major.has(m) ? TEMPLATES : CORE_TEMPLATES;
  for (const t of set) {
    const q = t.replace('{m}', m);
    planned.push(q);
    marketOf.set(q, m);
  }
}
planned.push(...st.statewide);

const donePath = `${cacheDir}/queries-done.json`;
const done = fs.existsSync(donePath) ? JSON.parse(fs.readFileSync(donePath, 'utf8')) : {};
const doneSet = new Set(Object.values(done));
const missing = planned.filter((q) => !doneSet.has(q));

const totalByMarket = new Map();
const missingByMarket = new Map();
for (const q of planned) {
  const m = marketOf.get(q);
  if (m) totalByMarket.set(m, (totalByMarket.get(m) || 0) + 1);
}
for (const q of missing) {
  const m = marketOf.get(q);
  if (m) missingByMarket.set(m, (missingByMarket.get(m) || 0) + 1);
}
const byMarket = {};
for (const [m, miss] of missingByMarket) byMarket[m] = `${miss}/${totalByMarket.get(m)} missing`;
const zeroCoverage = st.markets.filter((m) => missingByMarket.get(m) === totalByMarket.get(m));

const pct = ((100 * (planned.length - missing.length)) / planned.length).toFixed(1);
console.log(`${code}: planned ${planned.length}, done ${planned.length - missing.length}, missing ${missing.length} (${pct}%)`);

if (missing.length === 0) {
  console.log(`COVERAGE: 100% -- all ${st.markets.length} markets fully queried.`);
  process.exit(0);
}
console.log(`COVERAGE: INCOMPLETE -- ${Object.keys(byMarket).length}/${st.markets.length} markets have a gap.`);
if (zeroCoverage.length) {
  console.log(`  Fully unscraped (0 completed queries): ${zeroCoverage.join(', ')}`);
}
console.log('  Markets with any gap:', JSON.stringify(byMarket, null, 2));
process.exit(1);
