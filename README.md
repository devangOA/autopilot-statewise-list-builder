# autopilot-statewise-list-builder

State wise list builder for operation autopilot.

Discovers sports facilities with **indoor courts** and enriches each one with a
decision maker and contact emails, then writes a single deduplicated CSV.

## Results

`NEW_YORK_INDOOR_COURT_FACILITIES.csv` holds **1,172 New York facilities**,
built from 4,967 search queries across ~160 markets, 3,852 candidate domains and
2,860 sites crawled.

| Qualification | Facilities |
| --- | ---: |
| Confirmed Indoor | 306 |
| Indoor and Outdoor | 416 |
| Needs Review | 450 |
| **Total** | **1,172** |

| Contact data | Facilities |
| --- | ---: |
| Published direct email | 329 |
| Shared facility email | 325 |
| Six guessed patterns (no direct email published) | 196 |
| Named decision maker with title | 258 |
| At least one email of any kind | 732 |
| Explicit court count | 246 |

Coverage spans 305 distinct municipalities from Montauk to Buffalo. Every row
carries its `Source URLs`; no field is written from model recall.

## Pipeline

```
npm run build:ny    discover + enrich  -> NEW_YORK_INDOOR_COURT_FACILITIES.csv   (master, 1 row per facility)
npm run finalize    re-dedup from cache -> rewrites the master, no crawling
npm run reoon       fan out to contacts -> NY_INDOOR_COURTS_REOON_VERIFICATION_INPUT.csv  (1 row per candidate email)
                                        -> NY_INDOOR_COURTS_LOCATIONS.csv                 (1 row per branch address)
                                        -> NY_INDOOR_COURTS_NEEDS_REVIEW.csv              (parked, unclear indoor status)
```

`reoon` never writes the master. It reads it, plus an optional
`--contacts <rows.json>` from a second crawl pass that retains every named
person and every branch address, and joins the two: the master decides *whether*
a facility qualifies, the contact pass decides *who* to contact there.

## Running it

```bash
npm install
npm run preflight        # confirms search engines are reachable
npm run build:ny         # writes NEW_YORK_INDOOR_COURT_FACILITIES.csv
```

A statewide run takes hours. It is safe to interrupt and restart: discovery
resumes per query, enrichment resumes per domain, and the CSV is rewritten every
20 sites, so a usable file is always on disk.

```bash
# resume a stopped run, at a lower thermal load
node src/index.js --state NY --concurrency 2 --discovery-concurrency 2
```

### Search engine health

Engines block scrapers and the set that works changes over time. `searchQuery()`
tries them in order and rotates the starting point per worker, so a dead engine
costs one navigation rather than the run. As last verified:

| Engine | State | Note |
| --- | --- | --- |
| Startpage | works | cleanest result markup |
| Brave | works | rate-limits (`429`) under sustained load |
| Bing | works | every href is a `/ck/a?u=a1…` redirect that **must** be base64-decoded — see `unwrapRedirect()`; without it every Bing result reads as `bing.com` and is discarded as an aggregator |
| Yahoo | works | noisy; own `/local/` links are filtered |
| DuckDuckGo | blocked | `403` on both `html.` and `lite.` |
| Mojeek | blocked | altcha captcha interstitial |

Dead engines are kept in the list deliberately: they cost one navigation, are
caught by the HTTP status gate, and cost nothing once they recover. When every
engine fails at once the crawler backs off exponentially and leaves the query
*unmarked*, so a resume retries it rather than skipping it.

## How it works

1. **Discovery** (`src/queries.js`, `src/geo.js`, `src/search.js`) — fans ~31
   query templates (indoor pickleball, racquet club, sportsplex, fieldhouse,
   platform tennis, court rental, …) across ~160 New York markets covering every
   region of the state, plus statewide directory-style queries. Results are
   reduced to candidate domains; aggregators (Yelp, Facebook, booking platforms,
   venue marketplaces) and government hosts (`*.gov`, `*.ny.us`) are dropped —
   the goal is the facility's own site.
2. **Enrichment** (`src/extract.js`) — visits each domain plus up to six interior
   pages matching contact/about/staff/courts/membership hints, then extracts:
   facility name, city, sports, indoor/outdoor signals, an explicit court count,
   emails, and decision-maker name + title.
3. **Qualification** (`src/classify.js`) — applies the inclusion rules.
4. **Finalization** (`src/finalize.js`) — resolves each facility's real mail
   domain, regenerates the guessed permutations against it, strips third-party
   emails, drops publishers, and deduplicates facilities and contacts. Kept
   separate from the crawl so it can be re-applied to a cached `rows.json`
   without re-fetching thousands of sites.
5. **Output** (`src/csv.js`) — one row per facility.

### Rules encoded

| Rule | Where |
| --- | --- |
| Indoor courts, or indoor **and** outdoor, are included | `classify.js` |
| Outdoor-only is excluded (`Outdoor Only - Exclude`) | `classify.js` |
| Unclear indoor status is kept as `Needs Review`, never dropped | `classify.js` |
| A missing court count never disqualifies a facility | `classify.js` |
| Court counts are recorded only from an explicit statement, with the source sentence in `Court Count Notes` | `extract.js` |
| Public parks, municipal/government, free community, residential/apartment/HOA courts are excluded | `extract.js` (`looksExcluded`), `search.js` (`isGovHost`) |
| A facility must show New York location evidence — a `, NY` address, a `1xxxx` ZIP or a NY area code — taken from the page itself, never from a search snippet | `extract.js` (`detectNyEvidence`) |
| Online stores and lesson marketplaces are excluded (3+ cart signals, so a facility pro shop survives) | `extract.js` (`looksRetail`) |
| Newspapers, magazines and news aggregators are excluded on their domain, never their name — "The Post BK" is a venue | `finalize.js` (`looksLikePublisher`) |
| Duplicate facilities collapse on apex domain, then on normalized name + city; the richer row wins | `finalize.js` |

`Qualification Status` is one of `Confirmed Indoor`, `Indoor and Outdoor`,
`Needs Review`, `Outdoor Only - Exclude`, `Not Qualified`. Only the first three
are written to the CSV; the other two are logged with their reason and skipped.

### Emails

- `Public Direct Email` — only a real address found on the site, preferred when
  its local part matches the decision maker's name.
- `Shared Facility Email` — `info@`, `contact@`, `membership@`, `operations@`, etc.
- Addresses on an unrelated corporate domain are discarded. A syndicated article
  leaves a reporter's address on the page, and it would otherwise be recorded as
  the facility's contact. Free mail (`gmail`, `optonline`, …) is kept — small
  clubs genuinely use it — as is a second domain sharing the facility's brand
  words.
- `Guessed Email 1–6` — filled **only when no direct email was published**, using
  the six required permutations of the person's name against the facility's
  **mail** domain — the domain it demonstrably receives mail on, not whatever
  booking or vanity subdomain the crawler happened to land on, and never a
  free-mail host (`first.last@gmail.com` is not a pattern, it is a fiction):
  `first@`, `first.last@`, `firstlast@`, `flast@`, `f.last@`, `firstl@`.
  These are pattern guesses. Every row carrying them says so in
  `Research Notes`: *"Guessed emails are UNVERIFIED pattern permutations - not
  published addresses."*

## Options

```
node src/index.js [options]
  --out <file>          output CSV (default NEW_YORK_INDOOR_COURT_FACILITIES.csv)
  --state <code>        value written to the State column (default NY)
  --max-queries <n>     cap discovery queries (0 = all, default)
  --max-sites <n>       cap enriched sites (0 = all, default)
  --concurrency <n>     parallel enrichment contexts (default 4)
  --discovery-concurrency <n>
                        parallel search contexts (default 4); each worker starts
                        its engine rotation at a different offset so workers
                        spread load instead of rate-limiting one engine
  --cache <dir>         cache dir (default .cache); a run resumes from it
  --sites-file <file>   skip discovery, enrich a JSON array of URLs instead
```

`--sites-file` is the way to enrich a hand-built or externally sourced domain
list, and is what the end-to-end test drives.

The cache holds four files: `sites.json` (discovered domains),
`queries-done.json` (queries that returned results), `attempted.json` (domains
already enriched, whatever the outcome) and `rows.json` (kept rows). Deleting
`queries-done.json` re-runs discovery over the existing domains; deleting
`attempted.json` re-crawls every site.

### Environment

- `HTTPS_PROXY` is used for Chromium when set.
- `CRAWLER_DISABLE_PROXY=1` bypasses it — needed for local/offline runs, because
  a CONNECT-only proxy answers plain-HTTP requests with `405` and Chromium does
  not reliably honor a loopback bypass list. `fetchPage()` rejects any non-OK
  document so such an error page is never parsed as facility content.

## Porting to another state

The pipeline is state-agnostic in structure; the New York specifics are
isolated in a handful of named constants. To build, say, Texas, change these
and nothing else:

| What | Where | Change |
| --- | --- | --- |
| Market list driving query fan-out | `geo.js` → `NY_MARKETS` | Replace with that state's cities/suburbs. Coverage matters more than length: most facility sites only surface for a city-scoped query. |
| Statewide directory queries | `queries.js` → `STATEWIDE` | Swap the state name. Templates in `TEMPLATES` are sport-specific, not state-specific, and carry over unchanged. |
| Municipality whitelist for city parsing | `extract.js` → `NY_PLACES` | Replace. Used to pick the real city out of an address line. |
| Location gate | `extract.js` → `detectNyEvidence`, `NY_AREA_CODES` | Swap the area codes, the `, NY` literal and the `1xxxx` ZIP prefix. |
| Address parser state literal | `extract.js` → `detectCity`, `detectAddresses` | Both match `(?:NY|New York)`; parameterize or swap. |
| Government host pattern | `search.js` → `GOV_PATTERNS` | `\.ny\.us` becomes the state's equivalent. |
| Output filenames | `package.json` scripts, `--out` | Cosmetic. |

`--state TX` already flows through to the `State` column and the `TX-0001`
facility IDs. Everything else — engine handling, resumability, dedup,
publisher/retail/marketplace exclusion, the email rules and the whole
verification-input builder — is generic and needs no change.

Expect one thing to differ per state: **which search engines work**. Engine
health drifts and is partly geographic. Run `npm run preflight` first and check
the table above before assuming the current engine set still holds.

## Tests

```bash
npm test
```

Runs 46 unit/integration checks against local fixture pages plus a 4-check
end-to-end run of the orchestrator, asserting that the indoor+outdoor club is
captured with its manager and emails while the outdoor-only and municipal
fixtures are excluded. No network access required.

The checks cover the failure modes that actually corrupted output during the
New York run: Bing's `/ck/a` redirect wrapper, street addresses parsed as city
names, generic `<title>` text becoming a facility name, out-of-state rows,
online stores, publishers, third-party emails, and guessed addresses aimed at a
booking subdomain.

### Re-finalizing without re-crawling

Dedup, mail-domain resolution and the exclusion filters run over the cached
rows, so they can be corrected and re-applied in seconds:

```bash
npm run finalize        # rewrites the CSV from .cache/rows.json
```
