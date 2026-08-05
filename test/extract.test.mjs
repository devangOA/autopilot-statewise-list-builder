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
} from '../src/extract.js';
import { guessEmails } from '../src/emails.js';
import { qualify, isKeepable } from '../src/classify.js';
import { QUALIFICATION } from '../src/schema.js';
import { toCsv } from '../src/csv.js';
import { registrableDomain, isNonFacilityHost, isGovHost, unwrapRedirect, apexDomain } from '../src/search.js';
import { finalize, mailDomain, nameKey, looksLikePublisher } from '../src/finalize.js';
import { nameIsConfirmed, candidatesFor } from '../src/reoon.js';
import { proxyConfig, preferHttps } from '../src/browser.js';

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
  assert.ok(c.length <= 3, `expected the cap to hold, got ${c.length}`);
});

await browser.close();
server.close();
console.log(`\n${pass} checks passed${process.exitCode ? ' (with failures)' : ''}`);
