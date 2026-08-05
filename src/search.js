// Search-result harvesting. Each engine returns {url, title, snippet}; the
// caller dedupes by registrable domain.

const ENGINES = [
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
];

export function isNonFacilityHost(host) {
  const h = host.toLowerCase();
  return NON_FACILITY.some((n) => h.includes(n));
}

// Public parks / government / municipal domains are out of scope per the brief.
const GOV_PATTERNS = [/\.gov$/i, /\.ny\.us$/i, /\.state\.ny\.us$/i];
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

async function runEngine(page, engine, query, { timeout = 30000 } = {}) {
  await page.goto(engine.url(query), { timeout, waitUntil: 'domcontentloaded' });
  // Some engines lazily render; a short settle avoids empty extractions.
  await page.waitForTimeout(600).catch(() => {});
  const rows = await page.evaluate(engine.extract);
  return rows
    .filter((r) => r.url && /^https?:/i.test(r.url))
    .map((r) => ({ ...r, engine: engine.name, query }));
}

/**
 * Run one query across engines, stopping at the first engine that yields
 * results. Returns [] if every engine fails (blocked, captcha, timeout).
 */
export async function searchQuery(page, query, opts = {}) {
  const errors = [];
  for (const engine of ENGINES) {
    try {
      const rows = await runEngine(page, engine, query, opts);
      if (rows.length) return { rows, engine: engine.name, errors };
    } catch (e) {
      errors.push(`${engine.name}: ${e.message.split('\n')[0]}`);
    }
  }
  return { rows: [], engine: null, errors };
}

export { ENGINES };
