// Post-processing applied to enriched rows before they become the deliverable.
//
// Kept separate from the crawl so it can be re-run over a cached `rows.json`
// (`node src/finalize.js --cache .cache --out FILE`) without re-fetching every
// site, which matters because a statewide run takes hours.
import { QUALIFICATION } from './schema.js';
import { registrableDomain, apexDomain } from './search.js';
import { guessEmails, GUESS_DISCLAIMER } from './emails.js';

// Facility names differ cosmetically across a site's own pages ("Sportime NY"
// vs "SportimeNY: Tennis, Fitness"). Normalize before comparing.
export function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|inc|llc|ltd|co|corp|company|club|center|centre|of|and)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mail domain for a facility.
 *
 * Prefers the domain of an address the site actually publishes — that is the
 * domain the facility demonstrably receives mail on — and otherwise falls back
 * to the apex of the crawled host. Free-mail domains are never used as a
 * guessing base: `first.last@gmail.com` is not a pattern, it is a fiction.
 */
const FREE_MAIL = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com',
  'msn.com', 'live.com', 'comcast.net', 'verizon.net', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'gmx.com', 'mail.com', 'yandex.com',
]);

export function mailDomain(row) {
  for (const key of ['Public Direct Email', 'Shared Facility Email']) {
    const d = String(row[key] || '').split('@')[1];
    if (d && !FREE_MAIL.has(d)) return d;
  }
  const apex = apexDomain(row['Email Domain'] || row.Website || '');
  return FREE_MAIL.has(apex) ? '' : apex;
}

/**
 * Strip an address that belongs to somebody else.
 *
 * A syndicated article or an embedded press widget puts a third party's
 * address on the page, and it reads as a facility contact
 * (`reporter@usatoday.com` attached to aol.com). Keep only addresses on the
 * facility's own domain or on free mail, which small clubs genuinely use.
 */
function stripForeignEmails(r) {
  const apex = apexDomain(r['Email Domain'] || r.Website || '');
  // Brand words shared with the facility name mean "our other domain"; an
  // unrelated corporate domain means somebody else's contact.
  const tokens = new Set(
    String(r['Facility Name'] || '')
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 5 && !['tennis', 'sports', 'court', 'courts', 'clubs', 'center', 'centre'].includes(w)),
  );
  const ok = (e) => {
    const d = String(e || '').split('@')[1] || '';
    if (!d) return false;
    if (d === apex || d.endsWith(`.${apex}`) || apex.endsWith(`.${d}`) || FREE_MAIL.has(d)) return true;
    const label = d.replace(/\.[a-z.]+$/, '').replace(/[^a-z]/g, '');
    return [...tokens].some((t) => label.includes(t));
  };
  let stripped = false;
  for (const key of ['Public Direct Email', 'Shared Facility Email']) {
    if (r[key] && !ok(r[key])) {
      r[key] = '';
      stripped = true;
    }
  }
  if (stripped) {
    r['Research Notes'] = `${r['Research Notes'] || ''} Third-party email removed (not on facility domain).`.trim();
  }
  return r;
}

/**
 * Publishers, not facilities.
 *
 * Magazines and news aggregators rank well for "indoor courts <city> NY" and
 * pass every content check: they mention the sports, sit in New York, and are
 * not parks.
 *
 * Domain evidence is preferred because it is unambiguous: `PUBLISHER_WORD`
 * matches anywhere in the domain (`westchestermagazine.com` runs the word into
 * the city name, so an anchored pattern would miss it), while `PUBLISHER_DOMAIN`
 * words could plausibly appear inside a facility domain and must sit on a label
 * boundary.
 *
 * Names are also checked, because a local paper's domain often reveals nothing
 * (`lohud.com`, `rbj.net`). That is only safe in tiers: no court facility is
 * called a Journal or a Gazette, but "News"/"Times" convict only when the name
 * carries no facility word — "Jr Tennis Times" stays rather than risk dropping
 * a real club.
 */
const PUBLISHER_WORD = /(magazine|gazette|herald|tribune|chronicle|newspaper|journalism)/i;
const PUBLISHER_DOMAIN = /(^|[.-])(news|media|blog|patch|press|observer)([.-]|$)/i;
const AGGREGATOR_DOMAIN = /^(aol|msn|yahoo|usatoday|nytimes|nypost|huffpost|buzzfeed|patch|wikimedia|wikipedia)\./i;

const MASTHEAD_STRONG =
  /\b(journal|gazette|herald|tribune|chronicle|newsday|magazine|newspaper|broadcasting|newschannel|dispatch|this week)\b/i;
// "post" is deliberately absent: The Post BK is a Brooklyn venue, and named
// newspapers that use it (nypost.com) are covered by AGGREGATOR_DOMAIN.
const MASTHEAD_WEAK = /\b(news|times|record|daily|weekly|media|radio|tv)\b/i;
const FACILITY_WORD =
  /\b(club|court|courts|tennis|pickleball|squash|racquet|racquetball|badminton|volleyball|basketball|sportsplex|fieldhouse|field house|gym|gymnasium|athletic|recreation|ymca|jcc|academy|arena|dome|complex)\b/i;

// A broadcast call sign as the whole domain label: wyrk.com, whec.com, wgna.com.
const CALL_SIGN_DOMAIN = /^[wk][a-z]{3}\.(com|org|net|tv|fm)$/i;
// A station identified by its dial position: "106.5 WYRK", "92.7/96.9 WRRV".
const DIAL_POSITION = /^\d{2,3}\.\d/;

export function looksLikePublisher(r) {
  const domain = apexDomain(r['Email Domain'] || r.Website || '');
  const name = String(r['Facility Name'] || '');
  if (!domain) return false;
  if (AGGREGATOR_DOMAIN.test(domain) || PUBLISHER_WORD.test(domain) || PUBLISHER_DOMAIN.test(domain)) return true;
  if (CALL_SIGN_DOMAIN.test(domain) || DIAL_POSITION.test(name)) return true;
  if (MASTHEAD_STRONG.test(name)) return true;
  // Weak masthead words only convict when nothing about the name says facility.
  return MASTHEAD_WEAK.test(name) && !FACILITY_WORD.test(name);
}

/**
 * Organizations that rank for court queries but operate no courts.
 *
 * Each pattern here was confirmed against the real rows it removes, not
 * guessed: chambers of commerce and tourism boards list local facilities,
 * hotel groups and realtors mention courts as an amenity, and
 * `pickleball<city>.com` is a generated directory network whose own pages read
 * "Add Your Club", "Club Links" and "your guide to all things pickleball".
 *
 * Deliberately narrow. A hotel or resort that genuinely operates courts is not
 * matched by the aggregator-only hotel patterns, and
 * `pickleballclubsonomavalley.org` - a real member club - survives because the
 * network is `.com` and lacks "club" in the domain.
 */
const NON_FACILITY_ORG = [
  /\bchamber of commerce\b/i,
  /\b(convention (and|&) )?visitors bureau\b/i,
  /\btourism\b/i,
  /\bthings to do\b/i,
  /\btravel guide\b/i,
  /\b(real estate|realty|realtor|homes for sale|luxury homes)\b/i,
  /\bhotels? (and|&) resorts\b/i,
  /\bhotels\d/i,
];
const NON_FACILITY_DOMAIN = [
  /^visit[a-z]+\.(com|org|net)$/i,
  /^(business\.)?[a-z]+chamber[a-z]*\.(com|org|net)$/i,
  /tourism\./i,
  // The generated directory network: bare `pickleball<city>.com` with no club
  // token. Confirmed directory content on sampled members.
  /^pickleball[a-z]+\.com$/i,
];

export function looksLikeNonFacilityOrg(r) {
  const name = String(r['Facility Name'] || '');
  const domain = apexDomain(r['Email Domain'] || r.Website || '');
  if (NON_FACILITY_ORG.some((re) => re.test(name))) return true;
  return NON_FACILITY_DOMAIN.some((re) => re.test(domain));
}

export function normalizeRow(row) {
  const r = stripForeignEmails({ ...row });
  const domain = mailDomain(r);
  r['Email Domain'] = domain;

  const first = r['Decision Maker First Name'];
  const last = r['Decision Maker Last Name'];
  const guesses =
    first && last && domain && !r['Public Direct Email']
      ? guessEmails(first, last, domain)
      : ['', '', '', '', '', ''];
  guesses.forEach((g, i) => (r[`Guessed Email ${i + 1}`] = g));

  // Keep the disclaimer honest in both directions: present iff guesses are.
  const notes = String(r['Research Notes'] || '')
    .split(GUESS_DISCLAIMER)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  r['Research Notes'] = guesses[0] ? `${notes} ${GUESS_DISCLAIMER}`.trim() : notes;
  return r;
}

// Richness score: a row with a named decision maker and a direct address beats
// a bare one, so that is the row that survives a merge.
function score(x) {
  return (
    (x['Public Direct Email'] ? 4 : 0) +
    (x['Shared Facility Email'] ? 2 : 0) +
    (x['Decision Maker Last Name'] ? 2 : 0) +
    (x['Number of Courts'] ? 1 : 0) +
    (x.City ? 1 : 0)
  );
}

const ORDER = {
  [QUALIFICATION.CONFIRMED_INDOOR]: 0,
  [QUALIFICATION.INDOOR_AND_OUTDOOR]: 1,
  [QUALIFICATION.NEEDS_REVIEW]: 2,
};

/**
 * Deduplicate facilities, then contacts.
 *
 * Facilities collapse on two keys: the apex domain (so `412squash.org` and
 * `book.412squash.org` are one facility) and, failing that, normalized name +
 * city (so the same club reached through two domains is not listed twice).
 * A contact is then removed where the identical direct address already
 * represents the same facility name elsewhere in the file.
 */
export function finalize(rows) {
  const normalized = rows
    .filter((r) => !looksLikePublisher(r) && !looksLikeNonFacilityOrg(r))
    .map(normalizeRow);

  const byKey = new Map();
  const keep = (key, r) => {
    const prev = byKey.get(key);
    if (!prev || score(r) > score(prev)) byKey.set(key, r);
  };

  for (const r of normalized) {
    const domain = apexDomain(r['Email Domain'] || r.Website || registrableDomain(r.Website));
    keep(`d:${domain || r.Website}`, r);
  }

  // Second pass: same facility reached through two unrelated domains.
  const byName = new Map();
  for (const r of byKey.values()) {
    const nk = nameKey(r['Facility Name']);
    const key = nk ? `n:${nk}|${(r.City || '').toLowerCase()}` : `w:${r.Website}`;
    const prev = byName.get(key);
    if (!prev || score(r) > score(prev)) byName.set(key, r);
  }

  const out = [...byName.values()];

  // Duplicate contacts: the same published address attached to more than one
  // row for the same facility name. Blank the weaker occurrence rather than
  // dropping the facility.
  const seenEmail = new Map();
  for (const r of out.sort((a, b) => score(b) - score(a))) {
    const e = (r['Public Direct Email'] || '').toLowerCase();
    if (!e) continue;
    const nk = nameKey(r['Facility Name']);
    const prior = seenEmail.get(e);
    if (prior && prior === nk) {
      r['Public Direct Email'] = '';
      r['Research Notes'] = `${r['Research Notes']} Duplicate contact removed.`.trim();
    } else if (!prior) {
      seenEmail.set(e, nk);
    }
  }

  return out.sort(
    (a, b) =>
      (ORDER[a['Qualification Status']] ?? 9) - (ORDER[b['Qualification Status']] ?? 9) ||
      String(a['Facility Name']).localeCompare(String(b['Facility Name'])),
  );
}

// ---------------------------------------------------------------------------
// CLI: re-apply finalization to a cached run without re-crawling.
//   node src/finalize.js [--cache .cache] [--out FILE]
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { COLUMNS } = await import('./schema.js');
  const { toCsv } = await import('./csv.js');
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
  };
  const cache = arg('cache', '.cache');
  const out = arg('out', 'NEW_YORK_INDOOR_COURT_FACILITIES.csv');
  const rowsPath = path.join(cache, 'rows.json');
  if (!fs.existsSync(rowsPath)) {
    console.error(`No cached rows at ${rowsPath} - run \`npm run build:ny\` first.`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(rowsPath, 'utf8'));
  const rows = finalize(raw);
  fs.writeFileSync(out, toCsv(rows, COLUMNS));
  const tally = rows.reduce((m, r) => ((m[r['Qualification Status']] = (m[r['Qualification Status']] || 0) + 1), m), {});
  console.log(`finalized ${raw.length} cached rows -> ${rows.length} in ${out}`);
  console.log('by status:', JSON.stringify(tally));
}
