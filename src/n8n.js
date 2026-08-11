// Builds the single n8n-ready candidate-email CSV, plus the locations and
// needs-review companions.
//
//   node src/n8n.js --in CALIFORNIA_INDOOR_COURT_FACILITIES.csv \
//                   --contacts .cache-ca/rows.json --state CA
//
// There is no separate Reoon-format file: this one CSV is both the
// verification input and the n8n input. Its columns, order and row behaviour
// come from N8N_INDOOR_COURTS_5_ROW_REFERENCE.csv, which is the source of
// truth for the format.
import fs from 'node:fs';
import { toCsv } from './csv.js';
import { QUALIFICATION } from './schema.js';
import { registrableDomain } from './search.js';
import {
  readRows, nameIsConfirmed, peopleFor, candidatesFor, loadContactIndex, LOCATION_COLUMNS, REVIEW_COLUMNS,
} from './reoon.js';
import { looksLikePublisher, looksLikeNonFacilityOrg } from './finalize.js';

// Exactly the reference columns, in the reference order. Nothing added.
export const N8N_COLUMNS = [
  'Track ID',
  'Batch',
  'Company Name',
  'Website',
  'Address',
  'Phone',
  'Primary Type',
  'Google Maps URL',
  'Claygent Fit',
  'Contact Name',
  'Contact Title',
  'Contact LinkedIn',
  'Contact Email',
  'Work Email',
  'Final Email',
  'Email Source',
  'Fit Notes',
];

const QUALIFIED = new Set([QUALIFICATION.CONFIRMED_INDOOR, QUALIFICATION.INDOOR_AND_OUTDOOR]);

// Page furniture that is not a business name.
const GENERIC_NAME = /^(public\s+)?(home|homepage|home page|welcome|index|main|start|untitled|site|page|default)\b/i;

/**
 * Best available company name, without inventing one.
 *
 * A site whose <title> is just "Home" would otherwise be addressed as a
 * facility called Home in outreach. Preference order: the master's name, then
 * the name the enrichment crawl extracted, then the domain rendered readably.
 * Marketing lead-ins ("Welcome to", "Experience") and trailing taglines are
 * trimmed, since those are decoration rather than the business name.
 */
export function resolveCompanyName(masterName, extra, website) {
  const clean = (v) =>
    String(v || '')
      .replace(/^(welcome to|experience|the official (site|website) of)\s+/i, '')
      .replace(/^www\./i, '')
      .split(/\s+[|–—]\s+|\s+-\s+/)[0]
      .replace(/\s+\d{4}$/, '')       // trailing year, e.g. "... Club 2022"
      .trim();
  for (const cand of [masterName, extra?.['Facility Name']]) {
    const c = clean(cand);
    if (c && c.length >= 3 && !GENERIC_NAME.test(c) && !/^[a-z0-9-]+\.[a-z]{2,}$/i.test(c)) return c;
  }
  // Last resort: the domain label, readable. Factual, never invented.
  const label = registrableDomain(website || '').replace(/\.[a-z.]+$/, '').replace(/[^a-z0-9]+/gi, ' ').trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : String(masterName || '');
}

function titleCase(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  if (t !== t.toUpperCase() && t !== t.toLowerCase()) return t;
  return t.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (m, sep, c) => sep + c.toUpperCase());
}

// A maps *search* link, not a claimed place ID: it is built from the facility
// name and city we actually hold, so it cannot assert a location we did not
// find.
function mapsUrl(name, city, state) {
  const q = [name, city, state].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q).replace(/%20/g, '+')}`;
}

/**
 * Fit Notes: everything n8n needs to write a personalized opener, and nothing
 * that is not sourced.
 *
 * Guessed addresses are labelled as guesses here as well as in Email Source, so
 * a downstream prompt cannot mistake a permutation for a published address, and
 * nothing is described as verified before Reoon has actually seen it.
 */
export function fitNotes({ facility, person, kind, state, branches, upgraded }) {
  const parts = [];
  const where = [facility.City, state].filter(Boolean).join(', ');
  parts.push(
    `${facility['Facility Name']} is a ${facility['Facility Type'] || 'sports facility'}` +
      (where ? ` in ${where}` : '') + '.',
  );
  if (facility['Indoor Court Status']) parts.push(`Indoor-court status: ${facility['Indoor Court Status']}.`);
  if (facility['Sports Offered']) parts.push(`Sports offered: ${facility['Sports Offered']}.`);
  // Only ever the count a page stated outright; never inferred.
  if (facility['Number of Courts']) parts.push(`Published court count: ${facility['Number of Courts']}.`);
  if (branches && branches.length > 1) {
    parts.push(
      `Operates ${branches.length} ${state} locations: ` +
        `${branches.map((b) => b.city).filter(Boolean).join('; ')}.`,
    );
  }

  if (kind === 'generic') {
    parts.push(
      'This is a generic facility inbox. Start the email with "Hey team," and use facility-level personalization.',
    );
  } else if (person) {
    parts.push(
      `${person.full} is listed as ${person.title || 'a facility decision maker'} on the facility website.`,
    );
  }

  parts.push(`Research note: ${facility['Qualification Status']}.`);
  if (upgraded) {
    parts.push(
      'Indoor status was resolved on a second, deeper crawl of this site; the first pass left it unconfirmed.',
    );
  }
  parts.push(
    kind === 'guessed'
      ? 'Email status: GUESSED PATTERN - not a published address. It is an unverified permutation of the confirmed name against the company domain and must be verified before sending.'
      : 'Email status: published on the facility website. Unverified for deliverability until Reoon confirms it.',
  );
  if (facility['Source URLs']) parts.push(`Sources: ${facility['Source URLs']}`);
  return parts.join(' ');
}

/**
 * Promote facilities a re-verification pass resolved.
 *
 * The first crawl leaves a facility as Needs Review when its site never states
 * indoor or outdoor. A deeper pass over more pages sometimes finds the
 * statement, and this applies that result **in memory only** -- the
 * developer-supplied master CSV on disk is never rewritten. The upgrade is
 * recorded in Research Notes so it is auditable rather than silent.
 */
export function applyUpgrades(master, upgradeRows) {
  if (!upgradeRows?.length) return { master, upgraded: 0 };
  const byUrl = new Map();
  for (const u of upgradeRows) {
    if (!QUALIFIED.has(u['Qualification Status'])) continue;
    const k = registrableDomain(u.Website || '');
    if (k) byUrl.set(k, u);
  }
  let upgraded = 0;
  const out = master.map((r) => {
    if (r['Qualification Status'] !== QUALIFICATION.NEEDS_REVIEW) return r;
    const u = byUrl.get(registrableDomain(r.Website || ''));
    if (!u) return r;
    upgraded++;
    return {
      ...r,
      'Qualification Status': u['Qualification Status'],
      'Indoor Court Status': u['Indoor Court Status'] || r['Indoor Court Status'],
      'Sports Offered': u['Sports Offered'] || r['Sports Offered'],
      'Number of Courts': r['Number of Courts'] || u['Number of Courts'],
      'Court Count Notes': r['Court Count Notes'] || u['Court Count Notes'],
      'Source URLs': u['Source URLs'] || r['Source URLs'],
      'Research Notes': `${r['Research Notes'] || ''} Upgraded from Needs Review on re-verification: indoor evidence found on a deeper crawl of this site.`.trim(),
    };
  });
  return { master: out, upgraded };
}

/**
 * Reject a facility whose only tie to the state is the word appearing on the
 * page.
 *
 * The location gate accepts four tiers of evidence: address, ZIP, phone, and a
 * bare mention. The first three are positive identification. A mention is not:
 * a Michigan country club that lists a Texas tournament, a national directory,
 * or a league covering every state all "mention" Texas. Those rows are
 * recognisable because no address was found, so no city was parsed either.
 *
 * Requiring a mention to be corroborated by a parsed city keeps genuine
 * facilities that simply phrase their address unusually, while dropping the
 * out-of-state and national organizations.
 */
export function weakLocationEvidence(r, state) {
  const m = new RegExp(`${state} location evidence: (\\w+)`).exec(r['Research Notes'] || '');
  return m?.[1] === 'mention' && !String(r.City || '').trim();
}

export function build(master, contacts, { state = 'CA', trackId = 'CA-COURTS-001', batch = 'CA-COURTS-20260805-B001' } = {}) {
  // Publishers, chambers of commerce, tourism boards, realtors and generated
  // directory networks are filtered here rather than in the master, so a
  // developer-supplied master CSV can stay byte-identical while the outreach
  // file still excludes organizations that operate no courts.
  const excluded = [];
  const qualified = master.filter((r) => {
    if (!QUALIFIED.has(r['Qualification Status'])) return false;
    if (looksLikePublisher(r)) { excluded.push({ ...r, why: 'publisher/media' }); return false; }
    if (looksLikeNonFacilityOrg(r)) { excluded.push({ ...r, why: 'chamber/tourism/realty/directory' }); return false; }
    if (weakLocationEvidence(r, state)) { excluded.push({ ...r, why: 'state named on page but no address or city' }); return false; }
    return true;
  });
  const review = master.filter((r) => r['Qualification Status'] === QUALIFICATION.NEEDS_REVIEW);
  const extraFor = (f) => contacts.get(registrableDomain(f.Website || '')) || null;

  const rows = [];
  const locationRows = [];
  const seenEmail = new Set();
  const stats = {
    qualified: qualified.length,
    review: review.length,
    confirmedIndoor: qualified.filter((r) => r['Qualification Status'] === QUALIFICATION.CONFIRMED_INDOOR).length,
    indoorOutdoor: qualified.filter((r) => r['Qualification Status'] === QUALIFICATION.INDOOR_AND_OUTDOOR).length,
    people: 0, multiContact: 0, direct: 0, shared: 0, guessed: 0,
    branches: 0, multiSite: 0, withCourtCount: 0, noEmail: 0, dupes: 0,
  };

  qualified.forEach((f, i) => {
    const extra = extraFor(f);
    const people = peopleFor(f, extra);
    stats.people += people.length;
    if (people.length > 1) stats.multiContact++;
    if (f['Number of Courts']) stats.withCourtCount++;

    const locs = extra?._locations?.length ? extra._locations : [];
    if (locs.length > 1) stats.multiSite++;
    const facilityId = `${state}-${String(i + 1).padStart(4, '0')}`;
    const branchList = locs.length ? locs : [{ street: '', city: f.City, zip: '' }];
    branchList.forEach((loc, bi) => {
      stats.branches++;
      locationRows.push({
        'Facility ID': facilityId,
        'Location ID': `${facilityId}-${String.fromCharCode(65 + bi)}`,
        'Facility Name': f['Facility Name'],
        'Branch Street': loc.street,
        'Branch City': loc.city,
        'Branch ZIP': loc.zip,
        State: state,
        Website: f.Website,
        'Company Domain': f['Email Domain'],
        'Indoor Court Status': f['Indoor Court Status'],
        'Qualification Status': f['Qualification Status'],
        'Is Multi Location': locs.length > 1 ? 'Yes' : 'No',
        'Location Count': locs.length || 1,
        'Source URLs': f['Source URLs'],
      });
    });

    // Address carries a branch address only when the facility has exactly one;
    // with several, the locations CSV is authoritative and this stays blank
    // rather than implying the wrong branch.
    const primary = branchList[0];
    const address = branchList.length === 1 && primary.street
      ? [primary.street, primary.city, `${state} ${primary.zip}`.trim()].filter(Boolean).join(', ')
      : '';

    for (const c of candidatesFor(f, extra)) {
      const email = c.email.toLowerCase();
      // Reoon bills per address and returns one verdict per address; a repeat
      // would be paid for twice and add nothing.
      if (seenEmail.has(email)) {
        stats.dupes++;
        continue;
      }
      seenEmail.add(email);

      const isGuess = c.type.startsWith('Guessed');
      const person = c.person && nameIsConfirmed(c.person.first, c.person.last)
        ? {
            full: [titleCase(c.person.first), titleCase(c.person.last)].join(' '),
            title: c.person.title || '',
          }
        : null;
      // A published address nobody claimed is a facility inbox, not a person:
      // it becomes a "Team" row rather than inventing an owner for it.
      const kind = isGuess ? 'guessed' : person ? 'direct' : 'generic';

      if (isGuess) stats.guessed++;
      else if (kind === 'generic') stats.shared++;
      else stats.direct++;

      rows.push({
        'Track ID': trackId,
        Batch: batch,
        'Company Name': resolveCompanyName(f['Facility Name'], extra, f.Website),
        Website: f.Website,
        Address: address,
        Phone: '', // not collected by this pipeline; left blank rather than guessed
        'Primary Type': f['Facility Type'],
        'Google Maps URL': mapsUrl(f['Facility Name'], f.City, state),
        'Claygent Fit': 'Strong Fit',
        'Contact Name': kind === 'generic' ? 'Team' : person.full,
        'Contact Title': kind === 'generic' ? 'Facility Team' : person.title,
        'Contact LinkedIn': '', // never invented
        'Contact Email': kind === 'generic' ? '' : email,
        'Work Email': kind === 'generic' ? email : '',
        'Final Email': email,
        'Email Source': c.type,
        'Fit Notes': fitNotes({ facility: { ...f, 'Facility Name': resolveCompanyName(f['Facility Name'], extra, f.Website) }, person, kind, state, branches: locs, upgraded: /Upgraded from Needs Review/.test(f['Research Notes'] || '') }),
      });
    }

    if (!candidatesFor(f, extra).length) stats.noEmail++;
  });

  const reviewRows = review.map((f, i) => {
    const extra = extraFor(f);
    const p = peopleFor(f, extra)[0];
    return {
      'Facility ID': `${state}-REVIEW-${String(i + 1).padStart(4, '0')}`,
      'Facility Name': f['Facility Name'],
      Website: f.Website,
      City: f.City,
      State: state,
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
      'Emails Found': [...new Set([
        ...(extra?._directEmails || [f['Public Direct Email']]),
        ...(extra?._sharedEmails || [f['Shared Facility Email']]),
      ].filter(Boolean))].length,
      'Research Notes': f['Research Notes'],
      'Source URLs': f['Source URLs'],
    };
  });

  stats.excluded = excluded;
  return { rows, locationRows, reviewRows, stats, excluded };
}

// --------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
  };
  const state = arg('state', 'CA');
  let master = readRows(arg('in', 'CALIFORNIA_INDOOR_COURT_FACILITIES.csv'));
  const contacts = loadContactIndex(arg('contacts', '.cache-ca/rows.json'));
  const upgradeFile = arg('upgrades', '');
  let upgraded = 0;
  if (upgradeFile && fs.existsSync(upgradeFile)) {
    ({ master, upgraded } = applyUpgrades(master, JSON.parse(fs.readFileSync(upgradeFile, 'utf8'))));
  }
  const { rows, locationRows, reviewRows, stats } = build(master, contacts, {
    state,
    trackId: arg('track-id', `${state}-COURTS-001`),
    batch: arg('batch', `${state}-COURTS-20260805-B001`),
  });

  const out = arg('out', `${state}_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv`);
  fs.writeFileSync(out, toCsv(rows, N8N_COLUMNS));
  fs.writeFileSync(arg('locations', `${state}_INDOOR_COURTS_LOCATIONS.csv`), toCsv(locationRows, LOCATION_COLUMNS));
  fs.writeFileSync(arg('review', `${state}_INDOOR_COURTS_NEEDS_REVIEW.csv`), toCsv(reviewRows, REVIEW_COLUMNS));

  console.log(`qualified facilities   : ${stats.qualified} (Confirmed Indoor ${stats.confirmedIndoor}, Indoor+Outdoor ${stats.indoorOutdoor})`);
  console.log(`needs review           : ${stats.review}`);
  if (upgraded) console.log(`upgraded from review   : ${upgraded} (re-verification found indoor evidence)`);
  console.log(`branch locations       : ${locationRows.length} (multi-site operators ${stats.multiSite})`);
  console.log(`named people           : ${stats.people} (facilities with >1 contact ${stats.multiContact})`);
  console.log(`n8n rows               : ${rows.length}`);
  console.log(`  Published Direct     : ${stats.direct}`);
  console.log(`  Published Shared     : ${stats.shared}`);
  console.log(`  Guessed Pattern 1-6  : ${stats.guessed}`);
  console.log(`facilities w/ courts   : ${stats.withCourtCount}`);
  console.log(`no usable email        : ${stats.noEmail}`);
  console.log(`duplicate emails dropped: ${stats.dupes}`);
  if (stats.excluded?.length) {
    const by = stats.excluded.reduce((m, r) => ((m[r.why] = (m[r.why] || 0) + 1), m), {});
    console.log(`excluded non-facilities : ${stats.excluded.length} ${JSON.stringify(by)}`);
  }
}
