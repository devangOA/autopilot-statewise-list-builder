# autopilot-statewise-list-builder

State wise list builder for operation autopilot.

Discovers sports facilities with **indoor courts** and enriches each one with a
decision maker and contact emails, then writes a single deduplicated CSV.

## Status of `NEW_YORK_INDOOR_COURT_FACILITIES.csv`

**The file currently contains only its header row — no facility data.** The
research could not be run in this sandbox: its egress policy allows GitHub and
package registries only, and every search engine and facility website is refused
at the gateway with a `403` on `CONNECT`. Nothing was reachable, so no facility,
court count, or email in the CSV could be sourced from a real page. Rows were
deliberately not written from model recall — names, staff titles, court counts,
and published emails invented that way would be indistinguishable from verified
ones in the output.

Confirm the block yourself with:

```bash
npm run preflight
```

To produce the data, run the crawler from an environment with general web egress
(a Claude Code environment with a permissive network policy, or any local
machine):

```bash
npm install
npm run preflight        # confirms the web is reachable
npm run build:ny         # writes NEW_YORK_INDOOR_COURT_FACILITIES.csv
```

## How it works

1. **Discovery** (`src/queries.js`, `src/geo.js`, `src/search.js`) — fans a set of
   query templates (indoor pickleball, racquet club, sportsplex, fieldhouse,
   court rental, …) across ~170 New York markets covering every region of the
   state, plus statewide directory-style queries. Results are scraped from
   DuckDuckGo, with Bing and Mojeek as fallbacks, and reduced to candidate
   domains. Aggregators (Yelp, Facebook, booking platforms) and government hosts
   (`*.gov`, `*.ny.us`) are dropped — the goal is the facility's own site.
2. **Enrichment** (`src/extract.js`) — visits each domain plus up to six interior
   pages matching contact/about/staff/courts/membership hints, then extracts:
   facility name, city, sports, indoor/outdoor signals, an explicit court count,
   emails, and decision-maker name + title.
3. **Qualification** (`src/classify.js`) — applies the inclusion rules.
4. **Output** (`src/csv.js`) — one row per domain, richest record wins on
   duplicates.

### Rules encoded

| Rule | Where |
| --- | --- |
| Indoor courts, or indoor **and** outdoor, are included | `classify.js` |
| Outdoor-only is excluded (`Outdoor Only - Exclude`) | `classify.js` |
| Unclear indoor status is kept as `Needs Review`, never dropped | `classify.js` |
| A missing court count never disqualifies a facility | `classify.js` |
| Court counts are recorded only from an explicit statement, with the source sentence in `Court Count Notes` | `extract.js` |
| Public parks, municipal/government, free community, residential/apartment/HOA courts are excluded | `extract.js` (`looksExcluded`), `search.js` (`isGovHost`) |

`Qualification Status` is one of `Confirmed Indoor`, `Indoor and Outdoor`,
`Needs Review`, `Outdoor Only - Exclude`, `Not Qualified`. Only the first three
are written to the CSV; the other two are logged with their reason and skipped.

### Emails

- `Public Direct Email` — only a real address found on the site, preferred when
  its local part matches the decision maker's name.
- `Shared Facility Email` — `info@`, `contact@`, `membership@`, `operations@`, etc.
- `Guessed Email 1–6` — filled **only when no direct email was published**, using
  the six required permutations of the person's name against the facility domain:
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
  --concurrency <n>     parallel browser contexts (default 4)
  --cache <dir>         discovery cache dir (default .cache); a run resumes from it
  --sites-file <file>   skip discovery, enrich a JSON array of URLs instead
```

`--sites-file` is the way to enrich a hand-built or externally sourced domain
list, and is what the end-to-end test drives.

### Environment

- `HTTPS_PROXY` is used for Chromium when set.
- `CRAWLER_DISABLE_PROXY=1` bypasses it — needed for local/offline runs, because
  a CONNECT-only proxy answers plain-HTTP requests with `405` and Chromium does
  not reliably honor a loopback bypass list. `fetchPage()` rejects any non-OK
  document so such an error page is never parsed as facility content.

## Tests

```bash
npm test
```

Runs 27 unit/integration checks against local fixture pages and a 4-check
end-to-end run of the orchestrator, asserting that the indoor+outdoor club is
captured with its manager and emails while the outdoor-only and municipal
fixtures are excluded. No network access required.
