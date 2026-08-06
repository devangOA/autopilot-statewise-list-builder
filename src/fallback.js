// Scrapling fallback for URLs the Playwright crawler could not retrieve.
//
// Scope is deliberately narrow. Playwright stays the primary crawler; this runs
// only for a URL that already *failed*, never for one that succeeded or merely
// returned little. Two tiers, cheapest first:
//
//   Scrapling Fetcher  - HTTP with TLS-fingerprint spoofing, no browser.
//                        Recovered both hard-403 sites in the benchmark in
//                        ~0.5s each, against 9-15s for the stealth browser.
//   Scrapling Stealth  - full stealth browser, tried only if the cheap fetcher
//                        also fails.
//
// A 200 from either tier is NOT sufficient to accept the page. Benchmarking
// found joespickleball.com had been abandoned and now redirects to an
// Indonesian gambling portal, which Playwright correctly refused and Scrapling
// happily returned as HTTP 200. Every response is therefore checked for domain
// identity and topical relevance before it is allowed anywhere near the data.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { registrableDomain, apexDomain } from './search.js';
import { detectSports } from './extract.js';

export const RETRIEVAL = {
  PLAYWRIGHT: 'Playwright',
  FETCHER: 'Scrapling Fetcher',
  STEALTH: 'Scrapling Stealth',
};

const PY = path.join(process.cwd(), 'experiments', 'scrapling-eval', '.venv', 'bin', 'python');
const RUNNER = path.join(process.cwd(), 'src', 'scrapling_fetch.py');

export function fallbackAvailable() {
  return fs.existsSync(PY) && fs.existsSync(RUNNER);
}

// Content that means the domain no longer belongs to the facility. Parked,
// hijacked and expired domains overwhelmingly land on one of these.
const HIJACK_PATTERNS = [
  /\b(togel|toto|slot gacor|bandar|judi|casino|poker|betting|sportsbook|taruhan)\b/i,
  /\b(domain (is )?(for sale|parked|expired)|buy this domain|this domain is available)\b/i,
  /\b(under construction|coming soon|site not found|account suspended|default web page)\b/i,
  /\b(porn|xxx|escort|adult (dating|video))\b/i,
  /\bgodaddy\b.{0,40}\bparked\b/i,
  /\b(web hosting|vps hosting|buy now.{0,20}domain)\b/i,
];

// Evidence that the page really is a court-sport facility rather than a
// directory, retailer or media page that happens to rank for the query.
const FACILITY_EVIDENCE =
  /\b(court|courts|gym|gymnasium|club|facility|facilities|membership|book a court|court time|open play|league|clinic|lesson|reservation)\b/i;

/**
 * Decide whether a fallback response may be used.
 *
 * Returns `{ ok: true }` or `{ ok: false, reason }`. The reason is recorded on
 * the row so a rejection is auditable rather than an invisible drop.
 */
export function validateFallback({ requestedUrl, finalUrl, text, html = '' }) {
  const want = apexDomain(registrableDomain(requestedUrl));
  const got = apexDomain(registrableDomain(finalUrl || requestedUrl));
  if (!got) return { ok: false, reason: 'Fallback returned no usable final URL.' };
  if (want !== got) {
    return {
      ok: false,
      reason: `Fallback redirected off-domain (${want} -> ${got}); content belongs to a different site.`,
    };
  }

  const body = `${text || ''}\n${String(html).slice(0, 20000)}`;
  if (!body.replace(/\s+/g, '').length) {
    return { ok: false, reason: 'Fallback returned an empty document.' };
  }
  const hijack = HIJACK_PATTERNS.find((r) => r.test(body));
  if (hijack) {
    return { ok: false, reason: `Fallback page looks parked/hijacked/unrelated: /${hijack.source}/` };
  }
  if (!detectSports(body).length) {
    return { ok: false, reason: 'Fallback page mentions no court sport; not a facility page.' };
  }
  if (!FACILITY_EVIDENCE.test(body)) {
    return { ok: false, reason: 'Fallback page carries no facility evidence (courts, membership, booking).' };
  }
  return { ok: true, reason: '' };
}

/**
 * Fetch one URL through a Scrapling tier. Resolves to a page bundle shaped like
 * the Playwright path's, so the caller's extraction code is unchanged.
 */
function runPython(url, mode, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(PY, [RUNNER, url, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ error: `fallback timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ error: (err || out || 'fallback produced no output').split('\n')[0].slice(0, 180) });
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ error: e.message });
    });
  });
}

/**
 * Try the cheap fetcher, then the stealth browser, stopping at the first tier
 * that both retrieves and validates. Escalation happens only on failure, so a
 * page the cheap tier already proved unusable is never fetched twice.
 */
export async function fetchWithFallback(url, { timeoutMs = 90000, allowStealth = true } = {}) {
  const attempts = [];
  const tiers = allowStealth
    ? [['http', RETRIEVAL.FETCHER], ['stealthy', RETRIEVAL.STEALTH]]
    : [['http', RETRIEVAL.FETCHER]];

  for (const [mode, label] of tiers) {
    const res = await runPython(url, mode, timeoutMs);
    if (res.error || !res.pages?.length) {
      attempts.push(`${label}: ${res.error || 'no pages'}`);
      continue;
    }
    const home = res.pages[0];
    const verdict = validateFallback({
      requestedUrl: url,
      finalUrl: home.finalUrl || home.url,
      text: res.pages.map((p) => p.text).join('\n'),
      html: home.html,
    });
    if (!verdict.ok) {
      // A rejected page is a dead end for this tier and for every tier after
      // it: escalating cannot make a gambling redirect into a facility.
      attempts.push(`${label}: REJECTED - ${verdict.reason}`);
      return { ok: false, method: label, pages: [], attempts, rejected: true, reason: verdict.reason };
    }
    return { ok: true, method: label, pages: res.pages, attempts, finalUrl: home.finalUrl || home.url };
  }
  return { ok: false, method: '', pages: [], attempts, rejected: false, reason: attempts.join(' | ') };
}
