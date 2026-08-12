import { chromium } from 'playwright';

export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Chromium proxy config derived from the environment.
 *
 * Two things this has to get right:
 *  - Playwright applies `proxy` to http:// as well as https://. Some corporate
 *    proxies only accept CONNECT (https) and answer plain-HTTP requests with a
 *    405 error page. A bypass list is supplied, but Chromium does not honor it
 *    for loopback in every build, so callers crawling local fixtures should set
 *    CRAWLER_DISABLE_PROXY=1 rather than rely on it. The real protection is that
 *    fetchPage() rejects any non-OK document instead of parsing the error page.
 *  - Returns undefined when no proxy is configured, so direct runs are untouched.
 */
export function proxyConfig(env = process.env) {
  // Escape hatch for local/offline runs (fixture servers, CI): the proxy would
  // otherwise intercept loopback traffic, and Chromium's bypass list is not
  // reliably honored for it.
  if (env.CRAWLER_DISABLE_PROXY === '1') return undefined;
  const server = env.HTTPS_PROXY || env.https_proxy;
  if (!server) return undefined;
  const fromEnv = (env.NO_PROXY || env.no_proxy || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bypass = [...new Set(['localhost', '127.0.0.1', '::1', ...fromEnv])].join(',');
  return { server, bypass };
}

export async function launchBrowser(extra = {}) {
  const proxy = proxyConfig();
  return chromium.launch({ args: ['--no-sandbox'], ...(proxy ? { proxy } : {}), ...extra });
}

export async function newCrawlContext(browser, { blockAssets = true } = {}) {
  // Certificate errors are the single largest recoverable failure class on this
  // corpus: 77 of ~230 real failures in the New York run were ERR_CERT_* or
  // ERR_SSL_*, almost all small clubs on an expired or mismatched certificate.
  // The crawl only ever reads public marketing pages, so trusting a bad cert
  // costs nothing and recovers the facility.
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();
  if (blockAssets) {
    // Images/fonts/video are pure cost for a text-extraction crawl.
    await page.route('**/*', (route) =>
      ['image', 'font', 'media'].includes(route.request().resourceType())
        ? route.abort()
        : route.continue(),
    );
  }
  return { ctx, page };
}

/**
 * The agent proxy tunnels https only, and virtually every facility site serves
 * https, so prefer it and let the site redirect if it really is http-only.
 */
export function preferHttps(url) {
  return String(url || '').replace(/^http:\/\//i, 'https://');
}

/**
 * Playwright's wording when the browser or its context is gone, as opposed to a
 * site-specific failure.
 *
 * The distinction decides whether a domain counts as researched: on a kill,
 * every in-flight and queued site fails instantly, and marking those "attempted"
 * makes a resume skip hundreds of sites it never visited. Exported from here
 * rather than living inline in the orchestrator so it can be tested directly -
 * it previously went missing from index.js entirely, which `node --check` could
 * not catch because an undefined identifier is a runtime error, not a syntax
 * error, and the crawl died on its first Playwright failure.
 */
export const BROWSER_GONE =
  /Target (page|closed)|context or browser has been closed|Browser(Context)? has been closed|browser has disconnected|Protocol error|Connection closed|Session closed|Page crashed/i;
