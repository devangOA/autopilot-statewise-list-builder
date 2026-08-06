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

export function buildQueries({ markets = NY_MARKETS, templates = TEMPLATES, statewide = STATEWIDE, limit = 0 } = {}) {
  const out = [];
  for (const m of markets) {
    for (const t of templates) out.push(t.replace('{m}', m));
  }
  out.push(...statewide);
  return limit > 0 ? out.slice(0, limit) : out;
}

export { TEMPLATES, STATEWIDE };
