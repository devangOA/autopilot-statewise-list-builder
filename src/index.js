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
  looksRetail, detectNyEvidence, guessFacilityType, detectCity,
  guessTitleFromName, decodeEntities,
} from './extract.js';
import { guessEmails, GUESS_DISCLAIMER } from './emails.js';
import { qualify, isKeepable } from './classify.js';
import { finalize } from './finalize.js';
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
const DISCOVERY_CONCURRENCY = parseInt(arg('discovery-concurrency', '4'), 10);
const CACHE_DIR = arg('cache', '.cache');

fs.mkdirSync(CACHE_DIR, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// --------------------------------------------------------------------------
// Phase 1 - discovery
// --------------------------------------------------------------------------
async function discover(browser) {
  const cachePath = path.join(CACHE_DIR, 'sites.json');
  const donePath = path.join(CACHE_DIR, 'queries-done.json');
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

  const all = buildQueries({ markets: NY_MARKETS, limit: MAX_QUERIES });

  // Resume at query granularity, not all-or-nothing: a crash 3000 queries into
  // a statewide fan-out should not restart discovery from zero.
  const sites = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};
  const done = new Set(fs.existsSync(donePath) ? JSON.parse(fs.readFileSync(donePath, 'utf8')) : []);
  const queries = all.filter((q) => !done.has(q));
  if (done.size) log(`resuming discovery: ${done.size} queries already done, ${Object.keys(sites).length} domains`);
  log(`discovery: ${queries.length} queries, concurrency=${DISCOVERY_CONCURRENCY}`);
  if (!queries.length) return sites;

  let next = 0;
  let completed = 0;
  let emptyStreak = 0;
  const flush = () => {
    fs.writeFileSync(cachePath, JSON.stringify(sites));
    fs.writeFileSync(donePath, JSON.stringify([...done]));
  };

  // Each worker starts its engine rotation at a different offset so N workers
  // spread load across N engines rather than all rate-limiting the same one.
  async function worker(w) {
    const { ctx, page } = await newCrawlContext(browser, { blockAssets: true });
    while (true) {
      const i = next++;
      if (i >= queries.length) break;
      const q = queries[i];
      let rows = [];
      let engine = null;
      let errors = [];
      try {
        ({ rows, engine, errors } = await searchQuery(page, q, { offset: w }));
      } catch (e) {
        errors = [e.message.split('\n')[0]];
      }
      if (!rows.length) {
        if (++emptyStreak === 10) log('WARNING: 10 empty queries in a row. Sample errors:', errors.join(' | '));
        if (emptyStreak > 120) {
          log('ABORT: 120 consecutive empty queries - every engine appears blocked.');
          break;
        }
        // Every engine rate-limits eventually. Back off so the limit can decay
        // instead of burning the rest of the query list against a wall of 429s.
        await page.waitForTimeout(Math.min(30000, 1000 * emptyStreak)).catch(() => {});
        // Deliberately NOT marked done: a query starved by a rate limit has not
        // been researched, and a resume must retry it rather than skip it.
        continue;
      } else {
        emptyStreak = 0;
        for (const r of rows) {
          const domain = registrableDomain(r.url);
          if (!domain || isNonFacilityHost(domain) || isGovHost(domain)) continue;
          const s = (sites[domain] ??= { domain, url: `https://${domain}`, titles: [], snippets: [], queries: [] });
          // Cap the accumulated blurb: a domain matched by 200 queries would
          // otherwise carry a corpus large enough to skew extraction.
          if (r.title && s.titles.length < 12) s.titles.push(r.title);
          if (r.snippet && s.snippets.length < 12) s.snippets.push(r.snippet);
          if (s.queries.length < 12) s.queries.push(q);
        }
      }
      done.add(q);
      if (++completed % 50 === 0) {
        log(`  q${completed}/${queries.length} [${engine || 'none'}] domains=${Object.keys(sites).length}`);
        flush();
      }
      // Politeness jitter, deterministic so runs are reproducible.
      await page.waitForTimeout(400 + ((i * 2654435761) % 700)).catch(() => {});
    }
    await ctx.close();
  }

  await Promise.all(
    Array.from({ length: Math.max(1, DISCOVERY_CONCURRENCY) }, (_, w) => worker(w)),
  );
  flush();
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
  const retail = looksRetail(text);
  // Location evidence is taken from the pages themselves, never from search
  // snippets: a snippet says "NY" because the query did.
  const nyEvidence = detectNyEvidence(text);
  const verdict = qualify({ indoor, outdoor, outdoorOnly, excludedBy, monetized, sports, retail, nyEvidence });

  const emails = extractEmails(text, html);
  const { shared, direct } = classifyEmails(emails, site.domain, name);
  // A person whose name is just words lifted out of the facility's own name is
  // an artifact, not a contact ("Marlene Meyerson JCC Manhattan" -> "Meyerson
  // Manhattan"). Drop those before picking the best decision maker.
  const nameWords = new Set(name.toLowerCase().split(/[^a-z]+/).filter(Boolean));
  const people = extractPeople(text).filter(
    (p) => !(nameWords.has(p.first.toLowerCase()) && nameWords.has(p.last.toLowerCase())),
  );
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
  if (nyEvidence) notes.push(`NY location evidence: ${nyEvidence}.`);
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
  const attemptedPath = path.join(CACHE_DIR, 'attempted.json');
  const rowsPath = path.join(CACHE_DIR, 'rows.json');

  // Enrichment resumes like discovery does. A site is "attempted" whether it
  // qualified, was skipped or failed, so a second discovery wave only crawls
  // the domains it actually added instead of re-fetching thousands of sites.
  const attempted = new Set(
    fs.existsSync(attemptedPath) ? JSON.parse(fs.readFileSync(attemptedPath, 'utf8')) : [],
  );
  const rows = fs.existsSync(rowsPath) ? JSON.parse(fs.readFileSync(rowsPath, 'utf8')) : [];

  let list = Object.values(sites).filter((s) => !attempted.has(s.domain));
  if (MAX_SITES > 0) list = list.slice(0, MAX_SITES);
  if (attempted.size) log(`resuming enrichment: ${attempted.size} sites already done, ${rows.length} rows kept`);
  log(`enrichment: ${list.length} sites, concurrency=${CONCURRENCY}`);

  let next = 0;
  let done = 0;
  const flush = () => {
    fs.writeFileSync(rowsPath, JSON.stringify(rows));
    fs.writeFileSync(attemptedPath, JSON.stringify([...attempted]));
    // A statewide run takes hours; keep a usable deliverable on disk the whole
    // way through rather than only at the end.
    fs.writeFileSync(OUT, toCsv(dedupe(rows), COLUMNS));
  };

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
      // Marked after the attempt regardless of outcome: a site that failed or
      // was disqualified has been researched and should not be re-crawled.
      attempted.add(site.domain);
      if (++done % 20 === 0) {
        log(`  enriched ${done}/${list.length}, kept ${rows.length}`);
        flush();
      }
    }
    await ctx.close();
  }

  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
  flush();
  return rows;
}

// --------------------------------------------------------------------------
// Dedup + write
// --------------------------------------------------------------------------
// Facility/contact dedup and mail-domain normalization live in finalize.js so
// they can also be re-applied to a cached run without re-crawling.
const dedupe = finalize;

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
