// Orchestrator: discover candidate facility domains from search engines, then
// visit each official site (plus its contact/about/staff pages) to extract
// indoor-court evidence, a decision maker, and emails. Writes one deduplicated
// CSV keyed on registrable domain.
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, newCrawlContext, preferHttps, BROWSER_GONE } from './browser.js';
import { COLUMNS, QUALIFICATION } from './schema.js';
import { buildQueries } from './queries.js';
import { stateConfig } from './states.js';
import { searchQuery, registrableDomain, isNonFacilityHost, isGovHost, setGovPatterns } from './search.js';
import {
  fetchPage, pickSubpages, extractEmails, classifyEmails, extractPeople,
  detectIndoor, detectSports, detectCourtCount, looksExcluded, looksMonetized,
  looksRetail, detectNyEvidence, guessFacilityType, detectCity,
  guessTitleFromName, decodeEntities, matchEmailsToPeople, detectAddresses,
  detectStateEvidence, setActiveState,
} from './extract.js';
import { guessEmails, GUESS_DISCLAIMER } from './emails.js';
import { qualify, isKeepable } from './classify.js';
import { finalize } from './finalize.js';
import { fetchWithFallback, fallbackAvailable, RETRIEVAL } from './fallback.js';
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
const ST = setActiveState(STATE);
setGovPatterns(ST.gov);
const MAX_QUERIES = parseInt(arg('max-queries', '0'), 10);
const MAX_SITES = parseInt(arg('max-sites', '0'), 10);
const CONCURRENCY = parseInt(arg('concurrency', '4'), 10);
const DISCOVERY_CONCURRENCY = parseInt(arg('discovery-concurrency', '4'), 10);
const CACHE_DIR = arg('cache', '.cache');
// Fallback is opt-out and silently disabled when the Python venv is absent, so
// the crawler still runs on a machine that never installed Scrapling.
const USE_FALLBACK = process.argv.includes('--no-fallback') ? false : fallbackAvailable();
// Additive pass: run the full template set against every market, ignoring the
// major/minor tiering. Completed queries are still skipped via the cache, so
// this executes exactly the angles tiering deferred and nothing else.
const ALL_TEMPLATES = process.argv.includes('--all-templates');
// Enrich what discovery has already found, without running more queries.
// Search engines rate-limit collectively after a few hours; enrichment touches
// facility sites instead, so running it first lets those limits decay and then
// discovery resumes at full speed. Purely a reordering - the cached query list
// is untouched and nothing is skipped permanently.
const SKIP_DISCOVERY = process.argv.includes('--skip-discovery');

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

  if (SKIP_DISCOVERY) {
    const cached = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};
    log(`skipping discovery: enriching ${Object.keys(cached).length} already-discovered domains`);
    return cached;
  }
  const all = buildQueries({
    markets: ST.markets,
    majorMarkets: ALL_TEMPLATES ? null : ST.majorMarkets,
    statewide: ST.statewide,
    limit: MAX_QUERIES,
  });

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
        // Every engine rate-limits eventually, and they do it collectively.
        // Short per-query backoff does not let a shared limit decay, so after a
        // sustained streak all workers take one long cooldown together.
        if (emptyStreak > 0 && emptyStreak % 25 === 0) {
          log(`  all engines limited (${emptyStreak} empty) - cooling down 120s`);
          await page.waitForTimeout(120000).catch(() => {});
        } else {
          await page.waitForTimeout(Math.min(20000, 1500 * emptyStreak)).catch(() => {});
        }
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
/**
 * Build a facility row from an already-retrieved page bundle. Shared by the
 * Playwright path and the Scrapling fallback so both produce identical rows and
 * differ only in `Retrieval Method`.
 */
function buildRow(site, pages, meta = {}) {
  const text = pages.map((p) => p.text || '').join('\n');
  const html = pages.map((p) => p.html || '').join('\n');
  const sources = [...new Set(pages.map((p) => p.url))];
  const name = guessTitleFromName(pages[0]?.html || '') || decodeEntities(site.titles?.[0] || '') || site.domain;
  const searchBlurb = [...(site.titles || []), ...(site.snippets || [])].join('\n');
  const corpus = `${text}\n${searchBlurb}`;

  const { indoor, outdoor, outdoorOnly } = detectIndoor(corpus);
  const sports = detectSports(corpus);
  const excludedBy = looksExcluded(name, corpus);
  const monetized = looksMonetized(corpus);
  const retail = looksRetail(text);
  const stateEvidence = detectStateEvidence(text, STATE);
  const verdict = qualify({ indoor, outdoor, outdoorOnly, excludedBy, monetized, sports, retail, stateEvidence, stateName: ST.name });

  const emails = extractEmails(text, html);
  const { shared, sharedAll, direct } = classifyEmails(emails, site.domain, name);
  const nameWords = new Set(name.toLowerCase().split(/[^a-z]+/).filter(Boolean));
  const people = extractPeople(text).filter(
    (p) => !(nameWords.has(p.first.toLowerCase()) && nameWords.has(p.last.toLowerCase())),
  );
  const person = people[0] || null;

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
  if (stateEvidence) notes.push(`${STATE} location evidence: ${stateEvidence}.`);
  if (!person) notes.push('No decision maker found on public pages.');
  if (guesses[0]) notes.push(GUESS_DISCLAIMER);
  if (!count) notes.push('No court count stated by a reliable source; left blank.');
  if (monetized) notes.push('Paid access signals present (membership/rental/program).');
  if (meta.fallbackNote) notes.push(meta.fallbackNote);

  return {
    'Facility Name': name,
    Website: pages[0]?.url || site.url,
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
    'Source URLs': sources.join(' | '),
    'Retrieval Method': meta.method || RETRIEVAL.PLAYWRIGHT,
    'Requested URL': site.url,
    'Final URL': meta.finalUrl || pages[0]?.url || site.url,
    'Failure Reason': meta.failureReason || '',
    _people: matchEmailsToPeople(people.slice(0, 8), direct),
    _directEmails: direct,
    _sharedEmails: sharedAll,
    _locations: detectAddresses(text),
  };
}

async function enrichSite(page, site) {
  // Try https first, then the www. form, then the URL as given.
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
      // reported as "interrupted by another navigation".
      await page.goto('about:blank').catch(() => {});
      await page.waitForTimeout(250).catch(() => {});
    }
  }
  if (!home) throw lastErr;

  const pages = [home];
  for (const sub of pickSubpages(home.links, site.domain, 6)) {
    try {
      pages.push(await fetchPage(page, sub, { timeout: 20000 }));
    } catch {
      /* a dead interior page should not sink the facility */
    }
  }
  return buildRow(site, pages, { method: RETRIEVAL.PLAYWRIGHT });
}

async function enrichAll(browser, sites) {
  const attemptedPath = path.join(CACHE_DIR, 'attempted.json');
  const rowsPath = path.join(CACHE_DIR, 'rows.json');

  // Enrichment resumes like discovery does. A site is "attempted" whether it
  // qualified, was skipped or failed, so a second discovery wave only crawls
  // the domains it actually added instead of re-fetching thousands of sites.
  const queuePath = path.join(CACHE_DIR, 'fallback-queue.json');
  const attempted = new Set(
    fs.existsSync(attemptedPath) ? JSON.parse(fs.readFileSync(attemptedPath, 'utf8')) : [],
  );
  const rows = fs.existsSync(rowsPath) ? JSON.parse(fs.readFileSync(rowsPath, 'utf8')) : [];
  // Survives pause, restart, internet loss and browser shutdown: a URL sits
  // here until every allowed retrieval method has been tried.
  const fallbackQueue = fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, 'utf8')) : [];
  const fbStats = { attempted: 0, fetcher: 0, stealth: 0, rejected: 0, failed: 0 };

  let list = Object.values(sites).filter((s) => !attempted.has(s.domain));
  if (MAX_SITES > 0) list = list.slice(0, MAX_SITES);
  if (attempted.size) log(`resuming enrichment: ${attempted.size} sites already done, ${rows.length} rows kept`);
  log(`enrichment: ${list.length} sites, concurrency=${CONCURRENCY}`);

  let next = 0;
  let done = 0;
  const flush = () => {
    fs.writeFileSync(rowsPath, JSON.stringify(rows));
    fs.writeFileSync(attemptedPath, JSON.stringify([...attempted]));
    fs.writeFileSync(queuePath, JSON.stringify(fallbackQueue));
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
        const msg = e.message.split('\n')[0];
        // A dead browser is not a verdict on this site. When the run is killed,
        // every queued site would otherwise fail instantly and be stamped
        // "researched", so a resume would skip hundreds of sites it never
        // visited. Stop the worker and leave them unmarked instead.
        if (BROWSER_GONE.test(msg)) {
          log(`  abort ${site.domain}: browser closed - left unmarked for resume`);
          break;
        }
        // Playwright failing is not the final verdict any more: the URL goes to
        // the fallback queue and is only marked attempted once every allowed
        // method has been exhausted.
        if (USE_FALLBACK) {
          fallbackQueue.push({ domain: site.domain, url: site.url, titles: site.titles || [], snippets: site.snippets || [], reason: msg });
          log(`  queue ${site.domain}: ${msg}`);
          // Counted as handed off, not as researched: `attempted` is still not
          // set, so the fallback decides the final verdict, but the primary
          // loop's own progress count stays accurate.
          done++;
          continue;
        }
        log(`  fail ${site.domain}: ${msg}`);
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

  // Exactly one fallback worker, by design: it runs a Python subprocess per URL
  // and must not compete with the primary crawlers for CPU on a laptop.
  let primariesFinished = false;
  async function fallbackWorker() {
    if (!USE_FALLBACK) return;
    while (true) {
      const job = fallbackQueue.shift();
      if (!job) {
        // An explicit signal, not a counter comparison: a site handed to the
        // fallback never completes in the primary loop, so inferring "done"
        // from those counters left this worker sleeping forever.
        if (primariesFinished) break;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      fbStats.attempted++;
      const res = await fetchWithFallback(job.url);
      if (res.ok) {
        if (res.method === RETRIEVAL.FETCHER) fbStats.fetcher++;
        else fbStats.stealth++;
        try {
          const row = buildRow(job, res.pages, {
            method: res.method,
            finalUrl: res.finalUrl,
            failureReason: `Playwright failed: ${job.reason}`,
            fallbackNote: `Retrieved by ${res.method} after Playwright failed.`,
          });
          if (isKeepable(row['Qualification Status'])) rows.push(row);
          else log(`  fb-skip ${job.domain} (${row['Qualification Status']})`);
        } catch (e) {
          log(`  fb-fail ${job.domain}: ${e.message.split('\n')[0]}`);
        }
      } else {
        if (res.rejected) {
          fbStats.rejected++;
          log(`  fb-REJECT ${job.domain}: ${res.reason}`);
        } else {
          fbStats.failed++;
        }
      }
      attempted.add(job.domain);
      flush();
    }
  }

  const primaries = Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker)).then(() => {
    primariesFinished = true;
  });
  await Promise.all([primaries, fallbackWorker()]);
  // Drain anything the primaries queued just before finishing.
  primariesFinished = true;
  await fallbackWorker();
  flush();
  log(`fallback: ${fbStats.attempted} attempted, ${fbStats.fetcher} recovered by Fetcher, ` +
      `${fbStats.stealth} by Stealth, ${fbStats.rejected} rejected by safety guards, ${fbStats.failed} unrecoverable`);
  fs.writeFileSync(path.join(CACHE_DIR, 'fallback-stats.json'), JSON.stringify(fbStats));
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
