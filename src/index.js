// Orchestrator: discover candidate facility domains from search engines, then
// visit each official site (plus its contact/about/staff pages) to extract
// indoor-court evidence, a decision maker, and emails. Writes one deduplicated
// CSV keyed on registrable domain.
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, newCrawlContext, preferHttps } from './browser.js';
import { COLUMNS, QUALIFICATION } from './schema.js';
import { buildQueries } from './queries.js';
import { NY_MARKETS } from './geo.js';
import { searchQuery, registrableDomain, isNonFacilityHost, isGovHost } from './search.js';
import {
  fetchPage, pickSubpages, extractEmails, classifyEmails, extractPeople,
  detectIndoor, detectSports, detectCourtCount, looksExcluded, looksMonetized,
  guessFacilityType, detectCity, guessTitleFromName, decodeEntities,
} from './extract.js';
import { guessEmails, GUESS_DISCLAIMER } from './emails.js';
import { qualify, isKeepable } from './classify.js';
import { toCsv } from './csv.js';

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const OUT = arg('out', 'NEW_YORK_INDOOR_COURT_FACILITIES.csv');
const STATE = arg('state', 'NY');
const MAX_QUERIES = parseInt(arg('max-queries', '0'), 10);
const MAX_SITES = parseInt(arg('max-sites', '0'), 10);
const CONCURRENCY = parseInt(arg('concurrency', '4'), 10);
const CACHE_DIR = arg('cache', '.cache');
const RESUME = fs.existsSync(path.join(CACHE_DIR, 'sites.json'));

fs.mkdirSync(CACHE_DIR, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// --------------------------------------------------------------------------
// Phase 1 - discovery
// --------------------------------------------------------------------------
async function discover(browser) {
  const cachePath = path.join(CACHE_DIR, 'sites.json');
  const seed = arg('sites-file', '');
  if (seed) {
    const list = JSON.parse(fs.readFileSync(seed, 'utf8'));
    const sites = {};
    for (const entry of list) {
      const url = typeof entry === 'string' ? entry : entry.url;
      const domain = registrableDomain(url) || url;
      sites[domain] = { domain, url, titles: [], snippets: [], queries: ['(seeded)'] };
    }
    log(`seeded ${Object.keys(sites).length} domains from ${seed}`);
    return sites;
  }
  if (RESUME) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    log(`resuming discovery cache: ${Object.keys(cached).length} domains`);
    return cached;
  }

  const queries = buildQueries({ markets: NY_MARKETS, limit: MAX_QUERIES });
  log(`discovery: ${queries.length} queries`);

  const sites = {}; // domain -> {domain, url, titles[], snippets[], queries[]}
  const { ctx, page } = await newCrawlContext(browser, { blockAssets: false });
  let blocked = 0;

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const { rows, engine, errors } = await searchQuery(page, q);
    if (!rows.length) {
      blocked++;
      if (blocked === 5) {
        log('WARNING: 5 consecutive query failures. Sample errors:', errors.join(' | '));
      }
      if (blocked > 40) {
        throw new Error(
          'Search engines unreachable (40+ failures). Run `npm run preflight` - ' +
            'this environment likely blocks outbound web egress.',
        );
      }
      continue;
    }
    blocked = 0;
    for (const r of rows) {
      const domain = registrableDomain(r.url);
      if (!domain || isNonFacilityHost(domain) || isGovHost(domain)) continue;
      const s = (sites[domain] ??= { domain, url: `https://${domain}`, titles: [], snippets: [], queries: [] });
      if (r.title) s.titles.push(r.title);
      if (r.snippet) s.snippets.push(r.snippet);
      s.queries.push(q);
    }
    if (i % 25 === 0) {
      log(`  q${i + 1}/${queries.length} [${engine}] domains=${Object.keys(sites).length}`);
      fs.writeFileSync(cachePath, JSON.stringify(sites));
    }
    await page.waitForTimeout(500 + Math.floor(600 * ((i * 2654435761) % 1000) / 1000));
  }

  await ctx.close();
  fs.writeFileSync(cachePath, JSON.stringify(sites));
  log(`discovery complete: ${Object.keys(sites).length} candidate domains`);
  return sites;
}

// --------------------------------------------------------------------------
// Phase 2 - enrichment
// --------------------------------------------------------------------------
async function enrichSite(page, site) {
  const sources = [];
  let text = '';
  let html = '';
  let links = [];

  // Try https first (the only scheme a CONNECT-only proxy can tunnel), then the
  // www. form, then the original URL as given.
  const attempts = [...new Set([preferHttps(site.url), `https://www.${site.domain}`, site.url])];
  let home = null;
  let lastErr = null;
  for (const attempt of attempts) {
    try {
      home = await fetchPage(page, attempt);
      break;
    } catch (e) {
      lastErr = e;
      // Clear the failed navigation before retrying; otherwise the next goto is
      // reported as "interrupted by another navigation". goto() resolves on
      // commit, so the error page can still be settling - wait it out briefly.
      await page.goto('about:blank').catch(() => {});
      await page.waitForTimeout(250).catch(() => {});
    }
  }
  if (!home) throw lastErr;
  sources.push(home.url);
  text += '\n' + home.text;
  html += '\n' + home.html;
  links = home.links;

  const name = guessTitleFromName(home.html) || decodeEntities(site.titles[0] || '') || site.domain;

  for (const sub of pickSubpages(links, site.domain, 6)) {
    try {
      const p = await fetchPage(page, sub, { timeout: 20000 });
      sources.push(p.url);
      text += '\n' + p.text;
      html += '\n' + p.html;
    } catch {
      /* a dead interior page should not sink the facility */
    }
  }

  const searchBlurb = [...site.titles, ...site.snippets].join('\n');
  const corpus = `${text}\n${searchBlurb}`;

  const { indoor, outdoor, outdoorOnly } = detectIndoor(corpus);
  const sports = detectSports(corpus);
  const excludedBy = looksExcluded(name, corpus);
  const monetized = looksMonetized(corpus);
  const verdict = qualify({ indoor, outdoor, outdoorOnly, excludedBy, monetized, sports });

  const emails = extractEmails(text, html);
  const { shared, direct } = classifyEmails(emails, site.domain);
  const people = extractPeople(text);
  const person = people[0] || null;

  // A direct email whose local part echoes the person's name is the best match.
  let publicDirect = '';
  if (person) {
    const f = person.first.toLowerCase();
    const l = person.last.toLowerCase();
    publicDirect =
      direct.find((e) => {
        const lp = e.split('@')[0].replace(/[^a-z]/g, '');
        return lp.includes(l) || lp === f || lp.startsWith(f);
      }) || '';
  }
  if (!publicDirect && direct.length === 1 && !person) publicDirect = direct[0];

  const guesses = person && !publicDirect ? guessEmails(person.first, person.last, site.domain) : ['', '', '', '', '', ''];
  const { count, note } = detectCourtCount(corpus);

  const notes = [verdict.reason];
  if (!person) notes.push('No decision maker found on public pages.');
  if (guesses[0]) notes.push(GUESS_DISCLAIMER);
  if (!count) notes.push('No court count stated by a reliable source; left blank.');
  if (monetized) notes.push('Paid access signals present (membership/rental/program).');

  return {
    'Facility Name': name,
    Website: home.url,
    City: detectCity(text),
    State: STATE,
    'Facility Type': guessFacilityType(name, corpus),
    'Sports Offered': sports.join('; '),
    'Indoor Court Status': verdict.indoorStatus,
    'Number of Courts': count,
    'Court Count Notes': note,
    'Decision Maker First Name': person?.first || '',
    'Decision Maker Last Name': person?.last || '',
    'Decision Maker Title': person?.title || '',
    'Public Direct Email': publicDirect,
    'Shared Facility Email': shared,
    'Guessed Email 1': guesses[0],
    'Guessed Email 2': guesses[1],
    'Guessed Email 3': guesses[2],
    'Guessed Email 4': guesses[3],
    'Guessed Email 5': guesses[4],
    'Guessed Email 6': guesses[5],
    'Email Domain': site.domain,
    'Qualification Status': verdict.status,
    'Research Notes': notes.join(' '),
    'Source URLs': [...new Set(sources)].join(' | '),
  };
}

async function enrichAll(browser, sites) {
  let list = Object.values(sites);
  if (MAX_SITES > 0) list = list.slice(0, MAX_SITES);
  log(`enrichment: ${list.length} sites, concurrency=${CONCURRENCY}`);

  const rows = [];
  let next = 0;
  let done = 0;

  async function worker() {
    const { ctx, page } = await newCrawlContext(browser);
    while (true) {
      const i = next++;
      if (i >= list.length) break;
      const site = list[i];
      try {
        const row = await enrichSite(page, site);
        if (isKeepable(row['Qualification Status'])) rows.push(row);
        else log(`  skip ${site.domain} (${row['Qualification Status']}) - ${row['Research Notes']}`);
      } catch (e) {
        log(`  fail ${site.domain}: ${e.message.split('\n')[0]}`);
      }
      if (++done % 20 === 0) log(`  enriched ${done}/${list.length}, kept ${rows.length}`);
    }
    await ctx.close();
  }

  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
  return rows;
}

// --------------------------------------------------------------------------
// Dedup + write
// --------------------------------------------------------------------------
function dedupe(rows) {
  const byDomain = new Map();
  for (const r of rows) {
    const k = r['Email Domain'] || registrableDomain(r.Website);
    const prev = byDomain.get(k);
    if (!prev) {
      byDomain.set(k, r);
      continue;
    }
    // Keep the richer record.
    const score = (x) =>
      (x['Public Direct Email'] ? 4 : 0) +
      (x['Shared Facility Email'] ? 2 : 0) +
      (x['Decision Maker Last Name'] ? 2 : 0) +
      (x['Number of Courts'] ? 1 : 0);
    if (score(r) > score(prev)) byDomain.set(k, r);
  }
  const order = {
    [QUALIFICATION.CONFIRMED_INDOOR]: 0,
    [QUALIFICATION.INDOOR_AND_OUTDOOR]: 1,
    [QUALIFICATION.NEEDS_REVIEW]: 2,
  };
  return [...byDomain.values()].sort(
    (a, b) =>
      (order[a['Qualification Status']] ?? 9) - (order[b['Qualification Status']] ?? 9) ||
      String(a['Facility Name']).localeCompare(String(b['Facility Name'])),
  );
}

// --------------------------------------------------------------------------
const browser = await launchBrowser();
try {
  const sites = await discover(browser);
  if (!Object.keys(sites).length) {
    throw new Error('Discovery produced zero domains - see `npm run preflight`.');
  }
  const rows = dedupe(await enrichAll(browser, sites));
  fs.writeFileSync(OUT, toCsv(rows, COLUMNS));
  log(`wrote ${rows.length} rows to ${OUT}`);
  const tally = rows.reduce((m, r) => ((m[r['Qualification Status']] = (m[r['Qualification Status']] || 0) + 1), m), {});
  log('by status:', JSON.stringify(tally));
} finally {
  await browser.close();
}
