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
} from '../src/extract.js';
import { guessEmails } from '../src/emails.js';
import { qualify, isKeepable } from '../src/classify.js';
import { QUALIFICATION } from '../src/schema.js';
import { toCsv } from '../src/csv.js';
import { registrableDomain, isNonFacilityHost, isGovHost } from '../src/search.js';
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

await browser.close();
server.close();
console.log(`\n${pass} checks passed${process.exitCode ? ' (with failures)' : ''}`);
