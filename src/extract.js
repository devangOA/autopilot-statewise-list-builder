import { SPORTS } from './schema.js';

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

// Real sites serve UTF-8 without declaring a charset, so Chromium decodes the
// bytes as windows-1252 and hands us mojibake ("Dana â€” GM" for
// "Dana — GM"). Rather than enumerate every mangled dash, reverse the
// mis-decode: map the characters back to bytes through cp1252 and re-read them
// as UTF-8. Anything that does not round-trip is returned untouched.
const CP1252_HIGH = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

export function repairMojibake(s) {
  const str = String(s || '');
  // Â/Ã/â are the telltale leading bytes of mis-decoded UTF-8.
  if (!/[ÂÃâ]/.test(str)) return str;
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.codePointAt(i);
    if (c < 0x100) bytes[i] = c;
    else if (c in CP1252_HIGH) bytes[i] = CP1252_HIGH[c];
    else return str; // not a pure cp1252 mis-decode; leave it alone
  }
  try {
    return UTF8_STRICT.decode(bytes);
  } catch {
    return str;
  }
}

// Fold real punctuation variants down to ASCII so downstream patterns can use
// simple character classes.
const SEP_FIXES = [
  [/[‐-―−•·]/g, '-'],
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
  [/[   ​]/g, ' '],
];

export function normalizeSeparators(text) {
  let t = repairMojibake(text);
  for (const [re, to] of SEP_FIXES) t = t.replace(re, to);
  return t;
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#039': "'", '#38': '&', ndash: '-', mdash: '-', rsquo: "'",
  lsquo: "'", ldquo: '"', rdquo: '"', hellip: '...', reg: '', trade: '', copy: '',
};

export function decodeEntities(s) {
  return String(s || '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, key) => {
      const k = key.toLowerCase();
      if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
      return k in ENTITIES ? ENTITIES[k] : m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Page fetching
// ---------------------------------------------------------------------------

// A proxy that only speaks CONNECT answers plain-HTTP requests with an error
// page carrying a 4xx status. Parsing that as facility content yields a row with
// no sports, no emails and no name, which looks like a legitimately empty site.
// Treat any non-OK document as a fetch failure instead.
export class FetchError extends Error {
  constructor(url, status) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'FetchError';
    this.status = status;
  }
}

export async function fetchPage(page, url, { timeout = 25000 } = {}) {
  const res = await page.goto(url, { timeout, waitUntil: 'domcontentloaded' });
  const status = res?.status() ?? 0;
  if (status >= 400) throw new FetchError(url, status);
  await page.waitForTimeout(400).catch(() => {});
  const text = await page.evaluate(() => document.body?.innerText || '');
  const html = await page.content();
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('a[href]')].map((a) => ({
      href: a.href,
      text: (a.innerText || '').trim().slice(0, 120),
    })),
  );
  return { url: page.url(), status, text, html, links };
}

// Interior pages most likely to carry staff names, titles and emails.
const SUBPAGE_HINTS = [
  /contact/i, /about/i, /staff/i, /our[-\s]?team/i, /leadership/i, /management/i,
  /directory/i, /who[-\s]?we[-\s]?are/i, /meet[-\s]?the/i, /administration/i,
  /membership/i, /facilit/i, /courts?/i, /rentals?/i, /programs?/i, /athletics/i,
];

export function pickSubpages(links, baseHost, max = 6) {
  const seen = new Set();
  const out = [];
  for (const { href, text } of links) {
    let u;
    try {
      u = new URL(href);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (u.hostname.replace(/^www\./, '') !== baseHost) continue;
    const key = u.origin + u.pathname.replace(/\/$/, '');
    if (seen.has(key)) continue;
    const hay = `${u.pathname} ${text}`;
    if (!SUBPAGE_HINTS.some((h) => h.test(hay))) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const EMAIL_JUNK = /\.(png|jpe?g|gif|svg|webp|css|js)$/i;
const SHARED_LOCALPARTS = [
  'info', 'contact', 'hello', 'membership', 'memberships', 'operations', 'admin',
  'office', 'frontdesk', 'front desk', 'reservations', 'bookings', 'support',
  'inquiries', 'enquiries', 'general', 'team', 'play', 'courts', 'programs',
];

export function extractEmails(text, html) {
  const found = new Set();
  for (const src of [text, html]) {
    for (const m of String(src || '').match(EMAIL_RE) || []) {
      const e = m.toLowerCase().replace(/^mailto:/, '');
      if (EMAIL_JUNK.test(e)) continue;
      if (/^[0-9a-f]{16,}@/.test(e)) continue; // tracking hashes
      // Placeholder/vendor/no-reply addresses. Anchored to the domain so a real
      // facility whose name merely contains one of these words survives.
      if (/@(example|domain|yourdomain|email|sentry|sentry\.io|wixpress|godaddy|squarespace|wix)\./.test(e)) continue;
      if (/^(no-?reply|donotreply|postmaster|abuse|webmaster)@/.test(e)) continue;
      found.add(e);
    }
  }
  return [...found];
}

export function classifyEmails(emails, siteDomain) {
  const onDomain = emails.filter((e) => e.split('@')[1] === siteDomain);
  const pool = onDomain.length ? onDomain : emails;
  const isShared = (e) => SHARED_LOCALPARTS.includes(e.split('@')[0].replace(/[._-]/g, ' '));
  return {
    shared: pool.find(isShared) || '',
    direct: pool.filter((e) => !isShared(e)),
  };
}

// ---------------------------------------------------------------------------
// Decision makers
// ---------------------------------------------------------------------------

// Ordered strongest-first: the earlier a title matches, the better the contact.
const TITLES = [
  'Owner', 'Co-Owner', 'Founder', 'Co-Founder', 'President', 'CEO',
  'General Manager', 'Managing Director', 'Executive Director',
  'Director of Operations', 'Operations Director', 'Facility Manager',
  'Facilities Manager', 'Club Director', 'Athletic Director', 'Director of Racquets',
  'Director of Tennis', 'Director of Pickleball', 'Tennis Director',
  'Membership Director', 'Director of Membership', 'Program Director',
  'Sports Director', 'Head of Operations', 'Manager',
];

// Internal separator is a literal space run, never \s: allowing newlines lets a
// name swallow the first word of the next line ("Marcus Bell" + "Reach ...").
const NAME = '[A-Z][a-zA-Z\'’.-]+(?:[ ]+[A-Z][a-zA-Z\'’.-]+){0,2}';

// Words that signal a role or organization rather than a person, so a
// "Title\nTitle" adjacency cannot masquerade as "Name\nTitle".
const NOT_A_NAME = new RegExp(
  '\\b(director|manager|owner|founder|president|ceo|coo|cfo|chair|coach|staff|team|' +
    'operations|membership|athletic|tennis|pickleball|squash|racquet|program|general|' +
    'executive|managing|facility|facilities|club|head|assistant|associate|senior|' +
    'department|office|contact|email|phone|address|hours|home|about|our)\\b',
  'i',
);

/**
 * Look for "Name — Title" and "Title: Name" shapes near each other in the text.
 * Returns candidates ranked by title strength.
 */
export function extractPeople(text) {
  const out = [];
  const body = normalizeSeparators(text);
  for (let i = 0; i < TITLES.length; i++) {
    const t = TITLES[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Separators are normalized to ASCII '-' and ':' upstream, so these classes
    // stay simple and cannot be defeated by a mis-decoded dash.
    const patterns = [
      new RegExp(`(${NAME})[ ]*[,|-]{1,3}[ ]*${t}\\b`, 'g'),
      new RegExp(`${t}\\b[ ]*[:|-]{1,3}[ ]*(${NAME})`, 'g'),
      new RegExp(`(${NAME})\\s*\\n\\s*${t}\\b`, 'g'),
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(body)) !== null) {
        const name = m[1].trim().replace(/\s+/g, ' ');
        if (!/^[A-Z]/.test(name)) continue;
        const parts = name.split(' ').filter(Boolean);
        if (parts.length < 2) continue;
        if (parts.some((p) => p.length > 20)) continue;
        if (NOT_A_NAME.test(name)) continue;
        out.push({
          first: parts[0],
          last: parts[parts.length - 1],
          title: TITLES[i],
          rank: i,
        });
      }
    }
  }
  // Dedupe on first+last, keeping the strongest title.
  const best = new Map();
  for (const p of out.sort((a, b) => a.rank - b.rank)) {
    const k = `${p.first.toLowerCase()} ${p.last.toLowerCase()}`;
    if (!best.has(k)) best.set(k, p);
  }
  return [...best.values()].sort((a, b) => a.rank - b.rank);
}

// ---------------------------------------------------------------------------
// Indoor signals, sports, court counts
// ---------------------------------------------------------------------------

const INDOOR_RE = /\b(indoor|indoors|climate[-\s]?controlled|air[-\s]?conditioned courts?|under (?:one )?roof|domed?|bubble|field ?house|fieldhouse|inside courts?)\b/i;
const OUTDOOR_RE = /\b(outdoor|outdoors|open[-\s]air)\b/i;
const OUTDOOR_ONLY_RE = /\boutdoor[-\s]only\b/i;

export function detectIndoor(text) {
  const t = String(text || '');
  return {
    indoor: INDOOR_RE.test(t),
    outdoor: OUTDOOR_RE.test(t),
    outdoorOnly: OUTDOOR_ONLY_RE.test(t),
  };
}

export function detectSports(text) {
  const t = String(text || '').toLowerCase();
  return SPORTS.filter((s) => t.includes(s));
}

/**
 * Only returns a count when the page states one explicitly, and always returns
 * the sentence it came from so the count can be audited.
 */
export function detectCourtCount(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, sixteen: 16, twenty: 20,
  };
  const num = '(\\d{1,3}|' + Object.keys(WORDS).join('|') + ')';
  const sportAlt = SPORTS.join('|');
  const patterns = [
    new RegExp(`${num}\\s+(?:indoor\\s+)?(?:${sportAlt})\\s+courts?\\b`, 'i'),
    new RegExp(`${num}\\s+indoor\\s+courts?\\b`, 'i'),
    new RegExp(`${num}\\s+courts?\\b`, 'i'),
    new RegExp(`courts?\\s*[:–—-]\\s*${num}\\b`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (!m) continue;
    const raw = m[1].toLowerCase();
    const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : WORDS[raw];
    if (!n || n > 200) continue;
    const idx = Math.max(0, m.index - 90);
    return { count: n, note: t.slice(idx, m.index + m[0].length + 90).trim() };
  }
  return { count: '', note: '' };
}

// ---------------------------------------------------------------------------
// Exclusions and typing
// ---------------------------------------------------------------------------

const EXCLUDE_RE = [
  /\b(town|city|village|county) of\b/i,
  /\bparks? (and|&) rec(reation)?\b/i,
  /\bdepartment of parks\b/i,
  /\bmunicipal\b/i,
  /\bhomeowners?,? association\b/i,
  /\bHOA\b/,
  /\bapartment (homes|community|living)\b/i,
  /\bresidences?\b.*\bamenit/i,
  /\bpublic (park|courts?)\b/i,
  /\bfree (to the )?public\b/i,
];

export function looksExcluded(name, text) {
  const hay = `${name}\n${String(text || '').slice(0, 4000)}`;
  const hit = EXCLUDE_RE.find((r) => r.test(hay));
  return hit ? hit.source : '';
}

// Signals that the facility charges for something (membership, rental, etc.).
const MONETIZED_RE = /\b(member(ship)?s?|dues|join|rental|rent|reserve|booking|book a court|court time|rates?|pricing|fees?|tuition|league|clinic|lesson|program|drop[-\s]?in|day pass|punch card)\b/i;

export function looksMonetized(text) {
  return MONETIZED_RE.test(String(text || ''));
}

const TYPE_RULES = [
  [/\bsportsplex\b/i, 'Sportsplex'],
  [/\bfield ?house\b/i, 'Fieldhouse'],
  [/\bY\.?M\.?C\.?A\.?\b|\bYMCA\b|\bJCC\b|jewish community center/i, 'YMCA / JCC'],
  [/\bcountry club\b/i, 'Country Club'],
  [/\b(racquet|tennis) club\b/i, 'Racquet / Tennis Club'],
  [/\bpickleball (club|court|center|centre)\b/i, 'Pickleball Club'],
  [/\b(university|college)\b/i, 'College / University'],
  [/\b(high school|academy|prep school|school)\b/i, 'School'],
  [/\bathletic (club|center|centre|complex)\b/i, 'Athletic Center'],
  [/\bindoor sports?\b|\bsports (complex|center|centre)\b/i, 'Indoor Sports Complex'],
  [/\b(health|fitness) club\b|\bgym\b/i, 'Health Club'],
  [/\bclub\b/i, 'Private Club'],
];

// Tokens strong enough to type a facility from its name alone. Checked before
// the body-text rules so "Empire Racquet & Fitness Club" is a racquet club
// rather than a health club.
const NAME_RULES = [
  [/\bsportsplex\b/i, 'Sportsplex'],
  [/\bfield ?house\b/i, 'Fieldhouse'],
  [/\bY\.?M\.?C\.?A\.?\b|\bJCC\b/i, 'YMCA / JCC'],
  [/\bcountry club\b/i, 'Country Club'],
  [/\bpickleball\b/i, 'Pickleball Club'],
  [/\bracquet(ball)?\b|\btennis\b|\bsquash\b/i, 'Racquet / Tennis Club'],
  [/\b(university|college)\b/i, 'College / University'],
];

export function guessFacilityType(name, text) {
  const n = String(name || '');
  for (const [re, type] of NAME_RULES) if (re.test(n)) return type;
  const hay = `${n}\n${String(text || '').slice(0, 3000)}`;
  for (const [re, type] of TYPE_RULES) if (re.test(hay)) return type;
  return 'Unknown';
}

// ---------------------------------------------------------------------------
// City
// ---------------------------------------------------------------------------

// Matches "Rochester, NY 14620" / "Rochester, New York" in address blocks.
export function detectCity(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const re = /([A-Z][a-zA-Z.'’-]+(?:\s+[A-Z][a-zA-Z.'’-]+){0,3}),\s*(?:NY|New York)\b\s*(\d{5})?/g;
  const counts = new Map();
  let m;
  while ((m = re.exec(t)) !== null) {
    const city = m[1].trim();
    if (city.length < 3 || city.length > 40) continue;
    if (/\b(suite|street|road|avenue|drive|floor|box|route)\b/i.test(city)) continue;
    counts.set(city, (counts.get(city) || 0) + 1);
  }
  if (!counts.size) return '';
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export function guessTitleFromName(html) {
  const m = /<title[^>]*>([^<]{2,160})<\/title>/i.exec(String(html || ''));
  if (!m) return '';
  // Titles routinely read "Name | City NY" or "Name - Indoor Courts"; keep the
  // leading segment, and decode entities so "&amp;" does not reach the CSV.
  const cleaned = decodeEntities(normalizeSeparators(m[1]));
  return cleaned.split(/\s+[|-]\s+/)[0].trim() || cleaned;
}
