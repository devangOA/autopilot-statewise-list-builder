// Builds the Reoon verification input from the master facility CSV.
//
//   node src/reoon.js [--in FILE] [--out FILE] [--review FILE]
//
// The master CSV is read-only here: this step never rewrites it. Output is one
// row per *candidate email*, so a single facility fans out to as many rows as
// it has addresses to verify. Facility and contact fields repeat on every row
// so the Reoon result can be joined back on `Candidate Email` alone.
import fs from 'node:fs';
import { guessEmails } from './emails.js';
import { toCsv } from './csv.js';
import { QUALIFICATION } from './schema.js';
import { registrableDomain } from './search.js';

// Only these two go to verification; unclear indoor status is parked.
const QUALIFIED = new Set([QUALIFICATION.CONFIRMED_INDOOR, QUALIFICATION.INDOOR_AND_OUTDOOR]);

export const REOON_COLUMNS = [
  'Facility ID',
  'Facility Name',
  'Website',
  'City',
  'State',
  'Facility Type',
  'Sports Offered',
  'Indoor Court Status',
  'Number of Courts',
  'Decision Maker First Name',
  'Decision Maker Last Name',
  'Decision Maker Full Name',
  'Decision Maker Title',
  'Company Domain',
  'Candidate Email',
  'Email Candidate Type',
  'Pattern Rank',
  'Email Source URL',
  'Facility Source URLs',
  'Qualification Notes',
];

export const REVIEW_COLUMNS = [
  'Facility ID',
  'Facility Name',
  'Website',
  'City',
  'State',
  'Facility Type',
  'Sports Offered',
  'Indoor Court Status',
  'Qualification Status',
  'Indoor Evidence',
  'Number of Courts',
  'Court Count Notes',
  'Decision Maker First Name',
  'Decision Maker Last Name',
  'Decision Maker Full Name',
  'Decision Maker Title',
  'Company Domain',
  'Published Direct Email',
  'Shared Facility Email',
  'Guessed Email 1',
  'Guessed Email 2',
  'Guessed Email 3',
  'Guessed Email 4',
  'Guessed Email 5',
  'Guessed Email 6',
  'Emails Found',
  'Research Notes',
  'Source URLs',
];

// One row per physical branch. Multi-site operators publish one address per
// location behind a single domain; without this file they would collapse to a
// single contactable facility and the other branches would be lost.
export const LOCATION_COLUMNS = [
  'Facility ID',
  'Location ID',
  'Facility Name',
  'Branch Street',
  'Branch City',
  'Branch ZIP',
  'State',
  'Website',
  'Company Domain',
  'Indoor Court Status',
  'Qualification Status',
  'Is Multi Location',
  'Location Count',
  'Source URLs',
];

// --------------------------------------------------------------------------
// CSV reading (the writer lives in csv.js; this is its inverse)
// --------------------------------------------------------------------------
export function parseCsv(text) {
  const out = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field || row.length) {
    row.push(field);
    out.push(row);
  }
  return out;
}

export function readRows(file) {
  const [header, ...rest] = parseCsv(fs.readFileSync(file, 'utf8'));
  return rest
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

// --------------------------------------------------------------------------
// Contact shaping
// --------------------------------------------------------------------------

// Names arrive as scraped: "SHYE EVAN" from an all-caps heading, "dana" from a
// lowercase byline. Normalize for display without touching the parts used to
// build email locals (guessEmails lowercases and strips them itself).
function titleCase(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  if (t !== t.toUpperCase() && t !== t.toLowerCase()) return t;
  return t.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (m, sep, c) => sep + c.toUpperCase());
}

/**
 * Whether a decision maker's identity is solid enough to build patterns from.
 *
 * The brief forbids inventing patterns when the name or domain is uncertain, so
 * this is deliberately strict: both parts present, alphabetic, and at least two
 * characters, which rejects the trailing-initial captures ("Marina O.") that a
 * page's layout can produce.
 */
// An honorific is not a given name. "Dr. Riley" is a surname with a title
// attached, so it cannot anchor `first@domain` -- that would generate
// `dr@theirdomain.com` and present it as a decision maker's address.
const HONORIFIC = /^(dr|mr|mrs|ms|miss|mx|prof|professor|coach|rev|reverend|fr|father|sr|sister|sen|rep|hon|sir|dame|capt|sgt|lt|col|gen)\.?$/i;

// Squad and department names sit in the same "Name, Title" shape as people on
// athletics pages, so "Women's Basketball, Head Coach" parses as a person and
// would yield `womens.basketball@` presented as a decision maker. Checked here
// as well as at extraction time so cached crawls are cleaned without re-running.
const NOT_A_PERSON =
  /^(mens?|womens?|boys?|girls?|varsity|junior|senior|freshman|basketball|volleyball|football|soccer|hockey|baseball|softball|lacrosse|tennis|swimming|diving|golf|wrestling|rowing|crew|track|field|athletics|staff|team|department|office|general|main|front|head|assistant|associate|community|engagement|placement|testing|admissions|advancement|development|marketing|communications|alumni|registrar|financial|career|counseling|wellness|facilities|maintenance|security|catering|events|information|services|resources|relations)$/i;

export function nameIsConfirmed(first, last) {
  const ok = (s) => /^[A-Za-z][A-Za-z'’.-]*$/.test(String(s || '').trim()) && String(s).replace(/[^A-Za-z]/g, '').length >= 2;
  if (!ok(first) || !ok(last)) return false;
  const clean = (s) => String(s).trim().replace(/['’]s$/i, '');
  if (HONORIFIC.test(clean(first)) || HONORIFIC.test(clean(last))) return false;
  return !NOT_A_PERSON.test(clean(first)) && !NOT_A_PERSON.test(clean(last));
}

/**
 * Load the contact/location pass keyed by registrable domain.
 *
 * The master CSV carries one decision maker and one address per facility
 * because that is its shape. The second pass keeps every named person and
 * every branch address it found, so the verification file is built by joining
 * the two: the master decides *whether* a facility qualifies, the contact pass
 * decides *who* to contact there.
 */
export function loadContactIndex(file) {
  if (!fs.existsSync(file)) return new Map();
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  const idx = new Map();
  for (const r of rows) {
    const key = registrableDomain(r.Website || '');
    if (!key) continue;
    const prev = idx.get(key);
    // Richer record wins if a domain was crawled twice.
    const weight = (x) => (x._people?.length || 0) + (x._locations?.length || 0) + (x._directEmails?.length || 0);
    if (!prev || weight(r) > weight(prev)) idx.set(key, r);
  }
  return idx;
}

/**
 * Every contactable person at a facility, each paired with their own published
 * address where one exists.
 *
 * More than one person per facility is wanted, so the whole ranked list is
 * kept, not just the strongest title. The master's single decision maker is the
 * fallback when the contact pass has nothing for this domain.
 */
export function peopleFor(master, extra) {
  const list = (extra?._people || [])
    .filter((p) => nameIsConfirmed(p.first, p.last))
    .map((p) => ({ first: p.first, last: p.last, title: p.title || '', email: (p.email || '').toLowerCase() }));
  if (list.length) return list;
  const f = String(master['Decision Maker First Name'] || '').trim();
  const l = String(master['Decision Maker Last Name'] || '').trim();
  if (!nameIsConfirmed(f, l)) return [];
  return [{ first: f, last: l, title: master['Decision Maker Title'] || '', email: String(master['Public Direct Email'] || '').toLowerCase() }];
}

/**
 * Candidate emails for one facility, in verification priority order.
 *
 * Published addresses come first and are never suppressed by the presence of
 * guesses -- a shared inbox stays a useful fallback even when a named contact
 * exists. Guesses are emitted only for a person with no published address of
 * their own, and are always six, in the fixed pattern order.
 */
// Caps on addresses that belong to no named person. A university athletics
// site publishes its whole staff roster and a franchise site lists every
// branch inbox; without a cap one facility contributes hundreds of rows, and
// verification is billed per address. Person-attributed addresses are never
// capped -- those are the contacts actually worth having.
// Raised from 3/3: verification weeds out the bad addresses anyway, so the
// binding constraint is having enough candidates to weed. Still capped, and
// still ranked person-like and role-like first, so a university staff roster
// cannot flood the file the way an uncapped list once did (221 addresses from
// one athletics site).
const MAX_UNATTRIBUTED_DIRECT = 6;
const MAX_SHARED = 4;

// Role words that make an unattributed address worth verifying.
const ROLE_LOCALPART =
  /^(owner|gm|manager|director|president|ceo|head|pro|tennis|pickleball|racquet|squash|membership|memberships|operations|frontdesk|desk|reserve|reservations|book|bookings|play|courts?|programs?|coach|admin)\b/i;

/**
 * Rank addresses that no named person claimed.
 *
 * A local part shaped like a person ("j.smith", "sarah.lee") or naming a role
 * is far likelier to reach a decision maker than a branch or list inbox, so
 * those survive the cap.
 */
function rankUnattributed(email) {
  const lp = email.split('@')[0].toLowerCase();
  if (ROLE_LOCALPART.test(lp)) return 0;
  if (/^[a-z]+[._-][a-z]+$/.test(lp)) return 1; // first.last
  if (/^[a-z]\.?[a-z]{3,}$/.test(lp)) return 2; // jsmith
  return 3;
}

export function candidatesFor(master, extra) {
  const out = [];
  const domain = String(master['Email Domain'] || '').trim().toLowerCase();
  const people = peopleFor(master, extra);

  const sharedAll = (extra?._sharedEmails?.length ? extra._sharedEmails : [master['Shared Facility Email']])
    .filter(Boolean).map((e) => e.toLowerCase());
  const directAll = (extra?._directEmails?.length ? extra._directEmails : [master['Public Direct Email']])
    .filter(Boolean).map((e) => e.toLowerCase());
  const claimed = new Set(people.map((p) => p.email).filter(Boolean));

  for (const p of people) {
    if (p.email) {
      out.push({ email: p.email, type: 'Published Direct', rank: '', published: true, person: p });
    } else if (domain) {
      // A person with no published address is exactly the case the six
      // permutations exist for.
      guessEmails(p.first, p.last, domain).forEach((e, i) => {
        if (e) out.push({ email: e.toLowerCase(), type: `Guessed Pattern ${i + 1}`, rank: i + 1, published: false, person: p });
      });
    }
  }

  // Published direct addresses that no named person claimed: still real, still
  // worth verifying, but capped and ranked so a staff roster cannot flood the
  // file with hundreds of addresses that reach nobody who decides anything.
  const unattributed = directAll
    .filter((e) => !claimed.has(e))
    .sort((a, b) => rankUnattributed(a) - rankUnattributed(b) || a.localeCompare(b))
    .slice(0, MAX_UNATTRIBUTED_DIRECT);
  for (const e of unattributed) {
    out.push({ email: e, type: 'Published Direct', rank: '', published: true, person: null });
  }
  // Shared inboxes are kept even when named contacts exist.
  for (const e of sharedAll.slice(0, MAX_SHARED)) {
    out.push({ email: e, type: 'Published Shared', rank: '', published: true, person: null });
  }
  return out;
}

// --------------------------------------------------------------------------
// Build
// --------------------------------------------------------------------------
export function build(master, contacts = new Map(), statePrefix = '') {
  // ID prefix follows the data, so a Texas run yields TX-0001 rather than NY-.
  const prefix = statePrefix || master[0]?.State || 'US';
  const facilities = master.map((r, i) => ({ ...r, _id: `${prefix}-${String(i + 1).padStart(4, '0')}` }));
  const qualified = facilities.filter((r) => QUALIFIED.has(r['Qualification Status']));
  const review = facilities.filter((r) => r['Qualification Status'] === QUALIFICATION.NEEDS_REVIEW);
  const extraFor = (f) => contacts.get(registrableDomain(f.Website || '')) || null;

  const seen = new Map(); // candidate email -> facility id that claimed it
  const rows = [];
  const locationRows = [];
  const stats = {
    qualified: qualified.length,
    review: review.length,
    direct: 0,
    shared: 0,
    guessed: 0,
    noEmail: 0,
    people: 0,
    multiPerson: 0,
    multiSite: 0,
    branches: 0,
    dupes: [],
  };

  for (const f of qualified) {
    const extra = extraFor(f);
    const people = peopleFor(f, extra);
    stats.people += people.length;
    if (people.length > 1) stats.multiPerson++;

    // Branch rows: one per physical New York address, so a multi-site operator
    // survives as several contactable locations rather than one.
    const locs = extra?._locations?.length ? extra._locations : [];
    if (locs.length > 1) stats.multiSite++;
    const branchList = locs.length ? locs : [{ street: '', city: f.City, zip: '' }];
    branchList.forEach((loc, i) => {
      stats.branches++;
      locationRows.push({
        'Facility ID': f._id,
        'Location ID': `${f._id}-${String.fromCharCode(65 + i)}`,
        'Facility Name': f['Facility Name'],
        'Branch Street': loc.street,
        'Branch City': loc.city,
        'Branch ZIP': loc.zip,
        State: f.State,
        Website: f.Website,
        'Company Domain': f['Email Domain'],
        'Indoor Court Status': f['Indoor Court Status'],
        'Qualification Status': f['Qualification Status'],
        'Is Multi Location': locs.length > 1 ? 'Yes' : 'No',
        'Location Count': locs.length || 1,
        'Source URLs': f['Source URLs'],
      });
    });

    const cands = candidatesFor(f, extra);
    if (!cands.length) {
      stats.noEmail++;
      continue;
    }

    for (const c of cands) {
      // One row per address across the whole file: Reoon bills per email and
      // returns one verdict per address, so a repeat is paid for twice and
      // tells us nothing new.
      if (seen.has(c.email)) {
        stats.dupes.push(`${c.email} (${seen.get(c.email)} / ${f._id})`);
        continue;
      }
      seen.set(c.email, f._id);

      if (c.type === 'Published Direct') stats.direct++;
      else if (c.type === 'Published Shared') stats.shared++;
      else stats.guessed++;

      const p = c.person;
      const first = titleCase(p?.first || '');
      const last = titleCase(p?.last || '');
      rows.push({
        'Facility ID': f._id,
        'Facility Name': f['Facility Name'],
        Website: f.Website,
        City: f.City,
        State: f.State,
        'Facility Type': f['Facility Type'],
        'Sports Offered': f['Sports Offered'],
        'Indoor Court Status': f['Indoor Court Status'],
        'Number of Courts': f['Number of Courts'],
        'Decision Maker First Name': first,
        'Decision Maker Last Name': last,
        'Decision Maker Full Name': [first, last].filter(Boolean).join(' '),
        'Decision Maker Title': p?.title || '',
        'Company Domain': f['Email Domain'],
        'Candidate Email': c.email,
        'Email Candidate Type': c.type,
        'Pattern Rank': c.rank,
        // Published addresses were read off the facility's own site; the exact
        // page is not pinned per address, so the full crawled set travels
        // alongside in Facility Source URLs. Guesses have no source.
        'Email Source URL': c.published ? f.Website : '',
        'Facility Source URLs': f['Source URLs'],
        'Qualification Notes': [
          f['Qualification Status'],
          locs.length > 1 ? `Multi-location operator (${locs.length} NY branches; see locations CSV)` : '',
          c.published
            ? 'Published on the facility website - UNVERIFIED until Reoon confirms deliverability.'
            : 'GUESSED PATTERN - not a published address; unverified permutation of the confirmed name against the company domain.',
        ].filter(Boolean).join('. ') + '.',
      });
    }
  }

  const reviewRows = review.map((f) => {
    const extra = extraFor(f);
    const people = peopleFor(f, extra);
    const p = people[0];
    const found = [
      ...(extra?._directEmails || [f['Public Direct Email']]),
      ...(extra?._sharedEmails || [f['Shared Facility Email']]),
    ].filter(Boolean);
    return {
      'Facility ID': f._id,
      'Facility Name': f['Facility Name'],
      Website: f.Website,
      City: f.City,
      State: f.State,
      'Facility Type': f['Facility Type'],
      'Sports Offered': f['Sports Offered'],
      'Indoor Court Status': f['Indoor Court Status'],
      'Qualification Status': f['Qualification Status'],
      'Indoor Evidence':
        'Court sport confirmed on the facility site; no explicit indoor or outdoor statement found on the crawled pages. Needs a human check of the website or a call before outreach.',
      'Number of Courts': f['Number of Courts'],
      'Court Count Notes': f['Court Count Notes'],
      'Decision Maker First Name': titleCase(p?.first || ''),
      'Decision Maker Last Name': titleCase(p?.last || ''),
      'Decision Maker Full Name': [titleCase(p?.first || ''), titleCase(p?.last || '')].filter(Boolean).join(' '),
      'Decision Maker Title': p?.title || '',
      'Company Domain': f['Email Domain'],
      'Published Direct Email': f['Public Direct Email'],
      'Shared Facility Email': f['Shared Facility Email'],
      'Guessed Email 1': f['Guessed Email 1'],
      'Guessed Email 2': f['Guessed Email 2'],
      'Guessed Email 3': f['Guessed Email 3'],
      'Guessed Email 4': f['Guessed Email 4'],
      'Guessed Email 5': f['Guessed Email 5'],
      'Guessed Email 6': f['Guessed Email 6'],
      'Emails Found': [...new Set(found)].length,
      'Research Notes': f['Research Notes'],
      'Source URLs': f['Source URLs'],
    };
  });

  return { rows, reviewRows, locationRows, stats };
}

// --------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
  };
  const IN = arg('in', 'NEW_YORK_INDOOR_COURT_FACILITIES.csv');
  const OUT = arg('out', 'NY_INDOOR_COURTS_REOON_VERIFICATION_INPUT.csv');
  const REVIEW = arg('review', 'NY_INDOOR_COURTS_NEEDS_REVIEW.csv');

  const CONTACTS = arg('contacts', '');
  const LOCS = arg('locations', 'NY_INDOOR_COURTS_LOCATIONS.csv');

  const master = readRows(IN);
  const contacts = CONTACTS ? loadContactIndex(CONTACTS) : new Map();
  const { rows, reviewRows, locationRows, stats } = build(master, contacts, arg('state', ''));

  fs.writeFileSync(OUT, toCsv(rows, REOON_COLUMNS));
  fs.writeFileSync(REVIEW, toCsv(reviewRows, REVIEW_COLUMNS));
  fs.writeFileSync(LOCS, toCsv(locationRows, LOCATION_COLUMNS));

  const facilitiesWithRows = new Set(rows.map((r) => r['Facility ID'])).size;
  console.log(`read ${master.length} facilities from ${IN}`);
  console.log(`\n${OUT}`);
  console.log(`  qualified facilities        : ${stats.qualified}`);
  console.log(`  facilities with candidates  : ${facilitiesWithRows}`);
  console.log(`  candidate email rows        : ${rows.length}`);
  console.log(`    Published Direct          : ${stats.direct}`);
  console.log(`    Published Shared          : ${stats.shared}`);
  console.log(`    Guessed Pattern 1-6       : ${stats.guessed}`);
  console.log(`  no usable email, no guesses : ${stats.noEmail}`);
  console.log(`  named people carried        : ${stats.people}`);
  console.log(`  facilities with >1 contact  : ${stats.multiPerson}`);
  console.log(`  duplicate emails dropped    : ${stats.dupes.length}`);
  console.log(`\n${LOCS}`);
  console.log(`  branch location rows        : ${locationRows.length}`);
  console.log(`  multi-location operators    : ${stats.multiSite}`);
  console.log(`\n${REVIEW}`);
  console.log(`  needs-review facilities     : ${reviewRows.length}`);
}
