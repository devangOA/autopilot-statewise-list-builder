# Statewise Indoor-Court List Builder — Developer Guide

A complete walkthrough for someone who has never seen this project.

---

## 1. What this tool does, in one paragraph

It finds **sports facilities with indoor courts** in a given US state, works out **who to email** at each one, and produces a CSV that feeds an **n8n** email-outreach workflow. It does this by driving a real web browser: searching the web for candidate facilities, visiting each facility's own website, reading the pages, and extracting evidence. Nothing is answered from an AI model's memory — every field in the output traces back to a page that was actually fetched, and anything unverified is explicitly labelled as such.

**Why a crawler and not an API?** There is no directory of "indoor court facilities". They are small businesses — racquet clubs, sportsplexes, YMCAs, volleyball academies — with their own websites and no common registry. The only way to build the list is to search and read.

---

## 2. Quickstart

```bash
npm install                      # Node deps (Playwright)
npm run preflight                # checks which search engines are reachable
node src/index.js --state CA     # full crawl for California
npm run finalize -- --cache .cache-ca --out CALIFORNIA_INDOOR_COURT_FACILITIES.csv
node src/n8n.js --state CA --in CALIFORNIA_INDOOR_COURT_FACILITIES.csv --contacts .cache-ca/rows.json
npm test                         # 76 checks, no network needed
```

A statewide run takes **hours**. It is designed to be interrupted — see [§9 Resumability](#9-caching-and-resumability).

---

## 3. Technology stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | **Node.js 22**, ES modules | Everything except the fallback |
| Browser automation | **Playwright 1.56.1** | Drives Chromium; handles JS-rendered sites |
| Browser | **Chromium** (`headless_shell`) | No GUI; downloaded into `~/Library/Caches/ms-playwright` |
| Fallback fetcher | **Scrapling 0.4.12** (Python 3.10+, BSD-3) | Retrieves sites Playwright is blocked from |
| Fallback runtime | Python venv at `experiments/scrapling-eval/.venv` | Isolated; **never committed** |
| Output | Plain CSV, hand-rolled writer/reader | No dependency; formula-injection safe |

There is **no database**. State lives in JSON files under a per-state cache directory.

### Why two fetchers?

Playwright drives a real browser, so it executes JavaScript and sees what a human sees. But some sites block automated browsers outright with HTTP 403. Scrapling's cheap `Fetcher` sends an HTTP request with a **spoofed TLS fingerprint** — no browser at all — and often walks straight past those blocks.

Measured on a 20-site benchmark:

| Method | Retrieved | Time | Peak RAM |
|---|---:|---:|---:|
| Playwright alone | 15/20 | 214 s | — |
| Scrapling stealth browser alone | 17/20 | 440 s | 279 MB |
| **Playwright + cheap Scrapling fallback** | **17/20** | **317 s** | 116 MB |

The two sites Scrapling recovered were hard 403 blocks. Its cheap fetcher got them in **~0.5 s each**; its stealth browser needed 9–15 s for the same result. Hence the rule: **Playwright first, cheap Fetcher on failure, stealth browser only if that also fails.**

---

## 4. Pipeline overview

```
                    ┌─────────────────────────────────────────┐
  PHASE 1           │  DISCOVERY  (src/index.js → discover)   │
  find candidates   │  queries.js × geo/states.js             │
                    │  → search.js drives Chromium at         │
                    │    Startpage / Brave / Bing / Yahoo     │
                    └────────────────┬────────────────────────┘
                                     │  ~4,000–8,000 queries
                                     ▼  .cache-XX/sites.json
                    ┌─────────────────────────────────────────┐
  PHASE 2           │  ENRICHMENT (src/index.js → enrichAll)  │
  read each site    │  homepage + up to 6 interior pages      │
                    │  extract.js pulls out every field       │
                    │  on failure → fallback.js (Scrapling)   │
                    └────────────────┬────────────────────────┘
                                     │  .cache-XX/rows.json
                                     ▼
                    ┌─────────────────────────────────────────┐
  PHASE 3           │  QUALIFY + FINALIZE                     │
  decide + dedupe   │  classify.js → status                   │
                    │  finalize.js → dedupe, mail domains,    │
                    │                exclusion filters        │
                    └────────────────┬────────────────────────┘
                                     ▼  STATE_INDOOR_COURT_FACILITIES.csv
                    ┌─────────────────────────────────────────┐
  PHASE 4           │  OUTPUT (src/n8n.js)                    │
  build deliverables│  → n8n candidate-email CSV (17 cols)    │
                    │  → locations CSV, needs-review CSV      │
                    └─────────────────────────────────────────┘
```

### File map

| File | Responsibility |
|---|---|
| `src/index.js` | Orchestrator. Both phases, worker pools, checkpointing |
| `src/search.js` | Search engines, result parsing, redirect unwrapping, domain filters |
| `src/queries.js` | Query templates; tiering for large states |
| `src/states.js` | **All per-state data**: markets, ZIP ranges, area codes, city lists |
| `src/geo.js` | Original NY market list (kept for backwards compatibility) |
| `src/browser.js` | Chromium launch, context config, proxy handling |
| `src/extract.js` | All page parsing: names, cities, addresses, emails, people, sports, court counts |
| `src/classify.js` | Turns extracted signals into a qualification status |
| `src/fallback.js` | Scrapling escalation + **safety guards** |
| `src/scrapling_fetch.py` | The Python side; fetches one URL, prints JSON |
| `src/finalize.js` | Dedup, mail-domain resolution, exclusion filters |
| `src/n8n.js` | Builds the three deliverable CSVs |
| `src/reoon.js` | CSV reader, contact shaping, candidate-email logic |
| `src/csv.js` | CSV writer (quoting + formula-injection guard) |
| `src/schema.js` | Column order and status constants |

---

## 5. Phase 1 — Discovery

**Goal:** turn "California" into a list of candidate facility domains.

`queries.js` holds ~31 templates; `states.js` holds the markets. They multiply:

```
'indoor pickleball courts {m}'  ×  'Fresno CA'  →  "indoor pickleball courts Fresno CA"
```

California: 267 markets × 31 templates + 15 statewide queries = **8,292 queries**.

### Search engines — this is the fragile part

Engines block scrapers, and **which ones work changes over time**. As last measured:

| Engine | Status | Note |
|---|---|---|
| Startpage | ✅ works | cleanest markup |
| Brave | ✅ works | rate-limits (429) under load |
| Bing | ⚠️ works, **needs decoding** | see below |
| Yahoo | ✅ works | noisy |
| DuckDuckGo | ❌ 403 | both `html.` and `lite.` endpoints |
| Mojeek | ❌ CAPTCHA | altcha interstitial |

> **The Bing trap.** Every organic Bing result href is
> `https://www.bing.com/ck/a?...&u=a1<base64url>&ntb=1`.
> Left alone, every Bing result's domain reads as `bing.com` and gets discarded as an aggregator — Bing silently contributes **zero** candidates. `unwrapRedirect()` in `search.js` base64-decodes the `u=a1…` parameter. This single bug made the original crawler produce an empty CSV regardless of network access.

Dead engines are deliberately left in the list: they cost one navigation, are caught by an HTTP status gate, and cost nothing once they recover.

### Rate limiting

All engines rate-limit **collectively**. On a big state, throughput collapses from ~35 queries/min to under 2. Two mitigations:

1. **Tiering** — dense markets get all 31 templates; smaller towns get the 10 highest-yield ones. Coverage is unchanged (every market still queried); volume drops ~40%.
2. **Shared cooldown** — after a streak of failures, all workers pause together for 120 s so the limit can decay. Per-query backoff does not help when the limit is shared.

A query starved by a rate limit is **not** marked done, so a resume retries it.

### Filtering

Candidates are dropped immediately if the domain is an aggregator (Yelp, Facebook, booking platforms, venue marketplaces) or government (`*.gov`, `*.ca.us`). The goal is always **the facility's own website**.

---

## 6. Phase 2 — Enrichment

For each candidate domain:

1. Fetch the homepage — tries `https://`, then `https://www.`, then the raw URL.
2. Pick up to **6 interior pages** whose URL or link text matches contact / about / staff / team / membership / courts / programs / locations.
3. Concatenate all page text and HTML into one corpus.
4. Run every extractor over it.

### What gets extracted

| Field | How |
|---|---|
| Facility name | `og:site_name`, else `<title>` — **generic segments like "Home" are skipped** |
| City | Address-aware parse; strips street tokens; prefers a known municipality |
| Branch addresses | Full street addresses only (number + street + suffix + city + state). A bare city mention is marketing copy, not a location |
| Sports | Keyword match against a fixed list |
| Indoor / outdoor | Language signals ("indoor", "climate-controlled", "under one roof", "outdoor only") |
| Court count | **Only** from an explicit statement, and the source sentence is stored alongside |
| People | "Name — Title" and "Title: Name" patterns, ranked by seniority |
| Emails | Regex over text + HTML, then classified |

> **Court counts are never estimated.** Not from photos, not from the facility name, not from "we have lots of courts". If a page says "8 indoor courts", the number and the sentence are recorded. Otherwise the field is blank.

### Chromium configuration worth knowing

- `ignoreHTTPSErrors: true` — **77 of ~230 real failures** in the first state were expired/mismatched certificates on small club sites. One line recovered most of them.
- Images, fonts and video are blocked — pure cost for a text extraction crawl.
- Any non-OK document (4xx/5xx) is treated as a fetch failure, never parsed as content.

---

## 7. The Scrapling fallback and its safety guards

When Playwright fails, the URL goes to a **failure-only queue** drained by exactly **one** worker (it spawns a Python subprocess; it must not compete with the crawlers for CPU).

```
Playwright fails
      ↓
Scrapling Fetcher (cheap, no browser, ~0.5s)
      ↓ still fails
Scrapling StealthyFetcher (full stealth browser, ~10s)
      ↓
        VALIDATE  ← this is the important bit
```

### Why HTTP 200 is not good enough

A real case: `joespickleball.com` had been abandoned and now redirects to an **Indonesian gambling portal**. Playwright correctly refused it (`ERR_TOO_MANY_REDIRECTS`). Scrapling followed the redirect and returned a clean HTTP 200. Without validation, a gambling site would have entered the facility list as a "recovered" facility.

Every fallback response is rejected unless **all** hold:

1. The **final** registrable domain matches the requested one (after redirects)
2. The body is free of parked / hijacked / gambling / adult / domain-for-sale markers
3. A court sport is actually named
4. Facility evidence is present (courts, membership, booking)

Rejections are recorded with a reason, never silently dropped. In production these guards rejected a TV station (`ktla.com`), a transit agency, and a real-estate portal — all returning valid 200s.

Rows carry `Retrieval Method` (`Playwright` / `Scrapling Fetcher` / `Scrapling Stealth`), `Requested URL`, `Final URL` and `Failure Reason`, so provenance is always auditable.

---

## 8. Phase 3 — Qualification and exclusion

### Statuses

| Status | Meaning | In the email file? |
|---|---|---|
| `Confirmed Indoor` | Indoor language found | ✅ yes |
| `Indoor and Outdoor` | Both found | ✅ yes |
| `Needs Review` | Court sport confirmed, indoor/outdoor **never stated** | ❌ parked separately |
| `Outdoor Only - Exclude` | Explicitly outdoor-only | ❌ dropped |
| `Not Qualified` | Failed a rule below | ❌ dropped |

> **Needs Review is not a rejection.** These are facilities whose website never says whether courts are indoors. They are kept in their own CSV with evidence and contacts, because they are a real pipeline — but each needs a human check or a phone call first. Typically ~40–55% of a state's rows.

### Exclusion rules

- Public parks, municipal/government, free community courts
- Residential, HOA, apartment, condo courts
- Outdoor-only facilities
- Online stores and lesson marketplaces (3+ cart signals, so a facility's small pro shop survives)
- **Publishers** — newspapers, magazines, TV/radio. They rank well for court queries and pass every content check. Matched on domain (`...magazine.com`, call-sign domains like `wyrk.com`) and masthead words
- **Chambers of commerce, tourism boards, hotel groups, realtors** — they list facilities but operate none
- **Generated directory networks** — e.g. 73 `pickleball<city>.com` sites whose own pages read *"Add Your Club"* and *"your guide to all things pickleball"*
- **Out-of-state** — requires a state address, ZIP or area code **from the page itself**, never from a search snippet (a snippet says "CA" because the query did). A ZIP that contradicts its state token is rejected, so `Somewhere, CA 12345` does not pass

### Deduplication

1. **Apex domain** — `book.412squash.org` and `412squash.org` are one facility. Only *known* vanity subdomains are stripped (`www`, `book`, `members`, …), never the brand label — otherwise three unrelated clubs on `squarespace.com` would merge into one
2. **Normalized name + city** — same club reached through two domains
3. The richer record wins (more contacts, emails, court count, city)

Branches are **never** collapsed. A multi-site operator is several contactable facilities.

---

## 9. Caching and resumability

Each state has its own cache directory (`.cache-ca`, `.cache-fl`, …), gitignored.

| File | Contents |
|---|---|
| `sites.json` | Every discovered domain + its search titles/snippets |
| `queries-done.json` | Queries that **returned results** (starved ones are excluded so they retry) |
| `attempted.json` | Domains already enriched, whatever the outcome |
| `rows.json` | Kept facility rows, including hidden `_people` / `_locations` / `_directEmails` arrays |
| `fallback-queue.json` | URLs waiting on Scrapling |

The output CSV is rewritten every 20 sites, so a usable file is always on disk.

**Interrupting is safe.** Kill it, lose the network, close the laptop — restart the same command and it resumes. Discovery resumes per query; enrichment per domain.

> **One hard-won subtlety.** When the process is killed, every in-flight site fails instantly. Naively marking those "attempted" makes a resume skip hundreds of sites it never visited. `BROWSER_GONE` in `browser.js` distinguishes "the browser died" from "this site is broken" and stops the worker without marking. Ordinary failures (403, cert, timeout, DNS) must **not** match it.

---

## 10. Email rules

| Type | Rule |
|---|---|
| **Published Direct** | A real address found on the site, matched to a named person where possible |
| **Published Shared** | `info@`, `contact@`, `membership@`, `play@` … — kept **even when named contacts exist** |
| **Guessed Pattern 1–6** | Only when there is **no** published direct address for that person, and first name, last name and company domain are all confirmed |

### The six patterns

```
1. first@domain.com          4. flast@domain.com
2. first.last@domain.com     5. f.last@domain.com
3. firstlast@domain.com      6. firstl@domain.com
```

Guesses are generated against the facility's **mail domain** — the domain it demonstrably receives mail on — not whatever booking or vanity subdomain the crawler landed on. Never against free mail: `first.last@gmail.com` is not a pattern, it is a fiction.

### What is *not* a person

Extraction actively rejects: honorifics as given names (`Dr. Riley` → would generate `dr@…`), squad and department names (`Women's Basketball` → `womens.basketball@`), menu labels, and names that are just words lifted from the facility's own name (`Marlene Meyerson JCC Manhattan` → a "person" called *Meyerson Manhattan*).

Third-party addresses are stripped too: a syndicated article leaves a reporter's address on the page, and `reporter@usatoday.com` is not the facility's contact. Only the facility's own domain, a brand-sharing sibling domain, or free mail is accepted.

---

## 11. Outputs

Per state, four files:

| File | One row per | Purpose |
|---|---|---|
| `<STATE>_INDOOR_COURT_FACILITIES.csv` | facility | Master record, 28 columns incl. provenance |
| `<XX>_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv` | **candidate email** | **The deliverable** — feeds Reoon then n8n |
| `<XX>_INDOOR_COURTS_LOCATIONS.csv` | physical branch | Multi-site operators |
| `<XX>_INDOOR_COURTS_NEEDS_REVIEW.csv` | facility | Parked, indoor status unconfirmed |

### The n8n file — exactly 17 columns, in this order

```
Track ID · Batch · Company Name · Website · Address · Phone · Primary Type ·
Google Maps URL · Claygent Fit · Contact Name · Contact Title · Contact LinkedIn ·
Contact Email · Work Email · Final Email · Email Source · Fit Notes
```

**Row behaviour:**

- One candidate email per row — a facility fans out to as many rows as it has addresses
- **Named person:** address in `Contact Email` *and* `Final Email`; `Work Email` blank
- **Generic inbox:** `Contact Name` = `Team`, `Contact Title` = `Facility Team`, address in `Work Email` *and* `Final Email`; `Contact Email` blank; Fit Notes tells n8n to open with *"Hey team,"*
- Several people at one facility → several rows. A person with no published address → exactly six labelled pattern rows
- `Address`, `Phone`, `Contact LinkedIn` are blank unless confirmed — **never inferred**
- No duplicate `Final Email` anywhere in the file (Reoon bills per address)

**Example — a guessed-pattern row:**

```
Track ID        : CA-COURTS-001
Batch           : CA-COURTS-20260805-B001
Company Name    : Empire Racquet Club
Website         : https://empireracquet.com/
Primary Type    : Racquet / Tennis Club
Contact Name    : Marcus Bell
Contact Title   : Director of Operations
Contact Email   : marcus.bell@empireracquet.com
Work Email      : (blank)
Final Email     : marcus.bell@empireracquet.com
Email Source    : Guessed Pattern 2
Fit Notes       : Empire Racquet Club is a Racquet / Tennis Club in Irvine, CA.
                  Indoor-court status: Indoor. Sports offered: tennis; pickleball.
                  Published court count: 8. Marcus Bell is listed as Director of
                  Operations on the facility website. Research note: Confirmed Indoor.
                  Email status: GUESSED PATTERN - not a published address...
                  Sources: https://empireracquet.com/ | .../contact/
```

**Fit Notes** carry only sourced facts — name, city, type, indoor evidence, sports, an explicitly published court count, the person's listed role, branch count, and source URLs. Nothing is described as verified before Reoon has seen it.

---

## 12. The Reoon → n8n workflow

```
  n8n candidate CSV  ──►  Reoon (email verification)  ──►  filtered rows  ──►  n8n
   (many candidates)         validates Final Email         (deliverable)      (sends)
```

1. Upload the candidate CSV to **Reoon**, which verifies the `Final Email` column
2. Keep **Valid**. Drop **Invalid, Disposable, Spamtrap, Disabled**. Drop **Unknown** unless evidence is unusually strong
3. **Catch-all** results need judgement — keep only strong, sensible business addresses. If several guessed patterns for one person all come back catch-all, keep **one**, chosen on the organization's known convention. Never keep all six
4. Prefer published over guessed; prefer a named person over a shared inbox; keep a shared inbox as backup
5. The surviving rows upload straight into n8n — the file is already in n8n's format, so there is no second conversion step

---

## 13. Adding a new state

Almost everything is state-agnostic. Add one entry to `src/states.js`:

```js
TX: {
  code: 'TX',
  name: 'Texas',
  stateRe: /(?:TX|Texas)/,
  zipRe:   /\b(?:TX|Texas)\s+7[5-9]\d{3}\b/,
  zipBare: /^7[5-9]\d{3}$/,        // rejects a ZIP that contradicts the state
  areaCodes: /\(?(210|214|281|…)\)?[)\s.-]{1,3}\d{3}[\s.-]?\d{4}/,
  mentionRe: /\bTexas\b/i,
  markets: TX_MARKETS,             // cities to fan queries across
  majorMarkets: [...],             // optional: dense markets get all templates
  places: placeSet(TX_MARKETS, [...]),  // municipality whitelist for addresses
  gov: GOV('TX'),
  statewide: [ 'indoor pickleball facilities Texas directory', … ],
}
```

Then `node src/index.js --state TX`. The `State` column and `TX-0001` facility IDs follow automatically.

**Expect one thing to differ per state: which search engines work.** Run `npm run preflight` first, every time.

---

## 14. Operational guidance

| Setting | Recommendation |
|---|---|
| `--discovery-concurrency` | 2 on a laptop, 4 on a desktop. Higher just rate-limits faster |
| `--concurrency` (enrichment) | 2 on a laptop. Each worker is a browser context |
| Scrapling fallback workers | Always 1. Hard-coded |
| Disk | Cache is small (~7 MB/state), but Chromium needs headroom. **Below ~10 GB free, expect stalls** |

**Real observed failure:** at 95% disk, a `playwright` import hung for 20 minutes with zero CPU — a synchronous filesystem stall. The crawl survived via checkpointing but had to be restarted.

**Expected runtimes** (2 workers): discovery ~35 queries/min when healthy; enrichment ~15–20 sites/min. A large state is 6–10 hours end to end.

---

## 15. Tests

```bash
npm test     # 72 unit + 4 end-to-end checks, no network required
```

Unit tests run against local HTML fixtures served over loopback. The e2e test drives the whole orchestrator against those fixtures and asserts the indoor club is captured with its manager and emails while outdoor-only and municipal fixtures are excluded.

The suite deliberately covers **the failure modes that actually corrupted output in production**, not just happy paths: Bing's redirect wrapper, street addresses parsed as city names, generic `<title>` text becoming a facility name, out-of-state rows, online stores, publishers, third-party emails, honorifics and squad names as people, guessed addresses aimed at a booking subdomain, and the browser-died-vs-site-broken distinction.

---

## 16. Gotchas a new developer will hit

1. **`node --check` will not catch a missing identifier.** An undefined variable is a *runtime* error. A missing constant once passed syntax checks and killed a crawl 20 sites in. If you extract a value, export it and test it.
2. **`pkill -f "state FL"` matches your own shell.** The shell's command line contains the pattern, so it kills itself before your command runs. Target PIDs instead.
3. **Killing the crawler makes every queued site fail instantly.** The logs will race to "done". Trust the checkpoint files, not the tail of the log.
4. **Search snippets are not evidence.** A snippet says "CA" because the query did. Location must come from the page.
5. **The `Needs Review` bucket is large and that is correct.** Do not "fix" it by loosening the indoor test — you would be asserting facts the sites never state.
6. **Never regenerate a master CSV you did not crawl.** Filter at build time instead, so a colleague's file stays byte-identical.

---

## 17. Results to date

| State | Master rows | Confirmed Indoor | Indoor + Outdoor | Needs Review | Candidate email rows |
|---|---:|---:|---:|---:|---:|
| New York | 1,172 | 306 | 416 | 450 | 2,185 |
| California | 1,612 | 374 | 351 | 887 | 2,381 |
| Florida | 627 | 138 | 188 | 301 | 852 |
| Tennessee | 571 | 123 | 215 | 233 | 913 |

New York's candidate file is in the older two-step format (`NY_INDOOR_COURTS_REOON_VERIFICATION_INPUT.csv`); California onward use the single 17-column n8n-ready format.
