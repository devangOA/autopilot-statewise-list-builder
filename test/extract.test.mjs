// Exercises the extraction + classification pipeline against local fixture
// pages served over http, so the logic is verifiable without web egress.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  fetchPage, extractEmails, classifyEmails, extractPeople, detectIndoor,
  detectSports, detectCourtCount, looksExcluded, looksMonetized,
  guessFacilityType, detectCity, guessTitleFromName, pickSubpages,
  looksRetail, detectNyEvidence, detectAddresses, matchEmailsToPeople,
  detectPhone,
} from '../src/extract.js';
import { guessEmails } from '../src/emails.js';
import { qualify, isKeepable } from '../src/classify.js';
import { QUALIFICATION } from '../src/schema.js';
import { toCsv } from '../src/csv.js';
import { registrableDomain, isNonFacilityHost, isGovHost, unwrapRedirect, apexDomain } from '../src/search.js';
import { finalize, mailDomain, nameKey, looksLikePublisher, looksLikeNonFacilityOrg } from '../src/finalize.js';
import { nameIsConfirmed, candidatesFor, loadContactIndex } from '../src/reoon.js';
import { validateFallback, RETRIEVAL } from '../src/fallback.js';
import { N8N_COLUMNS, fitNotes, build as buildN8n, weakLocationEvidence, resolveCompanyName } from '../src/n8n.js';
import { setActiveState, detectStateEvidence } from '../src/extract.js';
import { stateConfig } from '../src/states.js';
import { buildQueries, CORE_TEMPLATES, TEMPLATES } from '../src/queries.js';
import { proxyConfig, preferHttps, BROWSER_GONE } from '../src/browser.js';

const dir = path.join(import.meta.dirname, 'fixtures');
const server = http.createServer((req, res) => {
  const f = path.join(dir, req.url === '/' ? 'club.html' : req.url.replace(/^\//, ''));
  if (!fs.existsSync(f)) return res.writeHead(404).end('nope');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
let pass = 0;
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`  ok  ${label}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${label}: ${e.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
};

// ---- indoor+outdoor club -------------------------------------------------
{
  const p = await fetchPage(page, `${base}/club.html`);
  const emails = extractEmails(p.text, p.html);
  const { shared, direct } = classifyEmails(emails, 'empireracquet.test');
  const people = extractPeople(p.text);
  const ind = detectIndoor(p.text);
  const v = qualify({
    ...ind,
    excludedBy: looksExcluded('Empire Racquet', p.text),
    monetized: looksMonetized(p.text),
    sports: detectSports(p.text),
  });
  const cc = detectCourtCount(p.text);

  console.log('club.html');
  await check('title parsed', () => assert.equal(guessTitleFromName(p.html), 'Empire Racquet & Fitness Club'));
  await check('shared email found', () => assert.equal(shared, 'info@empireracquet.test'));
  await check('direct email found', () => assert.ok(direct.includes('dwhitfield@empireracquet.test')));
  await check('GM ranked first', () => {
    assert.equal(people[0].title, 'General Manager');
    assert.equal(people[0].first, 'Dana');
    assert.equal(people[0].last, 'Whitfield');
  });
  await check('second person parsed', () =>
    assert.ok(people.some((x) => x.last === 'Bell' && x.title === 'Director of Operations')));
  await check('sports detected', () => {
    const s = detectSports(p.text);
    assert.ok(s.includes('tennis') && s.includes('pickleball'));
  });
  await check('indoor+outdoor qualification', () =>
    assert.equal(v.status, QUALIFICATION.INDOOR_AND_OUTDOOR));
  await check('court count from explicit statement', () => {
    assert.equal(cc.count, 8);
    assert.ok(cc.note.includes('indoor tennis courts'));
  });
  await check('city detected', () => assert.equal(detectCity(p.text), 'Rochester'));
  await check('type classified', () => assert.equal(guessFacilityType('Empire Racquet & Fitness Club', p.text), 'Racquet / Tennis Club'));
  await check('subpages picked', () => {
    const subs = pickSubpages(p.links, '127.0.0.1', 6);
    assert.ok(subs.length >= 3, `got ${subs.length}`);
  });
}

// ---- outdoor only -> excluded -------------------------------------------
{
  const p = await fetchPage(page, `${base}/outdoor.html`);
  const v = qualify({
    ...detectIndoor(p.text),
    excludedBy: looksExcluded('Lakeside Outdoor Tennis', p.text),
    monetized: looksMonetized(p.text),
    sports: detectSports(p.text),
  });
  console.log('outdoor.html');
  await check('outdoor-only excluded', () => assert.equal(v.status, QUALIFICATION.OUTDOOR_ONLY));
  await check('outdoor-only not keepable', () => assert.equal(isKeepable(v.status), false));
}

// ---- municipal parks -> not qualified ------------------------------------
{
  const p = await fetchPage(page, `${base}/park.html`);
  const v = qualify({
    ...detectIndoor(p.text),
    excludedBy: looksExcluded('Town of Greenview Parks and Recreation', p.text),
    monetized: looksMonetized(p.text),
    sports: detectSports(p.text),
  });
  console.log('park.html');
  await check('municipal parks excluded', () => assert.equal(v.status, QUALIFICATION.NOT_QUALIFIED));
  await check('exclusion reason recorded', () => assert.ok(v.reason.includes('Excluded category')));
}

// ---- pure-unit checks ----------------------------------------------------
console.log('units');
await check('six guessed patterns in order', () => {
  assert.deepEqual(guessEmails('Dana', "O'Whitfield", 'www.Empire.com'), [
    'dana@empire.com',
    'dana.owhitfield@empire.com',
    'danaowhitfield@empire.com',
    'downitfield@empire.com'.replace('downitfield', 'dowhitfield'),
    'd.owhitfield@empire.com',
    'danao@empire.com',
  ]);
});
await check('guesses empty without a name', () => assert.deepEqual(guessEmails('', 'X', 'a.com'), ['', '', '', '', '', '']));
await check('unclear indoor -> Needs Review', () =>
  assert.equal(
    qualify({ indoor: false, outdoor: false, outdoorOnly: false, excludedBy: '', monetized: true, sports: ['pickleball'] }).status,
    QUALIFICATION.NEEDS_REVIEW,
  ));
await check('missing court count does not disqualify', () => {
  const v = qualify({ indoor: true, outdoor: false, outdoorOnly: false, excludedBy: '', monetized: true, sports: ['tennis'] });
  assert.equal(v.status, QUALIFICATION.CONFIRMED_INDOOR);
  assert.equal(detectCourtCount('We have great courts for everyone.').count, '');
});
await check('aggregator + gov hosts rejected', () => {
  assert.ok(isNonFacilityHost('www.yelp.com'));
  assert.ok(isGovHost('parks.ny.gov'));
  assert.ok(!isNonFacilityHost('empireracquet.com'));
});
await check('registrable domain strips www', () =>
  assert.equal(registrableDomain('https://www.Empire.com/x?y=1'), 'empire.com'));
await check('mojibake dash still yields the person', async () => {
  const bad = 'Dana Whitfield ' + String.fromCodePoint(0xe2, 0x20ac, 0x201d) + ' General Manager';
  const ppl = extractPeople(bad);
  assert.equal(ppl[0].title, 'General Manager');
  assert.equal(ppl[0].last, 'Whitfield');
});
await check('entities decoded in facility name', () =>
  assert.equal(guessTitleFromName('<title>Empire Racquet &amp; Fitness Club | Rochester NY</title>'), 'Empire Racquet & Fitness Club'));
await check('non-OK document is a fetch failure, not empty content', async () => {
  // A proxy error page or a 404 must never be parsed as facility content.
  await assert.rejects(() => fetchPage(page, `${base}/does-not-exist.html`), /HTTP 404/);
});
await check('proxy disabled by escape hatch', () => {
  assert.equal(proxyConfig({ CRAWLER_DISABLE_PROXY: '1', HTTPS_PROXY: 'http://x:1' }), undefined);
  assert.equal(proxyConfig({ HTTPS_PROXY: 'http://x:1' }).server, 'http://x:1');
  assert.equal(proxyConfig({}), undefined);
});
await check('http upgraded to https', () => {
  assert.equal(preferHttps('http://a.com/x'), 'https://a.com/x');
  assert.equal(preferHttps('https://a.com/x'), 'https://a.com/x');
});
await check('csv quotes and neutralizes formulas', () => {
  const out = toCsv([{ A: 'x,y', B: '=CMD()', C: 'he said "hi"' }], ['A', 'B', 'C']);
  assert.equal(out.split('\n')[1], '"x,y",\'=CMD(),"he said ""hi"""');
});

// ---- search-engine redirect unwrapping -----------------------------------
await check('bing ck/a redirects decode to the real target', () => {
  // Bing hrefs are `.../ck/a?...&u=a1<base64url>&ntb=1`. Left wrapped, every
  // Bing result reads as bing.com and is dropped as a non-facility host, i.e.
  // Bing contributes nothing to discovery.
  const target = 'https://www.empireracquet.com/courts?a=1&b=2';
  const b64 = Buffer.from(target, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const wrapped = `https://www.bing.com/ck/a?!&&p=deadbeef&ptn=3&u=a1${b64}&ntb=1`;
  assert.equal(unwrapRedirect(wrapped), target);
  assert.equal(registrableDomain(unwrapRedirect(wrapped)), 'empireracquet.com');
  assert.ok(!isNonFacilityHost(registrableDomain(unwrapRedirect(wrapped))));
});
await check('undecodable and plain urls handled', () => {
  assert.equal(unwrapRedirect('https://www.bing.com/ck/a?u=a1notbase64!!'), '');
  assert.equal(unwrapRedirect('https://empireracquet.com/x'), 'https://empireracquet.com/x');
  assert.equal(unwrapRedirect(''), '');
  assert.equal(
    unwrapRedirect('https://duckduckgo.com/l/?uddg=' + encodeURIComponent('https://a.com/b')),
    'https://a.com/b',
  );
});

// ---- location + facility-name hardening ----------------------------------
await check('city survives a street address', () => {
  assert.equal(detectCity('Visit us at 1 Harlem River Dr, Bronx, NY 10453 today.'), 'Bronx');
  assert.equal(detectCity('Our club on Main St, NY is open.'), '');
  assert.equal(detectCity('1234 Monroe Ave, Rochester, NY 14618'), 'Rochester');
});
await check('known NY municipality beats a stray token run', () => {
  const t = 'Serving Greater Metro, NY area. Address: 5 Elm St, Pittsford, NY 14534. Greater Metro, NY.';
  assert.equal(detectCity(t), 'Pittsford');
  // A venue name running into the city keeps only the municipality.
  assert.equal(detectCity('Held at Sound Stage Yonkers, NY 10701'), 'Yonkers');
});
await check('city spellings normalized to one form', () => {
  assert.equal(detectCity('Courts in BROOKLYN, NY 11201'), 'Brooklyn');
  assert.equal(detectCity('Our home is NYC, NY 10001'), 'New York');
});
await check('generic <title> segments are not facility names', () => {
  assert.equal(guessTitleFromName('<title>Home | Sutton East Tennis</title>'), 'Sutton East Tennis');
  assert.equal(
    guessTitleFromName('<meta property="og:site_name" content="Court 16"><title>Welcome</title>'),
    'Court 16',
  );
});
await check('new york evidence gate', () => {
  assert.equal(detectNyEvidence('55 Court St, Brooklyn, NY 11201'), 'address');
  assert.equal(detectNyEvidence('Call us at (585) 555-0134'), 'phone');
  assert.equal(detectNyEvidence('1234 Lake St, Minneapolis, MN 55408 | (612) 555-0100'), '');
  // No location evidence disqualifies, so a Minnesota chain cannot land in a
  // New York deliverable.
  assert.equal(
    qualify({ indoor: true, outdoor: false, outdoorOnly: false, excludedBy: '', monetized: true, sports: ['tennis'], nyEvidence: '' }).status,
    QUALIFICATION.NOT_QUALIFIED,
  );
});
await check('online stores are not facilities', () => {
  assert.ok(looksRetail('Add to cart. Free shipping over $50. Size chart. Your cart is empty.'));
  // A facility with a small pro shop trips at most one or two signals.
  assert.ok(!looksRetail('Book a court. Pro shop: add to cart for restringing.'));
  assert.equal(
    qualify({ indoor: true, outdoor: false, outdoorOnly: false, excludedBy: '', monetized: true, sports: ['pickleball'], retail: true, nyEvidence: 'address' }).status,
    QUALIFICATION.NOT_QUALIFIED,
  );
});
await check('sentence starters and org tokens are not people', () => {
  assert.deepEqual(extractPeople('You Marina O.\nManager'), []);
  assert.deepEqual(extractPeople('Marlene Meyerson JCC Manhattan\nCEO'), []);
  assert.deepEqual(extractPeople('Contact Our Manager'), []);
  // A real "Name\nTitle" pair still parses.
  assert.equal(extractPeople('Dana Whitfield\nGeneral Manager')[0].last, 'Whitfield');
});

// ---- dedup + mail-domain normalization -----------------------------------
await check('apex domain drops vanity subdomains only', () => {
  assert.equal(apexDomain('https://book.412squash.org/x'), '412squash.org');
  assert.equal(apexDomain('ir.lifetime.life'), 'lifetime.life');
  assert.equal(apexDomain('www.empireracquet.com'), 'empireracquet.com');
  // Unrelated businesses that merely share a host must stay separate: these
  // are different facilities, not one facility reached two ways.
  assert.equal(apexDomain('drumlins.syracuse.edu'), 'drumlins.syracuse.edu');
  assert.equal(apexDomain('rochesterclub.squarespace.com'), 'rochesterclub.squarespace.com');
  assert.notEqual(apexDomain('clubA.ezfacility.com'), apexDomain('clubB.ezfacility.com'));
  // The brand label itself is never peeled, even when it looks like plumbing.
  assert.equal(apexDomain('shop.com'), 'shop.com');
  assert.equal(apexDomain('www.play.com'), 'play.com');
});
await check('mail domain prefers a published address, never free mail', () => {
  assert.equal(mailDomain({ 'Shared Facility Email': 'info@empireracquet.com', 'Email Domain': 'book.empireracquet.com' }), 'empireracquet.com');
  // A gmail contact must not become the base for pattern guessing.
  assert.equal(mailDomain({ 'Shared Facility Email': 'club@gmail.com', 'Email Domain': 'empireracquet.com' }), 'empireracquet.com');
  assert.equal(mailDomain({ 'Email Domain': 'gmail.com' }), '');
});
await check('guesses are regenerated against the real mail domain', () => {
  const [row] = finalize([{
    'Facility Name': 'Empire Racquet', City: 'Rochester', Website: 'https://book.empireracquet.com',
    'Email Domain': 'book.empireracquet.com', 'Qualification Status': QUALIFICATION.CONFIRMED_INDOOR,
    'Decision Maker First Name': 'Dana', 'Decision Maker Last Name': 'Whitfield',
    'Public Direct Email': '', 'Shared Facility Email': 'info@empireracquet.com', 'Research Notes': 'x',
  }]);
  assert.equal(row['Email Domain'], 'empireracquet.com');
  assert.equal(row['Guessed Email 1'], 'dana@empireracquet.com');
  assert.equal(row['Guessed Email 4'], 'dwhitfield@empireracquet.com');
  assert.match(row['Research Notes'], /UNVERIFIED/);
});
await check('no guesses when a direct address is published', () => {
  const [row] = finalize([{
    'Facility Name': 'Empire Racquet', Website: 'https://empireracquet.com', 'Email Domain': 'empireracquet.com',
    'Qualification Status': QUALIFICATION.CONFIRMED_INDOOR,
    'Decision Maker First Name': 'Dana', 'Decision Maker Last Name': 'Whitfield',
    'Public Direct Email': 'dwhitfield@empireracquet.com', 'Research Notes': 'x',
  }]);
  assert.equal(row['Guessed Email 1'], '');
  assert.ok(!/UNVERIFIED/.test(row['Research Notes']));
});
await check('duplicate facilities collapse to the richer row', () => {
  const rows = finalize([
    { 'Facility Name': 'Empire Racquet Club', City: 'Rochester', Website: 'https://book.empireracquet.com',
      'Email Domain': 'book.empireracquet.com', 'Qualification Status': QUALIFICATION.CONFIRMED_INDOOR, 'Research Notes': '' },
    { 'Facility Name': 'Empire Racquet Club', City: 'Rochester', Website: 'https://empireracquet.com',
      'Email Domain': 'empireracquet.com', 'Qualification Status': QUALIFICATION.CONFIRMED_INDOOR,
      'Decision Maker First Name': 'Dana', 'Decision Maker Last Name': 'Whitfield',
      'Public Direct Email': 'dana@empireracquet.com', 'Research Notes': '' },
    // Same club reached through an unrelated domain.
    { 'Facility Name': 'The Empire Racquet Club, Inc.', City: 'Rochester', Website: 'https://empire-racquet.net',
      'Email Domain': 'empire-racquet.net', 'Qualification Status': QUALIFICATION.CONFIRMED_INDOOR, 'Research Notes': '' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['Public Direct Email'], 'dana@empireracquet.com');
  assert.equal(nameKey('The Empire Racquet Club, Inc.'), nameKey('Empire Racquet Club'));
});
await check('distinct facilities are not merged', () => {
  const rows = finalize([
    { 'Facility Name': 'Sutton East Tennis', City: 'New York', Website: 'https://a.com', 'Email Domain': 'a.com', 'Qualification Status': QUALIFICATION.CONFIRMED_INDOOR, 'Research Notes': '' },
    { 'Facility Name': 'Vanderbilt Tennis', City: 'New York', Website: 'https://b.com', 'Email Domain': 'b.com', 'Qualification Status': QUALIFICATION.CONFIRMED_INDOOR, 'Research Notes': '' },
  ]);
  assert.equal(rows.length, 2);
});

await check('third-party emails are not facility contacts', () => {
  // A syndicated article leaves a reporter's address on the page.
  const [row] = finalize([{
    'Facility Name': 'Some Club', Website: 'https://aolclub.com', 'Email Domain': 'aolclub.com',
    'Qualification Status': QUALIFICATION.CONFIRMED_INDOOR,
    'Public Direct Email': 'zschermele@usatoday.com', 'Shared Facility Email': 'info@aolclub.com',
    'Research Notes': '',
  }]);
  assert.equal(row['Public Direct Email'], '');
  assert.equal(row['Shared Facility Email'], 'info@aolclub.com');
  assert.match(row['Research Notes'], /Third-party email removed/);
});
await check('free mail and subdomains are kept as facility contacts', () => {
  const [row] = finalize([{
    'Facility Name': 'A-Game Sports', Website: 'https://agame.com', 'Email Domain': 'agame.com',
    'Qualification Status': QUALIFICATION.CONFIRMED_INDOOR,
    'Public Direct Email': 'nicolegoodrich5@gmail.com', 'Research Notes': '',
  }]);
  assert.equal(row['Public Direct Email'], 'nicolegoodrich5@gmail.com');
});
await check('publishers are not facilities', () => {
  assert.ok(looksLikePublisher({ 'Facility Name': '914INC.', 'Email Domain': 'westchestermagazine.com' }));
  assert.ok(looksLikePublisher({ 'Facility Name': 'AOL.com', 'Email Domain': 'aol.com' }));
  // Real venues whose names contain publisher-ish words must survive.
  assert.ok(!looksLikePublisher({ 'Facility Name': 'The Post BK', 'Email Domain': 'thepostbk.com' }));
  assert.ok(!looksLikePublisher({ 'Facility Name': 'Sportime NY', 'Email Domain': 'sportimeny.com' }));
});
await check('on-domain emails outrank free mail', () => {
  const { shared, direct } = classifyEmails(
    ['owner@gmail.com', 'dana@empireracquet.test', 'info@empireracquet.test', 'reporter@usatoday.com'],
    'empireracquet.test',
  );
  assert.equal(shared, 'info@empireracquet.test');
  assert.equal(direct[0], 'dana@empireracquet.test');
  // Another company's domain is never this facility's contact.
  assert.ok(!direct.includes('reporter@usatoday.com'));
  assert.ok(direct.includes('owner@gmail.com'));
});

// ---- multi-branch operators + multiple contacts --------------------------
await check('branch addresses are found, marketing copy is not', () => {
  const t = 'Syosset: 75 Haskett Drive, Syosset, NY 11791. Kings Park: 275 Old Indian Head Rd, ' +
            'Kings Park, NY 11754. Also serving Rochester, Pittsford and Webster. ' +
            'Call the desk at 75 Haskett Drive, Syosset, NY 11791.';
  const a = detectAddresses(t);
  // Two real branches; the repeated Syosset listing collapses, and the bare
  // city mentions are not treated as locations.
  assert.equal(a.length, 2);
  assert.deepEqual(a.map((x) => x.city).sort(), ['Kings Park', 'Syosset']);
  assert.equal(detectAddresses('We serve Rochester, NY and Buffalo, NY players.').length, 0);
});
await check('every contactable person is kept, each with their own address', () => {
  const people = [
    { first: 'Dana', last: 'Whitfield', title: 'General Manager' },
    { first: 'Marcus', last: 'Bell', title: 'Director of Operations' },
    { first: 'Ana', last: 'Reyes', title: 'Membership Director' },
  ];
  const matched = matchEmailsToPeople(people, ['dwhitfield@x.com', 'marcus.bell@x.com', 'info@x.com']);
  assert.equal(matched.length, 3);
  assert.equal(matched[0].email, 'dwhitfield@x.com');
  assert.equal(matched[1].email, 'marcus.bell@x.com');
  // No address matches Ana, so she gets none rather than someone else's.
  assert.equal(matched[2].email, '');
});
await check('an address is claimed by only one person', () => {
  const m = matchEmailsToPeople(
    [{ first: 'Dana', last: 'Bell', title: 'Owner' }, { first: 'Marcus', last: 'Bell', title: 'Manager' }],
    ['bell@x.com'],
  );
  assert.equal(m[0].email, 'bell@x.com');
  assert.equal(m[1].email, '');
});

// ---- verification-input contact rules ------------------------------------
await check('honorifics and squad names are not decision makers', () => {
  // "Dr. Riley" is a title plus a surname; anchoring first@ on it would emit
  // dr@theirdomain.com and present it as a person's address.
  assert.ok(!nameIsConfirmed('Dr.', 'Riley'));
  assert.ok(!nameIsConfirmed('Prof', 'Smith'));
  // Athletics pages list squads in the same "Name, Title" shape as people.
  assert.ok(!nameIsConfirmed("Women's", 'Basketball'));
  assert.ok(!nameIsConfirmed('Community', 'Engagement'));
  // Real names, including one that merely contains "men", still pass.
  assert.ok(nameIsConfirmed('Dana', 'Whitfield'));
  assert.ok(nameIsConfirmed('Roe', 'Hemenway'));
});
await check('published addresses are kept and guesses are not invented', () => {
  const master = {
    'Email Domain': 'empireracquet.com',
    'Decision Maker First Name': 'Dana', 'Decision Maker Last Name': 'Whitfield',
    'Public Direct Email': '', 'Shared Facility Email': 'info@empireracquet.com',
  };
  // Two people: one with a published address, one without.
  const extra = {
    _people: [
      { first: 'Dana', last: 'Whitfield', title: 'GM', email: 'dwhitfield@empireracquet.com' },
      { first: 'Marcus', last: 'Bell', title: 'Ops', email: '' },
    ],
    _directEmails: ['dwhitfield@empireracquet.com'],
    _sharedEmails: ['info@empireracquet.com'],
  };
  const c = candidatesFor(master, extra);
  const types = c.map((x) => x.type);
  // Dana keeps her published address and gets no guesses; Marcus gets exactly
  // six; the shared inbox survives alongside both.
  assert.equal(types.filter((t) => t === 'Published Direct').length, 1);
  assert.equal(types.filter((t) => t.startsWith('Guessed')).length, 6);
  assert.equal(types.filter((t) => t === 'Published Shared').length, 1);
  assert.ok(c.filter((x) => x.type.startsWith('Guessed')).every((x) => x.person.last === 'Bell'));
});
await check('a staff roster cannot flood the verification file', () => {
  // A university athletics page publishes dozens of addresses tied to nobody.
  const many = Array.from({ length: 40 }, (_, i) => `person${i}@uni.edu`);
  const c = candidatesFor(
    { 'Email Domain': 'uni.edu' },
    { _people: [], _directEmails: many, _sharedEmails: [] },
  );
  assert.ok(c.length <= 6, `expected the cap to hold, got ${c.length}`);
});

// ---- Scrapling fallback safety guards ------------------------------------
const FACILITY_PAGE = 'Welcome to our indoor pickleball club. 6 indoor courts, membership and court booking available.';

await check('fallback accepts a genuine same-domain facility page', () => {
  const v = validateFallback({
    requestedUrl: 'https://bgcsyracuse.org/',
    finalUrl: 'https://bgcsyracuse.org/',
    text: FACILITY_PAGE,
  });
  assert.ok(v.ok, v.reason);
});
await check('fallback rejects an off-domain redirect', () => {
  // A 200 is not enough: the content belongs to somebody else.
  const v = validateFallback({
    requestedUrl: 'https://joespickleball.com/',
    finalUrl: 'https://audiomentoring.com/',
    text: FACILITY_PAGE,
  });
  assert.ok(!v.ok);
  assert.match(v.reason, /off-domain/);
});
await check('fallback rejects a hijacked/parked domain', () => {
  // The real case: joespickleball.com now serves an Indonesian gambling portal,
  // which Playwright refused and Scrapling returned as HTTP 200.
  const v = validateFallback({
    requestedUrl: 'https://joespickleball.com/',
    finalUrl: 'https://joespickleball.com/',
    text: 'PAKDE4D: Portal Bandar Toto Online Resmi dengan Link Login. Slot gacor. pickleball courts',
  });
  assert.ok(!v.ok);
  assert.match(v.reason, /parked|hijack|unrelated/i);
  // Domain-for-sale pages are caught too.
  assert.ok(!validateFallback({
    requestedUrl: 'https://x.com/', finalUrl: 'https://x.com/',
    text: 'This domain is for sale. Buy this domain. tennis courts',
  }).ok);
});
await check('fallback rejects a page with no court-sport evidence', () => {
  const v = validateFallback({
    requestedUrl: 'https://example.org/', finalUrl: 'https://example.org/',
    text: 'We sell industrial fasteners and hardware to contractors nationwide.',
  });
  assert.ok(!v.ok);
  assert.match(v.reason, /no court sport/i);
});
await check('fallback rejects an empty document', () => {
  assert.ok(!validateFallback({ requestedUrl: 'https://a.com/', finalUrl: 'https://a.com/', text: '   ' }).ok);
});
await check('fallback tolerates www and vanity subdomain differences', () => {
  // Same facility, not an off-domain redirect.
  assert.ok(validateFallback({
    requestedUrl: 'https://bgcsyracuse.org/',
    finalUrl: 'https://www.bgcsyracuse.org/contact/',
    text: FACILITY_PAGE,
  }).ok);
});
await check('retrieval method labels are the agreed three', () => {
  assert.deepEqual(
    [RETRIEVAL.PLAYWRIGHT, RETRIEVAL.FETCHER, RETRIEVAL.STEALTH],
    ['Playwright', 'Scrapling Fetcher', 'Scrapling Stealth'],
  );
});

// ---- multi-state support --------------------------------------------------
await check('california location gate accepts CA and rejects other states', () => {
  setActiveState('CA');
  assert.equal(detectStateEvidence('1234 Ocean Ave, Santa Monica, CA 90401'), 'address');
  assert.equal(detectStateEvidence('Call us at (415) 555-0134'), 'phone');
  // A New York facility must not qualify for the California list.
  assert.equal(detectStateEvidence('55 Court St, Brooklyn, NY 11201'), '');
  // ZIPs outside 90000-96199 are not California.
  assert.equal(detectStateEvidence('Somewhere, CA 12345'), '');
});
await check('california city and branch parsing', () => {
  setActiveState('CA');
  assert.equal(detectCity('Located at 1234 Ocean Ave, Santa Monica, CA 90401'), 'Santa Monica');
  const b = detectAddresses('A: 100 Main St, Irvine, CA 92618. B: 200 Elm Ave, Fresno, CA 93701');
  assert.equal(b.length, 2);
  assert.deepEqual(b.map((x) => x.city).sort(), ['Fresno', 'Irvine']);
});
await check('switching state back leaves New York behaviour intact', () => {
  setActiveState('NY');
  assert.equal(detectStateEvidence('55 Court St, Brooklyn, NY 11201'), 'address');
  assert.equal(detectCity('1234 Monroe Ave, Rochester, NY 14618'), 'Rochester');
  assert.equal(detectStateEvidence('1234 Ocean Ave, Santa Monica, CA 90401'), '');
});
await check('state config exposes markets, gov patterns and statewide queries', () => {
  const ca = stateConfig('CA');
  assert.ok(ca.markets.length > 200, `expected broad CA coverage, got ${ca.markets.length}`);
  assert.ok(ca.statewide.length >= 10);
  assert.ok(ca.gov.some((r) => r.test('parks.ca.us')));
  assert.throws(() => stateConfig('ZZ'), /Unknown state/);
});

// ---- n8n output contract --------------------------------------------------
await check('n8n columns match the reference file exactly, in order', () => {
  const ref = fs.readFileSync(path.join(import.meta.dirname, '..', 'N8N_INDOOR_COURTS_5_ROW_REFERENCE.csv'), 'utf8');
  const header = ref.split('\n')[0].replace(/^﻿/, '').split(',').map((c) => c.trim());
  assert.deepEqual(N8N_COLUMNS, header);
  assert.equal(N8N_COLUMNS.length, 17);
});
await check('n8n rows follow the reference row behaviour', () => {
  const master = [{
    'Facility Name': 'Empire Racquet', Website: 'https://empireracquet.com/', City: 'Irvine', State: 'CA',
    'Facility Type': 'Racquet / Tennis Club', 'Sports Offered': 'tennis; pickleball',
    'Indoor Court Status': 'Indoor', 'Number of Courts': '8',
    'Qualification Status': QUALIFICATION.CONFIRMED_INDOOR, 'Email Domain': 'empireracquet.com',
    'Source URLs': 'https://empireracquet.com/', 'Research Notes': '',
    'Decision Maker First Name': 'Dana', 'Decision Maker Last Name': 'Whitfield', 'Decision Maker Title': 'GM',
    'Public Direct Email': '', 'Shared Facility Email': 'info@empireracquet.com',
  }];
  const contacts = new Map([['empireracquet.com', {
    Website: 'https://empireracquet.com/',
    _people: [
      { first: 'Dana', last: 'Whitfield', title: 'General Manager', email: 'dwhitfield@empireracquet.com' },
      { first: 'Marcus', last: 'Bell', title: 'Director of Operations', email: '' },
    ],
    _directEmails: ['dwhitfield@empireracquet.com'],
    _sharedEmails: ['info@empireracquet.com'],
    _locations: [{ street: '1 A St', city: 'Irvine', zip: '92618' }],
  }]]);
  const { rows } = buildN8n(master, contacts, { state: 'CA' });

  // Dana: published direct -> Contact Email set, Work Email blank.
  const dana = rows.find((r) => r['Contact Name'] === 'Dana Whitfield');
  assert.equal(dana['Contact Email'], 'dwhitfield@empireracquet.com');
  assert.equal(dana['Work Email'], '');
  assert.equal(dana['Final Email'], dana['Contact Email']);
  assert.equal(dana['Email Source'], 'Published Direct');

  // Marcus has no published address -> exactly six guessed rows, kept separate
  // from Dana's row.
  const marcus = rows.filter((r) => r['Contact Name'] === 'Marcus Bell');
  assert.equal(marcus.length, 6);
  assert.deepEqual(marcus.map((r) => r['Email Source']).sort(),
    ['Guessed Pattern 1','Guessed Pattern 2','Guessed Pattern 3','Guessed Pattern 4','Guessed Pattern 5','Guessed Pattern 6']);
  assert.ok(marcus.every((r) => /GUESSED PATTERN/.test(r['Fit Notes'])));

  // Generic inbox survives alongside the named contacts, as a Team row.
  const team = rows.find((r) => r['Contact Name'] === 'Team');
  assert.equal(team['Contact Title'], 'Facility Team');
  assert.equal(team['Contact Email'], '');
  assert.equal(team['Work Email'], 'info@empireracquet.com');
  assert.equal(team['Final Email'], 'info@empireracquet.com');
  assert.match(team['Fit Notes'], /Hey team,/);

  // Never invented, and never more than one address in a cell.
  assert.ok(rows.every((r) => r['Contact LinkedIn'] === '' && r['Phone'] === ''));
  assert.ok(rows.every((r) => !/[,;\s]/.test(r['Final Email'])));
  assert.equal(new Set(rows.map((r) => r['Final Email'])).size, rows.length);
  assert.ok(rows.every((r) => r['Track ID'] === 'CA-COURTS-001'));
});
await check('needs-review facilities never reach the n8n csv', () => {
  const master = [{
    'Facility Name': 'Unclear Club', Website: 'https://unclear.com/', City: 'Fresno', State: 'CA',
    'Qualification Status': QUALIFICATION.NEEDS_REVIEW, 'Email Domain': 'unclear.com',
    'Shared Facility Email': 'info@unclear.com', 'Research Notes': '', 'Source URLs': 'https://unclear.com/',
  }];
  const { rows, reviewRows } = buildN8n(master, new Map(), { state: 'CA' });
  assert.equal(rows.length, 0);
  assert.equal(reviewRows.length, 1);
});
await check('fit notes state only sourced facts', () => {
  const notes = fitNotes({
    facility: { 'Facility Name': 'X Club', 'Facility Type': 'Pickleball Club', City: 'Irvine',
                'Indoor Court Status': 'Indoor', 'Sports Offered': 'pickleball', 'Number of Courts': '',
                'Qualification Status': 'Confirmed Indoor', 'Source URLs': 'https://x.com/' },
    person: null, kind: 'generic', state: 'CA', branches: [],
  });
  // No court count was sourced, so none is claimed.
  assert.ok(!/court count/i.test(notes));
  assert.match(notes, /Hey team,/);
  assert.match(notes, /Sources: https:\/\/x\.com\//);
});

await check('query tiering keeps coverage while cutting volume', () => {
  const markets = ['Big City CA', 'Small Town CA'];
  const tiered = buildQueries({ markets, majorMarkets: ['Big City CA'], statewide: [] });
  // Every market is still queried - tiering reduces angles, never coverage.
  assert.ok(tiered.some((q) => q.includes('Small Town CA')));
  assert.equal(tiered.filter((q) => q.includes('Big City CA')).length, TEMPLATES.length);
  assert.equal(tiered.filter((q) => q.includes('Small Town CA')).length, CORE_TEMPLATES.length);
  // Without a major-market list the behaviour is unchanged.
  const flat = buildQueries({ markets, statewide: [] });
  assert.equal(flat.length, markets.length * TEMPLATES.length);
});

await check('browser-gone detection distinguishes a kill from a bad site', () => {
  // This constant went missing from the orchestrator once and killed a crawl on
  // its first failure; `node --check` cannot catch an undefined identifier, so
  // it is asserted here instead.
  assert.ok(BROWSER_GONE instanceof RegExp);
  for (const m of [
    'page.goto: Target page, context or browser has been closed',
    'Browser has been closed',
    'Protocol error (Page.navigate): Connection closed',
  ]) assert.ok(BROWSER_GONE.test(m), `should be treated as a kill: ${m}`);
  // Site-specific failures must NOT be mistaken for a dead browser, or the
  // crawler would abandon the queue every time one site 403s.
  for (const m of [
    'HTTP 403 for https://x.com',
    'page.goto: net::ERR_CERT_COMMON_NAME_INVALID',
    'page.goto: Timeout 25000ms exceeded.',
    'page.goto: net::ERR_NAME_NOT_RESOLVED',
  ]) assert.ok(!BROWSER_GONE.test(m), `should be treated as a site failure: ${m}`);
});

await check('organizations that operate no courts are excluded', () => {
  // Each of these was a real qualified row before the filter existed.
  for (const [name, domain] of [
    ['Livermore Valley Chamber of Commerce', 'business.livermorechamber.org'],
    ['Visit Anaheim, CA', 'visitanaheim.org'],
    ['Marin County Convention and Visitors Bureau', 'visitmarin.org'],
    ['Placer Valley Tourism', 'placertourism.com'],
    ['Four Seasons Hotels and Resorts', 'fourseasons.com'],
    ['Madeline Schaider Real Estate', 'livinginmarin.com'],
    // Generated directory network; its own pages say "Add Your Club".
    ['Alhambra Pickleball', 'pickleballalhambra.com'],
  ]) assert.ok(looksLikeNonFacilityOrg({ 'Facility Name': name, 'Email Domain': domain }), `${name} should be excluded`);

  // Real facilities must survive, including a member club whose domain starts
  // with "pickleball".
  for (const [name, domain] of [
    ['Pickleball Club Sonoma Valley', 'pickleballclubsonomavalley.org'],
    ['Bay Club', 'bayclubs.com'],
    ['LA Tennis Club', 'latennisclub.com'],
  ]) assert.ok(!looksLikeNonFacilityOrg({ 'Facility Name': name, 'Email Domain': domain }), `${name} should be kept`);
});

await check('FL and TN state configs gate correctly', () => {
  for (const st of ['FL', 'TN']) {
    const c = stateConfig(st);
    assert.ok(c.markets.length > 50, `${st} needs broad market coverage`);
    assert.ok(c.places.size > 100);
    assert.ok(c.gov.some((r) => r.test(`parks.${st.toLowerCase()}.us`)));
  }
  setActiveState('FL');
  assert.equal(detectStateEvidence('123 Ocean Dr, Naples, FL 34102'), 'address');
  assert.equal(detectStateEvidence('(239) 555-0100'), 'phone');
  // Another state's address must never qualify a Florida facility.
  assert.equal(detectStateEvidence('1 A St, Irvine, CA 92618'), '');
  // 12345 is not a Florida ZIP, so the two letters alone are not enough.
  assert.equal(detectStateEvidence('Somewhere, FL 12345'), '');
  assert.equal(detectCity('123 Ocean Dr, Naples, FL 34102'), 'Naples');

  setActiveState('TN');
  assert.equal(detectStateEvidence('55 Broadway, Nashville, TN 37203'), 'address');
  assert.equal(detectCity('55 Broadway, Nashville, TN 37203'), 'Nashville');
  const b = detectAddresses('A: 100 Main St, Franklin, TN 37064. B: 200 Elm Ave, Knoxville, TN 37902');
  assert.deepEqual(b.map((x) => x.city).sort(), ['Franklin', 'Knoxville']);

  // Switching away must not leave state bleeding into the next run.
  setActiveState('NY');
  assert.equal(detectStateEvidence('55 Court St, Brooklyn, NY 11201'), 'address');
  assert.equal(detectStateEvidence('123 Ocean Dr, Naples, FL 34102'), '');
});
await check('non-facility filtering happens in the candidate file, not the master', () => {
  // A developer-supplied master must be usable byte-identical while the
  // outreach file still drops organizations that operate no courts.
  const master = [
    { 'Facility Name': 'Real Club', Website: 'https://realclub.com/', City: 'Naples', State: 'FL',
      'Facility Type': 'Racquet / Tennis Club', 'Sports Offered': 'tennis', 'Indoor Court Status': 'Indoor',
      'Qualification Status': QUALIFICATION.CONFIRMED_INDOOR, 'Email Domain': 'realclub.com',
      'Shared Facility Email': 'info@realclub.com', 'Source URLs': 'https://realclub.com/', 'Research Notes': '' },
    { 'Facility Name': 'Visit Anaheim', Website: 'https://visitanaheim.org/', City: 'Naples', State: 'FL',
      'Qualification Status': QUALIFICATION.CONFIRMED_INDOOR, 'Email Domain': 'visitanaheim.org',
      'Shared Facility Email': 'info@visitanaheim.org', 'Source URLs': 'https://visitanaheim.org/', 'Research Notes': '' },
  ];
  const { rows, excluded } = buildN8n(master, new Map(), { state: 'FL', trackId: 'FL-COURTS-001' });
  assert.equal(excluded.length, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['Company Name'], 'Real Club');
});

await check('a bare state mention is not proof of location', () => {
  // Kalamazoo Country Club (Michigan) qualified for Texas because its page
  // mentioned "Texas"; no address was found, so no city was parsed either.
  assert.ok(weakLocationEvidence(
    { 'Research Notes': 'Both indoor and outdoor found. TX location evidence: mention.', City: '' }, 'TX'));
  // An address, ZIP or phone is positive identification and always survives.
  for (const tier of ['address', 'zip', 'phone']) {
    assert.ok(!weakLocationEvidence({ 'Research Notes': `TX location evidence: ${tier}.`, City: '' }, 'TX'));
  }
  // A mention corroborated by a parsed city is kept.
  assert.ok(!weakLocationEvidence(
    { 'Research Notes': 'TX location evidence: mention.', City: 'Frisco' }, 'TX'));
});
await check('company names never come from page furniture', () => {
  // A site titled "Home" would otherwise be addressed as a facility called Home.
  assert.equal(resolveCompanyName('Home', { 'Facility Name': 'greenhill.org' }, 'https://www.greenhill.org/'), 'Greenhill');
  assert.equal(resolveCompanyName('Public Home', { 'Facility Name': 'The Amarillo Country Club 2022' }, 'https://theamarillocountryclub.com/'), 'The Amarillo Country Club');
  assert.equal(resolveCompanyName('Welcome to Kingwood Texas', {}, 'https://kingwood.com/'), 'Kingwood Texas');
  // A real name is never rewritten.
  assert.equal(resolveCompanyName('Empire Racquet Club', {}, 'https://empireracquet.com/'), 'Empire Racquet Club');
});

await check('phone numbers are extracted but never invented or confused with other digits', () => {
  setActiveState('UT');
  assert.equal(detectPhone('Call us at (801) 555-1234 for court bookings.'), '(801) 555-1234');
  assert.equal(detectPhone('Reach the front desk at 801-555-9876 anytime.'), '(801) 555-9876');
  // A labelled fax line is excluded even when it is the only number on the page.
  assert.equal(detectPhone('Fax: 801-555-0000'), '');
  assert.equal(detectPhone('Phone: 801.555.4321 | Fax: 801.555.0000'), '(801) 555-4321');
  // A bare 10-digit run with no separators is an order number, not a phone.
  assert.equal(detectPhone('Order #8015551234 was shipped.'), '');
  // A ZIP+4 must not be mistaken for a phone number.
  assert.equal(detectPhone('ZIP+4: 84101-1234 is our mailing code.'), '');
  // Toll-free numbers are accepted; they carry no state area code to match.
  assert.equal(detectPhone('Toll-free: 1-800-555-6789 for reservations.'), '(800) 555-6789');
  // When a page carries a vendor's out-of-state number alongside the
  // facility's own, the one matching the active state's area codes wins.
  assert.equal(
    detectPhone('Our vendor line is (212) 555-0000, but call 801-555-7777 for the Utah club.'),
    '(801) 555-7777',
  );
  assert.equal(detectPhone('No phone info here at all.'), '');
  setActiveState('NY');
});

await check('a phone number found by either enrichment pass survives merging, even when it loses on weight', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-test-'));
  try {
    // Pass A: richer overall (two people), but the phone was added to
    // extract.js after this pass ran and so found none -- exactly what
    // happened mid-run on this project. Pass B: weaker (no named people),
    // but ran after the fix and found the facility's phone number.
    const passA = path.join(dir, 'a.json');
    const passB = path.join(dir, 'b.json');
    fs.writeFileSync(passA, JSON.stringify([{
      Website: 'https://example.com/', _people: [{ first: 'A', last: 'One' }, { first: 'B', last: 'Two' }],
      _locations: [], _directEmails: [], Phone: '',
    }]));
    fs.writeFileSync(passB, JSON.stringify([{
      Website: 'https://example.com/', _people: [], _locations: [], _directEmails: [],
      Phone: '(801) 555-1234',
    }]));
    const idx = loadContactIndex([passA, passB]);
    const merged = idx.get('example.com');
    // The richer pass's people are kept (weight-based winner unchanged)...
    assert.equal(merged._people.length, 2);
    // ...but the phone the weaker pass found is not silently discarded.
    assert.equal(merged.Phone, '(801) 555-1234');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await browser.close();
server.close();
console.log(`\n${pass} checks passed${process.exitCode ? ' (with failures)' : ''}`);
