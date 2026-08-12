import { SPORTS } from './schema.js';
import { stateConfig } from './states.js';

// The crawl runs one state at a time, so the active state is module state
// rather than a parameter threaded through every extraction function.
let ACTIVE = null;
export function setActiveState(code) {
  ACTIVE = stateConfig(code);
  return ACTIVE;
}
function active() {
  return ACTIVE || stateConfig('NY');
}

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

// page.goto's own `timeout` only bounds navigation. Everything after it --
// evaluate(), content() -- has no timeout of its own, so a page that loads
// but then hangs (a stuck script, an unanswered dialog) blocks forever with
// no ceiling. A real case: whereorg.com wedged one worker for over an hour
// and stalled the entire North Carolina crawl, undetected because nothing
// ever threw -- the await just never returned. FETCH_TIMEOUT lets the caller
// recognize this specific failure mode and recover the page, since a
// Promise.race timeout does not cancel the underlying (still-running) call --
// the same page object may still be wedged afterward.
export const FETCH_TIMEOUT = 'FETCH_TIMEOUT';

export async function fetchPage(page, url, { timeout = 25000 } = {}) {
  let timer;
  const budget = timeout + 15000;
  try {
    return await Promise.race([
      fetchPageBody(page, url, timeout),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error(`${FETCH_TIMEOUT}: no response after ${budget}ms for ${url}`);
          e.code = FETCH_TIMEOUT;
          reject(e);
        }, budget);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPageBody(page, url, timeout) {
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

// Pages most likely to state indoor/outdoor explicitly. Used by the
// re-verification pass, which fetches more pages than the first crawl.
const DEEP_HINTS = [
  /facilit/i, /amenit/i, /courts?/i, /gym/i, /indoor/i, /our[-\s]?club/i,
  /faq/i, /hours/i, /visit/i, /about/i, /member/i, /rental/i, /play/i, /pricing/i,
  /tour/i, /location/i,
];

export function pickSubpages(links, baseHost, max = 6, deep = false) {
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
    const hints = deep ? DEEP_HINTS : SUBPAGE_HINTS;
    if (!hints.some((h) => h.test(hay))) continue;
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

// Small clubs legitimately publish a gmail/yahoo address as their contact, so
// free mail is accepted off-domain. Another *corporate* domain is not: an
// address like `reporter@usatoday.com` scraped off a syndicated article is
// someone else's contact, not this facility's.
export const FREE_MAIL_HOSTS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com',
  'msn.com', 'live.com', 'comcast.net', 'verizon.net', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'gmx.com', 'mail.com', 'optonline.net',
  'sbcglobal.net', 'roadrunner.com', 'rochester.rr.com', 'twc.com', 'earthlink.net',
]);

// Significant words in a facility's name and host, used to tell "our other
// domain" from "somebody else's domain".
function brandTokens(siteDomain, facilityName) {
  const out = new Set();
  const add = (s) =>
    String(s || '')
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 5 && !['tennis', 'sports', 'court', 'courts', 'clubs', 'center', 'centre'].includes(w))
      .forEach((w) => out.add(w));
  add(String(siteDomain).replace(/\.[a-z.]+$/, ''));
  add(facilityName);
  return out;
}

export function classifyEmails(emails, siteDomain, facilityName = '') {
  const apex = String(siteDomain || '').split('.').slice(-2).join('.');
  const tokens = brandTokens(siteDomain, facilityName);
  const belongs = (e) => {
    const d = e.split('@')[1] || '';
    if (!d) return false;
    if (d === siteDomain || d === apex || d.endsWith(`.${apex}`)) return true;
    if (FREE_MAIL_HOSTS.has(d)) return true;
    // A club that mails from a second domain of its own ("empireracquet.com"
    // for a site at "empire-racquet.com") still shares its brand words; an
    // unrelated newsroom domain shares none.
    const label = d.replace(/\.[a-z.]+$/, '').replace(/[^a-z]/g, '');
    return [...tokens].some((t) => label.includes(t));
  };
  const pool = emails.filter(belongs);
  const isShared = (e) => SHARED_LOCALPARTS.includes(e.split('@')[0].replace(/[._-]/g, ' '));
  // Prefer an address on the facility's own domain over a free-mail one.
  const rank = (e) => (FREE_MAIL_HOSTS.has(e.split('@')[1] || '') ? 1 : 0);
  const sorted = [...pool].sort((a, b) => rank(a) - rank(b));
  const shared = sorted.filter(isShared);
  return {
    // `shared` stays a single string for the one-row-per-facility CSV; the
    // full lists feed the per-contact verification file, where every reachable
    // address at a facility is worth having.
    shared: shared[0] || '',
    sharedAll: shared,
    direct: sorted.filter((e) => !isShared(e)),
  };
}

/**
 * Pair each named person with the published address that is most likely theirs.
 *
 * A local part is matched against the person's name rather than the reverse, so
 * `dwhitfield@`, `dana@` and `dana.whitfield@` all resolve to Dana Whitfield
 * while `info@` never does. An address is claimed by at most one person.
 */
export function matchEmailsToPeople(people, direct) {
  const taken = new Set();
  return people.map((p) => {
    const f = p.first.toLowerCase().replace(/[^a-z]/g, '');
    const l = p.last.toLowerCase().replace(/[^a-z]/g, '');
    const hit = direct.find((e) => {
      if (taken.has(e)) return false;
      const lp = e.split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
      if (!lp) return false;
      return (
        lp === f + l || lp === l + f || lp === f[0] + l || lp === f + l[0] ||
        (l.length >= 4 && lp.includes(l)) ||
        (f.length >= 4 && lp === f)
      );
    });
    if (hit) taken.add(hit);
    return { ...p, email: hit || '' };
  });
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
    'department|office|contact|email|phone|address|hours|home|about|our|' +
    // organization / place tokens: "Marlene Meyerson JCC Manhattan" must not
    // reduce to a person named "Meyerson Manhattan".
    'jcc|ymca|ywca|center|centre|complex|academy|school|college|university|' +
    'association|foundation|company|corp|inc|llc|group|holdings|partners|' +
    'manhattan|brooklyn|queens|bronx|staten|york|island|county|village|' +
    // Team and programme names read as "Name + Title" on athletics pages:
    // "Men's Basketball" is a squad, not a decision maker.
    'basketball|volleyball|football|soccer|hockey|baseball|softball|lacrosse|' +
    'track|field|swimming|diving|golf|wrestling|rowing|crew|athletics|' +
    'mens|womens|boys|girls|varsity|junior|senior|freshman)\\b',
  'i',
);

// Capitalized words that begin sentences or UI chrome. Without this, a line
// like "You Marina O." or "Contact Our Manager" parses as a person.
const NOT_A_FIRST_NAME = new Set(
  ('you your we our us the this that these those it its they their there here if when while ' +
    'please contact book join learn find get new all my his her now today welcome home about ' +
    'more read view call email sign log search menu skip open close free every each also ' +
    'whether both either any some most best top great first last next back play players ' +
    'meet with from into over under before after during since until because so and but or')
    .split(' '),
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
        if (NOT_A_FIRST_NAME.has(parts[0].toLowerCase())) continue;
        // A trailing initial ("Marina O.") means the real surname was not
        // captured; a one-letter surname is never usable for an email guess.
        const surname = parts[parts.length - 1].replace(/\.$/, '');
        if (surname.length < 2) continue;
        if (parts[0].replace(/\.$/, '').length < 2) continue;
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

// Indoor evidence. The second group was added for the re-verification pass over
// facilities whose sites never used the word "indoor": each term is unambiguous
// on its own -- a gymnasium is enclosed by definition, hardwood and sprung
// floors do not survive outdoors, and an air-supported structure is a dome.
// Deliberately excluded: "year-round play", which an outdoor Sun Belt facility
// can claim truthfully.
const INDOOR_RE =
  /\b(indoor|indoors|climate[-\s]?controlled|temperature[-\s]?controlled|air[-\s]?conditioned courts?|under (?:one )?roof|domed?|bubble|field ?house|fieldhouse|inside courts?|gymnasium|gymnasiums|hardwood courts?|sprung floors?|air[-\s]?supported|fully enclosed|rain or shine|regardless of (?:the )?weather|no matter the weather)\b/i;
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

// Storefronts that rank for court-sport queries (apparel brands, equipment
// retailers, lesson marketplaces) mention the sports but operate no courts.
// A facility with a small pro shop trips one or two of these; requiring three
// distinct cart signals keeps those facilities in.
const RETAIL_SIGNALS = [
  /\badd to cart\b/i, /\bfree shipping\b/i, /\bsize (chart|guide)\b/i,
  /\bshop now\b/i, /\byour cart\b/i, /\bsold out\b/i, /\bcheckout\b/i,
  /\bshopping bag\b/i, /\bshipping (and|&) returns\b/i, /\breturns? policy\b/i,
];

export function looksRetail(text) {
  const t = String(text || '');
  return RETAIL_SIGNALS.filter((r) => r.test(t)).length >= 3;
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

// Street-address vocabulary. The old parser took up to four capitalized words
// before ", NY", which turned "1 Harlem River Dr, Bronx, NY" into
// "Harlem River Bronx" and "...on Main St, NY" into "Main St".
const STREET_WORD =
  /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|pkwy|parkway|hwy|highway|route|rte|rt|pl|place|ct|court|ter|terrace|cir|circle|sq|square|tpke|turnpike|ext|suite|ste|floor|fl|unit|apt|box|po)\b\.?/i;

// Known New York places, used to pick the right token run out of an address
// line. Seeded from the discovery markets plus the boroughs and other common
// municipalities that show up in facility addresses.
const NY_PLACES = new Set(
  ('new york,manhattan,brooklyn,queens,bronx,staten island,yonkers,new rochelle,white plains,' +
    'mount vernon,scarsdale,mamaroneck,rye,port chester,ossining,peekskill,tarrytown,elmsford,' +
    'armonk,mount kisco,bedford,harrison,purchase,larchmont,hartsdale,greenburgh,dobbs ferry,' +
    'hastings on hudson,irvington,briarcliff manor,croton on hudson,cortlandt manor,yorktown heights,' +
    'hempstead,garden city,mineola,freeport,long beach,glen cove,great neck,manhasset,syosset,' +
    'plainview,hicksville,farmingdale,bethpage,massapequa,huntington,melville,commack,smithtown,' +
    'islandia,hauppauge,bay shore,islip,sayville,patchogue,bohemia,ronkonkoma,holbrook,medford,' +
    'riverhead,southampton,east hampton,bridgehampton,montauk,port jefferson,stony brook,' +
    'westbury,new hyde park,port washington,roslyn,jericho,woodbury,oceanside,rockville centre,' +
    'valley stream,lynbrook,merrick,wantagh,seaford,levittown,east meadow,uniondale,lindenhurst,' +
    'babylon,west babylon,deer park,brentwood,central islip,shirley,mastic,coram,selden,' +
    'centereach,setauket,east setauket,northport,kings park,sound beach,rocky point,wading river,' +
    'poughkeepsie,fishkill,beacon,newburgh,middletown,goshen,monroe,warwick,nyack,nanuet,' +
    'spring valley,suffern,new city,pearl river,kingston,new paltz,saugerties,hudson,catskill,' +
    'carmel,brewster,mahopac,wappingers falls,hyde park,rhinebeck,red hook,millbrook,pawling,' +
    'chester,florida,port jervis,ellenville,liberty,monticello,woodstock,highland,marlboro,' +
    'albany,schenectady,troy,saratoga springs,clifton park,latham,colonie,guilderland,delmar,' +
    'malta,glens falls,queensbury,amsterdam,gloversville,hudson falls,ballston spa,mechanicville,' +
    'cohoes,watervliet,rensselaer,east greenbush,niskayuna,scotia,rotterdam,johnstown,' +
    'syracuse,liverpool,cicero,baldwinsville,camillus,manlius,fayetteville,auburn,cortland,' +
    'oswego,fulton,utica,rome,new hartford,herkimer,oneida,hamilton,dewitt,east syracuse,' +
    'north syracuse,skaneateles,marcellus,clay,whitesboro,ilion,little falls,canastota,' +
    'binghamton,vestal,endicott,johnson city,ithaca,elmira,corning,horseheads,bath,olean,' +
    'jamestown,owego,sidney,oneonta,norwich,delhi,walton,hornell,painted post,lansing,' +
    'rochester,brighton,pittsford,penfield,webster,greece,henrietta,fairport,victor,' +
    'canandaigua,geneva,newark,batavia,brockport,geneseo,irondequoit,gates,chili,rush,' +
    'honeoye falls,spencerport,hilton,macedon,farmington,seneca falls,waterloo,avon,' +
    'buffalo,amherst,cheektowaga,tonawanda,west seneca,orchard park,hamburg,lancaster,' +
    'clarence,williamsville,niagara falls,lockport,lewiston,dunkirk,fredonia,depew,' +
    'east aurora,grand island,kenmore,north tonawanda,springville,alden,akron,elma,' +
    'watertown,plattsburgh,potsdam,canton,massena,ogdensburg,lake placid,saranac lake,' +
    'malone,gouverneur,carthage,lowville,ticonderoga,glenville,fort drum,clayton')
    .split(','),
);

/**
 * City from an address line ending in ", NY" / ", New York".
 *
 * Address lines are noisy ("1 Harlem River Dr, Bronx, NY 10453"), so the run of
 * words before the state is trimmed from the left until it looks like a place
 * name, and a run that matches a known New York municipality wins outright.
 */
export function detectCity(text) {
  const st = active();
  const places = st.places || NY_PLACES;
  const t = String(text || '').replace(/\s+/g, ' ');
  const re = new RegExp(`([A-Za-z][A-Za-z.'’\\- ]{2,60}?),\\s*${st.stateRe.source}\\b`, 'g');
  const counts = new Map();
  const known = new Map();
  let m;
  while ((m = re.exec(t)) !== null) {
    // Everything after the last comma is the city segment of the address.
    const seg = m[1].split(',').pop().trim();
    let parts = seg.split(/\s+/).filter(Boolean);
    // Drop leading street tokens and anything before them (house number, street
    // name), leaving the municipality.
    const lastStreet = parts.map((p) => STREET_WORD.test(p)).lastIndexOf(true);
    if (lastStreet > -1) parts = parts.slice(lastStreet + 1);
    if (!parts.length) continue;

    // "Sound Stage Yonkers" and "Harlem River Bronx" are venue names running
    // into the city, and "Our home is NYC" is prose. Prefer the longest
    // trailing run that is a real New York place; that alone resolves both.
    let hit = '';
    for (let n = Math.min(parts.length, 3); n >= 1; n--) {
      const tail = parts.slice(parts.length - n).join(' ');
      if (places.has(normalizeCity(tail).toLowerCase())) {
        hit = tail;
        break;
      }
    }
    if (!hit) {
      // Unrecognized place: accept it only if it already looks like a bare
      // city name — a short run of capitalized words.
      while (parts.length && !/^[A-Z][a-zA-Z.'’-]*$/.test(parts[0])) parts.shift();
      if (!parts.length || parts.length > 3) continue;
      if (!parts.every((p) => /^[A-Z][a-zA-Z.'’-]*$/.test(p))) continue;
    }
    const city = normalizeCity(hit || parts.join(' '));
    if (city.length < 3 || city.length > 28) continue;
    if (STREET_WORD.test(city)) continue;
    counts.set(city, (counts.get(city) || 0) + 1);
    if (places.has(city.toLowerCase())) known.set(city, (known.get(city) || 0) + 1);
  }
  const pick = (mp) => [...mp.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  // A recognized municipality beats a merely well-formed token run.
  return pick(known) || pick(counts);
}

// Sites write their city as "NYC", "BROOKLYN" or "Brooklyn"; the CSV should not
// carry three spellings of one place.
function normalizeCity(s) {
  const t = String(s || '').replace(/[.'’-]+$/, '').trim();
  if (/^(nyc|new york city|n\.?y\.?c\.?)$/i.test(t)) return 'New York';
  // Title-case anything shouted in caps, leave mixed case alone.
  if (t === t.toUpperCase()) {
    return t.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }
  return t;
}

// <title> segments that name a page rather than the business.
const GENERIC_TITLE = /^(public\s+)?(home|homepage|home page|welcome|index|main|start|untitled|official site|official website|site|page|page \d+|default)$/i;

/**
 * Facility name from page metadata.
 *
 * `og:site_name` is the business name by construction, so it is preferred.
 * Falling back to <title>, the leading segment is usually the name ("Sutton
 * East Tennis | NYC") but is sometimes a page label ("Home | Sutton East
 * Tennis"), so generic segments are skipped rather than returned.
 */
export function guessTitleFromName(html) {
  const h = String(html || '');
  const meta = (prop) => {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']{2,120})["']|` +
        `<meta[^>]+content=["']([^"']{2,120})["'][^>]*(?:property|name)=["']${prop}["']`,
      'i',
    );
    const m = re.exec(h);
    return m ? decodeEntities(normalizeSeparators(m[1] || m[2])) : '';
  };

  const site = meta('og:site_name');
  if (site && !GENERIC_TITLE.test(site)) return site.trim();

  const raw = /<title[^>]*>([^<]{2,160})<\/title>/i.exec(h)?.[1] || meta('og:title');
  if (!raw) return '';
  const cleaned = decodeEntities(normalizeSeparators(raw));
  const segments = cleaned.split(/\s+[|–—-]\s+/).map((s) => s.trim()).filter(Boolean);
  // First non-generic segment; a page labelled "Home | Sutton East Tennis"
  // should not be recorded as a facility called "Home".
  const named = segments.find((s) => !GENERIC_TITLE.test(s));
  // Every segment is a page label ("Home", "Welcome"): return nothing so the
  // caller falls back to the search-result title or the domain. A facility
  // called "Home" would otherwise be addressed that way in outreach.
  if (!named) return '';
  return named.trim();
}

/**
 * Every distinct New York street address on the site.
 *
 * An operator with branches publishes one address per location, and collapsing
 * them to a single row loses real, separately-contactable facilities. A bare
 * city mention is not enough ("serving Rochester, Pittsford and Webster" is
 * marketing copy, not three sites), so a full street address is required:
 * house number, street with a recognized suffix, city, `NY`, and usually a ZIP.
 */
const STREET_SUFFIX =
  '(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Pkwy|Parkway|Hwy|Highway|Rte|Route|Pl|Place|Ct|Court|Ter|Terrace|Cir|Circle|Sq|Square|Tpke|Turnpike|Broadway|Concourse)';

export function detectAddresses(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const re = new RegExp(
    `(\\d{1,6}[A-Za-z]?\\s+[A-Za-z0-9.'\`\\-\\s]{2,40}?${STREET_SUFFIX}\\.?)` + // street
      `(?:\\s*,?\\s*(?:Suite|Ste|Unit|Bldg|Building|Floor|Fl)\\.?\\s*[\\w-]+)?` + // optional unit
      `\\s*,\\s*([A-Z][A-Za-z.'\\-]*(?:\\s+[A-Z][A-Za-z.'\\-]*){0,2})` + // city
      `\\s*,\\s*${active().stateRe.source}\\b\\s*(\\d{5})?`, // state + optional zip
    'g',
  );
  const seen = new Map();
  let m;
  while ((m = re.exec(t)) !== null) {
    const street = m[1].replace(/\s+/g, ' ').trim();
    const city = normalizeCity(m[2].trim());
    const zip = m[3] || '';
    if (!city || city.length < 3 || city.length > 28) continue;
    if (STREET_WORD.test(city)) continue;
    if (street.length > 60) continue;
    // Key on street+zip so the same branch listed on several pages counts once,
    // while two branches in one city stay distinct.
    const key = `${street.toLowerCase()}|${zip}`;
    if (!seen.has(key)) seen.set(key, { street, city, zip });
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// New York relevance
// ---------------------------------------------------------------------------

// New York area codes, used as corroborating location evidence when a site
// shows a phone number but no postal address.
const NY_AREA_CODES = /\(?(212|315|332|347|516|518|585|607|631|646|680|716|718|838|845|914|917|929|934)\)?[)\s.-]{1,3}\d{3}[\s.-]?\d{4}/;

/**
 * Evidence that the facility is actually in New York.
 *
 * Search engines happily return a Minnesota chain for "indoor courts Buffalo
 * NY". Without this gate those rows land in a file titled NEW_YORK_..., which
 * is worse than omitting them.
 */
export function detectStateEvidence(text, code) {
  const st = code ? stateConfig(code) : active();
  const t = String(text || '').replace(/\s+/g, ' ');
  // A ZIP sitting right after the state token must belong to that state. Without
  // this, "Somewhere, CA 12345" reads as California on the strength of the two
  // letters alone, and an out-of-state facility slips into the list.
  const addr = new RegExp(`,\\s*${st.stateRe.source}\\b\\s*(\\d{5})?`, 'g');
  let am;
  while ((am = addr.exec(t)) !== null) {
    if (!am[1] || st.zipBare.test(am[1])) return 'address';
  }
  if (st.zipRe.test(t)) return 'zip';
  if (st.areaCodes.test(t)) return 'phone';
  if (st.mentionRe.test(t)) return 'mention';
  return '';
}

// Kept so existing New York callers and tests keep working unchanged.
export function detectNyEvidence(text) {
  return detectStateEvidence(text, 'NY');
}
