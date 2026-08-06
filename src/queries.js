import { NY_MARKETS } from './geo.js';

// Query templates. `{m}` is substituted with a market like "Rochester NY".
const TEMPLATES = [
  'indoor pickleball courts {m}',
  'indoor tennis club {m}',
  'indoor basketball courts rental {m}',
  'indoor volleyball club {m}',
  'indoor badminton club {m}',
  'squash club {m}',
  'racquetball courts {m}',
  'indoor padel club {m}',
  'indoor futsal {m}',
  'sportsplex {m}',
  'fieldhouse indoor courts {m}',
  'indoor sports complex {m}',
  'athletic club indoor courts {m}',
  'racquet club {m}',
  'country club indoor tennis {m}',
  'YMCA gymnasium court rental {m}',
  'JCC indoor courts {m}',
  'court rental {m}',
  'basketball court rental hourly {m}',
  'private school gymnasium rental {m}',
  'college recreation center court rental {m}',
  // Second wave. Platform/paddle tennis in particular is a large indoor-adjacent
  // segment in Westchester and Long Island that the first wave never queried.
  'platform tennis club {m}',
  'paddle tennis club {m}',
  'tennis center {m}',
  'pickleball center {m}',
  'sports dome {m}',
  'swim and tennis club {m}',
  'volleyball facility rental {m}',
  'basketball training facility {m}',
  'indoor soccer and basketball facility {m}',
  'recreation center court rental {m}',
];

// A handful of statewide / directory-style queries that surface multi-facility
// pages worth mining for names even when the per-city queries miss them.
const STATEWIDE = [
  'indoor pickleball facilities New York State directory',
  'USTA Eastern indoor tennis facilities New York',
  'indoor sports complex New York State list',
  'New York volleyball clubs indoor facility list',
  'New York squash clubs list',
  'best indoor pickleball courts upstate New York',
  'sportsplex New York State',
];

// The highest-yield angles, measured on the New York run. Every market gets
// these; only major markets get the full template set.
//
// This tiering exists because query volume is the binding constraint, not
// coverage: search engines rate-limit collectively, and California at 267
// markets x 31 templates drove all six engines into simultaneous 429/403 and
// collapsed throughput to ~6 queries/min. Ten angles in a town of 6,000 finds
// what thirty-one would; the difference is only felt in dense markets.
export const CORE_TEMPLATES = [
  'indoor pickleball courts {m}',
  'indoor tennis club {m}',
  'indoor basketball courts rental {m}',
  'indoor volleyball club {m}',
  'indoor badminton club {m}',
  'indoor sports complex {m}',
  'racquet club {m}',
  'sportsplex {m}',
  'athletic club indoor courts {m}',
  'court rental {m}',
];

export function buildQueries({
  markets = NY_MARKETS,
  majorMarkets = null,
  templates = TEMPLATES,
  coreTemplates = CORE_TEMPLATES,
  statewide = STATEWIDE,
  limit = 0,
} = {}) {
  const out = [];
  const major = majorMarkets ? new Set(majorMarkets) : null;
  for (const m of markets) {
    // No major-market list supplied: behave exactly as before.
    const set = !major || major.has(m) ? templates : coreTemplates;
    for (const t of set) out.push(t.replace('{m}', m));
  }
  out.push(...statewide);
  return limit > 0 ? out.slice(0, limit) : out;
}

export { TEMPLATES, STATEWIDE };
