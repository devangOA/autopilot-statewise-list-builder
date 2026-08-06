// Search-result harvesting. Each engine returns {url, title, snippet}; the
// caller dedupes by registrable domain.
//
// Engine health is not stable over time. As of the current run:
//   startpage  200, clean result markup                      -> primary
//   brave      200, svelte markup, a.l1 inside .snippet       -> primary
//   bing       200, but every href is a /ck/a redirect that
//              must be base64-decoded or the domain reads as
//              bing.com and is dropped as a non-facility host
//   yahoo      200, noisy (own /local/ and scout.yahoo links)
//   duckduckgo 403 on html. and lite. endpoints               -> dead
//   mojeek     altcha captcha interstitial                    -> dead
// Dead engines stay in the list on purpose: they cost one navigation, are
// detected by the status gate below, and cost nothing once they recover.

const ENGINES = [
  {
    name: 'startpage',
    url: (q) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}`,
    extract: () =>
      [...document.querySelectorAll('.w-gl__result, [data-testid="result"], .result')].map((r) => ({
        url: r.querySelector('a.result-link, a[href^="http"]')?.href || '',
        title: r.querySelector('h2, .w-gl__result-title')?.innerText?.trim() || '',
        snippet: r.querySelector('.description, p')?.innerText?.trim() || '',
      })),
  },
  {
    name: 'brave',
    url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
    extract: () =>
      [...document.querySelectorAll('#results div.snippet[data-type="web"]')].map((r) => ({
        url: r.querySelector('a.l1, a[href^="http"]')?.href || '',
        title: r.querySelector('.title, .snippet-title')?.innerText?.trim() || '',
        snippet: r.querySelector('.snippet-description, .snippet-content')?.innerText?.trim() || '',
      })),
  },
  {
    name: 'bing',
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=30`,
    extract: () =>
      [...document.querySelectorAll('li.b_algo')].map((r) => ({
        url: r.querySelector('h2 a')?.href || '',
        title: r.querySelector('h2')?.innerText?.trim() || '',
        snippet: r.querySelector('.b_caption p, .b_algoSlug')?.innerText?.trim() || '',
      })),
  },
  {
    name: 'yahoo',
    url: (q) => `https://search.yahoo.com/search?p=${encodeURIComponent(q)}`,
    extract: () =>
      [...document.querySelectorAll('#web li div.algo, div.algo-sr')].map((r) => ({
        url: r.querySelector('h3 a[href^="http"], a[href^="http"]')?.href || '',
        title: r.querySelector('h3')?.innerText?.trim() || '',
        snippet: r.querySelector('.compText, p')?.innerText?.trim() || '',
      })),
  },
  {
    name: 'duckduckgo',
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    extract: () =>
      [...document.querySelectorAll('.result')].map((r) => ({
        url: r.querySelector('a.result__a')?.href || '',
        title: r.querySelector('a.result__a')?.innerText?.trim() || '',
        snippet: r.querySelector('.result__snippet')?.innerText?.trim() || '',
      })),
  },
  {
    name: 'mojeek',
    url: (q) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`,
    extract: () =>
      [...document.querySelectorAll('ul.results-standard li')].map((r) => ({
        url: r.querySelector('a.title, h2 a')?.href || '',
        title: r.querySelector('a.title, h2 a')?.innerText?.trim() || '',
        snippet: r.querySelector('p.s')?.innerText?.trim() || '',
      })),
  },
];

/**
 * Undo search-engine click-tracking wrappers.
 *
 * Bing is the one that matters: every organic href is
 * `https://www.bing.com/ck/a?...&u=a1<base64url-of-target>&ntb=1`. Left alone
 * the registrable domain of every Bing result is `bing.com`, which
 * isNonFacilityHost() drops — i.e. Bing contributes zero candidates. The `a1`
 * prefix is Bing's marker, the rest is base64url with the padding stripped.
 *
 * DuckDuckGo's `/l/?uddg=` and Yahoo's `RU=` wrappers are handled too, so the
 * same helper covers those engines if/when they come back.
 */
export function unwrapRedirect(href) {
  if (!href) return '';
  let u;
  try {
    u = new URL(href);
  } catch {
    return '';
  }
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();

  if (host === 'bing.com' && u.pathname.startsWith('/ck/')) {
    const raw = u.searchParams.get('u') || '';
    const b64 = raw.startsWith('a1') ? raw.slice(2) : raw;
    try {
      const pad = b64.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(pad + '='.repeat((4 - (pad.length % 4)) % 4), 'base64').toString('utf8');
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {
      /* fall through - an undecodable wrapper is simply not a candidate */
    }
    return '';
  }

  if (host === 'duckduckgo.com' && u.pathname.startsWith('/l/')) {
    const t = u.searchParams.get('uddg');
    if (t && /^https?:\/\//i.test(t)) return t;
    return '';
  }

  // Yahoo wraps some results as /RU=<percent-encoded>/RK=... path segments.
  if (host.endsWith('yahoo.com') && /\/RU=/.test(u.pathname)) {
    const m = u.pathname.match(/\/RU=([^/]+)/);
    if (m) {
      try {
        const t = decodeURIComponent(m[1]);
        if (/^https?:\/\//i.test(t)) return t;
      } catch {
        /* ignore */
      }
    }
    return '';
  }

  return href;
}

// Aggregators, directories and social pages: useful as *signal* but never the
// facility's own site, so they are not treated as candidate domains.
const NON_FACILITY = [
  'yelp.', 'tripadvisor.', 'facebook.', 'instagram.', 'twitter.', 'x.com', 'tiktok.',
  'youtube.', 'linkedin.', 'pinterest.', 'reddit.', 'wikipedia.', 'yellowpages.',
  'mapquest.', 'google.', 'bing.', 'duckduckgo.', 'mojeek.', 'apple.com',
  'eventbrite.', 'meetup.', 'groupon.', 'indeed.', 'ziprecruiter.', 'glassdoor.',
  'places.', 'foursquare.', 'nextdoor.', 'patch.com', 'niche.com', 'usnews.com',
  'courtreserve.com', 'playbypoint.com', 'pickleheads.com', 'places.pickleplay.com',
  'teamunify.com', 'leagueapps.com', 'sportsengine.com', 'teamsnap.com',
  'amazon.', 'ebay.', 'craigslist.', 'zillow.', 'realtor.', 'apartments.com',
  // engines themselves + wrappers, in case a redirect fails to unwrap
  'startpage.com', 'brave.com', 'yahoo.com', 'ecosia.org', 'searx', 'qwant.',
  // directory/content farms seen in NY court-sport SERPs
  'courtsource.us', 'picklecourtsnearme.com', 'playtimescheduler.com',
  'pickleballchatbots.com', 'tenniscircuits.com', 'usta.com', 'globalsportsjobs.',
  'gympik.', 'tripsavvy.', 'thumbtack.', 'angi.com', 'bbb.org', 'manta.com',
  'chamberofcommerce.com', 'buzzfile.com', 'dnb.com', 'zoominfo.com', 'crunchbase.',
  'mindbodyonline.com', 'clubautomation.com', 'daysmartrecreation.com',
  // venue/lesson marketplaces and court-finder apps: they list facilities,
  // they do not operate courts
  'peerspace.com', 'swimply.com', 'mytennislessons.com', 'goodrun.app',
  'playyourcourt.com', 'globaltennisnetwork.com', 'clublocker.com', 'squadz.com',
  'giggster.com', 'splacer.co', 'thisopenspace.com', 'sparkplace.',
  'takelessons.com', 'lessons.com', 'coachup.com', 'teachme.to',
  'eventbrite.com', 'active.com', 'signupgenius.com', 'gofundme.com',
  'tripadvisor.com', 'expedia.', 'booking.com', 'hotels.com', 'airbnb.',
];

export function isNonFacilityHost(host) {
  const h = host.toLowerCase();
  return NON_FACILITY.some((n) => h.includes(n));
}

// Public parks / government / municipal domains are out of scope per the brief.
const GOV_PATTERNS = [/\.gov$/i, /\.tx\.us$/i, /\.state\.tx\.us$/i, /\.mil$/i];
export function isGovHost(host) {
  return GOV_PATTERNS.some((p) => p.test(host));
}

export function registrableDomain(urlOrHost) {
  let host = urlOrHost;
  try {
    // .host, not .hostname: keeps an explicit port so distinct local test
    // hosts stay distinct. Real facility URLs carry no port, so this is a
    // no-op in production.
    if (/^https?:/i.test(urlOrHost)) host = new URL(urlOrHost).host;
  } catch {
    return '';
  }
  host = host.replace(/^www\./i, '').toLowerCase();
  return host;
}

// Two-label public suffixes that show up on facility sites. Anything not
// listed is treated as a single-label TLD, which is right for the .com/.org/
// .net/.us that dominate this data set.
const MULTI_TLD = new Set(['co.uk', 'org.uk', 'com.au', 'co.nz', 'tx.us', 'k12.tx.us']);

// Subdomains that are a facility's own plumbing rather than a separate
// business. Only these are stripped.
const VANITY_SUBDOMAIN = new Set([
  'www', 'www2', 'book', 'booking', 'bookings', 'reserve', 'reservations',
  'play', 'portal', 'members', 'member', 'my', 'app', 'apps', 'secure',
  'shop', 'store', 'ir', 'investors', 'info', 'home', 'web', 'mail', 'email',
  'go', 'get', 'new', 'old', 'beta', 'staging', 'm', 'mobile', 'club', 'courts',
]);

/**
 * Host with a vanity subdomain removed, e.g. `book.412squash.org` ->
 * `412squash.org`. Used for the mail domain (a booking subdomain never
 * receives mail) and for facility dedup.
 *
 * This strips a *known* prefix rather than reducing to the registrable apex.
 * Reducing to the apex merged unrelated businesses that merely share a host:
 * two different clubs on `squarespace.com`, five on `ezfacility.com`, and
 * `drumlins.syracuse.edu` with every other facility at that university. Those
 * are separate facilities and must stay separate rows.
 */
export function apexDomain(urlOrHost) {
  const h = registrableDomain(urlOrHost);
  if (!h) return h;
  const parts = h.split('.');
  const minLabels = MULTI_TLD.has(parts.slice(-2).join('.')) ? 3 : 2;
  // Peel only leading labels that are known plumbing, never the brand label.
  let i = 0;
  while (parts.length - i > minLabels && VANITY_SUBDOMAIN.has(parts[i].toLowerCase())) i++;
  return parts.slice(i).join('.');
}

async function runEngine(page, engine, query, { timeout = 30000 } = {}) {
  const res = await page.goto(engine.url(query), { timeout, waitUntil: 'domcontentloaded' });
  // A 403/429/captcha page still parses to zero rows, but failing fast on the
  // status keeps a rate-limited engine from being retried as if it were merely
  // empty, and gives the caller a usable error string.
  const status = res?.status();
  if (status && status >= 400) throw new Error(`HTTP ${status}`);
  // Some engines lazily render; a short settle avoids empty extractions.
  await page.waitForTimeout(700).catch(() => {});
  const rows = await page.evaluate(engine.extract);
  return rows
    .map((r) => ({ ...r, url: unwrapRedirect(r.url) }))
    .filter((r) => r.url && /^https?:/i.test(r.url))
    .map((r) => ({ ...r, engine: engine.name, query }));
}

/**
 * Run one query across engines, stopping at the first engine that yields
 * results. Returns [] if every engine fails (blocked, captcha, timeout).
 *
 * `offset` rotates which engine is tried first. Discovery workers pass their
 * worker index so concurrent workers spread load across engines instead of all
 * hammering the same one into a rate limit.
 */
export async function searchQuery(page, query, opts = {}) {
  const { offset = 0, engines = ENGINES, ...rest } = opts;
  const errors = [];
  const order = engines.map((_, i) => engines[(i + offset) % engines.length]);
  for (const engine of order) {
    try {
      const rows = await runEngine(page, engine, query, rest);
      if (rows.length) return { rows, engine: engine.name, errors };
      errors.push(`${engine.name}: 0 rows`);
    } catch (e) {
      errors.push(`${engine.name}: ${e.message.split('\n')[0]}`);
    }
  }
  return { rows: [], engine: null, errors };
}

export { ENGINES };
