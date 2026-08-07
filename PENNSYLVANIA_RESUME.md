# Pennsylvania — Resume Handoff

Paused 2026-08-07 at the user's request (machine ran short of application
memory). Nothing is running. Nothing is lost.

---

## Read first

`DEVELOPER_GUIDE.md` — the whole tool explained. In the repo, and at
`/tmp/statewise-guide/DEVELOPER_GUIDE.md`.

---

## Where the work lives

**Working repo:** `~/dev/autopilot-statewise-list-builder` — clean git, local
`node_modules`, outside iCloud. **Use this one.**

**Desktop copy:** `~/Desktop/autopilot-statewise-list-builder` — has the finished
CSVs, but its git is corrupted and it sits inside iCloud sync, which evicted
files and caused a multi-hour outage. Fine as a drop-off point, not for running
crawls.

**Branch:** `claude/pa-mi-integration`, commit `174a971`, pushed. Not merged.

---

## Delivered so far

| File | Rows |
| --- | ---: |
| `PA_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv` | **2,067** |
| `PA_INDOOR_COURTS_LOCATIONS.csv` | 599 |
| `PA_INDOOR_COURTS_NEEDS_REVIEW.csv` | 339 |
| `PENNSYLVANIA_INDOOR_COURT_FACILITIES.csv` (master) | 879 |

In both folders, committed and pushed. The candidate file is valid 17-column
n8n format, `PA-COURTS-001` / `PA-COURTS-20260806-B001`, ready for Reoon now.

An earlier 920-row version was delivered and is a strict subset of the 2,067 —
verified, so nothing sent from it is orphaned. Frozen copy at
`/tmp/pa-920-frozen.csv`.

---

## Exact state when paused

| | |
| --- | ---: |
| Discovery | 6,400 / 10,240 queries (63%) |
| Domains found | 4,131 |
| Enriched | 3,690 / 4,131 (89%) |
| Facilities kept | 985 |

Checkpoints, all validated, in `~/dev/autopilot-statewise-list-builder/.cache-pa/`:

```
queries-done.json    6400   queries that returned results
sites.json           4131   discovered domains
attempted.json       3690   domains already enriched
rows.json             985   kept facility rows (+ _people, _locations)
fallback-queue.json      0   nothing stranded
```

**These are gitignored and local-only.** They are the crawl state — losing them
means re-crawling. They live in `~/dev`, which is outside iCloud, so they are
safe unless that directory is deleted.

---

## To resume

```bash
cd ~/dev/autopilot-statewise-list-builder

# 1. finish enrichment (~440 domains left) and continue discovery
node src/index.js --state PA --all-templates \
  --out PENNSYLVANIA_INDOOR_COURT_FACILITIES.csv \
  --cache .cache-pa --discovery-concurrency 2 --concurrency 2

# 2. re-verify Needs Review (deeper crawl, 12 pages, indoor-focused hints)
#    build the site list from the master's Needs Review rows first, then:
node src/index.js --state PA --deep --sites-file /tmp/pa-review-sites.json \
  --cache .cache-pareview --out /tmp/pa-review.csv --concurrency 2

# 3. rebuild the deliverables
node src/n8n.js --state PA --in PENNSYLVANIA_INDOOR_COURT_FACILITIES.csv \
  --contacts .cache-pa/rows.json --upgrades .cache-pareview/rows.json \
  --out PA_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv \
  --locations PA_INDOOR_COURTS_LOCATIONS.csv \
  --review PA_INDOOR_COURTS_NEEDS_REVIEW.csv \
  --track-id PA-COURTS-001 --batch PA-COURTS-20260806-B001
```

A ready-made orchestrator that alternates discovery and enrichment (so engine
rate limits decay while facility sites are crawled) is at `/tmp/pa-cycle.sh`,
and the generic per-state runner is `run-state.sh` in the repo.

**Remaining work:** ~440 domains to enrich, 3,840 discovery queries, the
needs-review pass, final rebuild. Roughly 4–6 hours depending on rate limits.

---

## Then Michigan

Configured in `src/states.js` — 253 markets, 7,852 full-template queries. Not
started. Same procedure, `MI-COURTS-001` / `MI-COURTS-20260806-B001`.

---

## Operating notes learned the hard way

- **Memory is the constraint on this machine** (8 GB). Load hit 49 before the
  pause. Keep enrichment at 2 workers, not 3.
- **Discovery is rate-limited, not CPU-limited.** More workers reach the wall
  faster and gain nothing. Two is right. The shared 120s cooldown handles it.
- **Alternate discovery and enrichment.** Engines recover during enrichment,
  which is why coverage went 22% → 63% across two rounds.
- **Never run from `~/Desktop`** — iCloud evicts files and corrupts git.
- Search-engine health drifts: run `npm run preflight` before a long session.

---

## Other states, all complete and pushed

| State | Candidate rows | Branch |
| --- | ---: | --- |
| California | 2,381 | `claude/california-indoor-courts` |
| New York | 2,185 | `main` |
| Texas | 1,515 | `claude/tx-integration` |
| Tennessee | 913 | `claude/fl-tn-integration` |
| Florida | 852 | `claude/fl-tn-integration` |
| **Pennsylvania (partial)** | **2,067** | `claude/pa-mi-integration` |

None merged into `main` except New York and the developer's PR #2.
