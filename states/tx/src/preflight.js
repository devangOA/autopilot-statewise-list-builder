// Verifies the sandbox can actually reach the open web before a long run.
// Exits non-zero with an actionable message when egress is blocked, so a
// multi-hour crawl fails in seconds instead of producing an empty CSV.
import { launchBrowser, newCrawlContext } from './browser.js';

const PROBES = [
  'https://html.duckduckgo.com/html/?q=test',
  'https://www.bing.com/search?q=test',
  'https://www.mojeek.com/search?q=test',
  'https://example.com',
];

const browser = await launchBrowser();
const { page } = await newCrawlContext(browser, { blockAssets: false });

let ok = 0;
for (const url of PROBES) {
  try {
    const res = await page.goto(url, { timeout: 20000, waitUntil: 'domcontentloaded' });
    console.log(`OK    ${res.status()}  ${url}`);
    ok++;
  } catch (e) {
    console.log(`BLOCK       ${url}  ${e.message.split('\n')[0]}`);
  }
}
await browser.close();

if (!ok) {
  console.error(
    '\nNo outbound web access. Every probe was refused at the egress gateway.\n' +
      'This sandbox\'s network policy allows only GitHub and package registries,\n' +
      'so search engines and facility websites cannot be reached.\n\n' +
      'Fix: recreate/edit the Claude Code environment with a network policy that\n' +
      'permits general web egress, then re-run `npm run build:ny`.\n' +
      'Docs: https://code.claude.com/docs/en/claude-code-on-the-web\n',
  );
  process.exit(1);
}
console.log(`\n${ok}/${PROBES.length} probes reachable - safe to run the crawl.`);
