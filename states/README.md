# Statewise ports

Each subdirectory holds the pipeline **ported to another state**. The port
follows the "Porting to another state" table in the root README: only the
state-specific constants change (market list, municipality whitelist, area
codes, ZIP prefix, the `(?:XX|State Name)` address literal, the gov-host
pattern, and the statewide directory queries). Every generic mechanism —
engine handling, resumability, dedup, publisher/retail/marketplace exclusion,
the email rules, the verification-input builder — is unchanged.

`src/` under each state is a complete, runnable copy; the only files that differ
from the root `src/` are `geo.js`, `queries.js`, `extract.js`, and `search.js`
(plus the state-aware note wording in `index.js`, which is also now in the root
`src/` — with `--state NY` it emits identical output to before).

## Results

Built 2026-08-05, both states crawled in parallel.

| | Florida | Tennessee |
| --- | ---: | ---: |
| Total facilities | **627** | **571** |
| Confirmed Indoor | 138 | 123 |
| Indoor and Outdoor | 188 | 215 |
| Needs Review | 301 | 233 |
| Sites crawled | 3,531 | 2,505 |
| Distinct cities | 132 | 95 |
| Published direct email | 145 | 160 |
| Shared facility email | 217 | 151 |
| Named decision maker + title | 114 | 116 |
| At least one email (any kind) | 389 | 345 |
| Explicit court count | 139 | 126 |

Outputs are the master CSVs at the repo root:
`FLORIDA_INDOOR_COURT_FACILITIES.csv`, `TENNESSEE_INDOOR_COURT_FACILITIES.csv`.

As with the New York run, `Confirmed Indoor` carries some noise (the extractor
keeps uncertain sites rather than dropping them — that is what `Needs Review`
is for), and every row cites its `Source URLs`. A `reoon` / human pass is the
intended final filter.

## Running a state build

```bash
npm install
npx playwright install chromium

# from the state directory (its src is self-contained)
cd states/fl
node src/index.js --state FL --out FLORIDA_INDOOR_COURT_FACILITIES.csv \
  --concurrency 3 --discovery-concurrency 3
```

Runs at concurrency 3/3 are deliberate when building more than one state at
once from a single IP: two crawls sharing the same search engines rate-limit
each other at the 4/4 default. Each run is fully resumable from its own
`.cache/`.

## Porting a further state

Change only these in a new `states/<code>/src/`, copied from the root `src/`:

| What | File | Change |
| --- | --- | --- |
| Market list | `geo.js` → `NY_MARKETS` | that state's cities/suburbs, `City XX` |
| Statewide queries | `queries.js` → `STATEWIDE` | swap the state name |
| Municipality whitelist | `extract.js` → `NY_PLACES` | that state's municipalities |
| Location gate | `extract.js` → `NY_AREA_CODES`, `detectNyEvidence` | area codes, ZIP prefix, `(?:XX|State)` literal |
| Address parser literal | `extract.js` → `detectCity`, `detectAddresses` | `(?:XX|State)` |
| Gov host pattern | `search.js` → `GOV_PATTERNS` | `\.xx\.us` |

The export/function names stay `NY_*` / `detectNyEvidence` on purpose so
`index.js` needs no change; only their contents are state-specific.
