# How the State-Scraper Works (Plain-English Guide)

This explains what this tool does, how it's built, and — the question everyone
asks — why finding indoor sports facilities in one U.S. state can take
6-10+ hours. Written so a developer with zero prior context can read it once
and understand the whole system.

---

## 1. What this tool actually does, in one paragraph

Given a U.S. state, it finds every sports facility with **indoor courts**
(pickleball, tennis, basketball, volleyball, racquetball, etc.), figures out
**who to contact** there (a named person, or the facility's general inbox),
and writes a spreadsheet ready to feed into an email outreach tool (n8n).
It does this by actually driving a real, invisible web browser: searching the
web the way a person would, opening each result, reading the page, and
pulling out facts. It never guesses or makes anything up — every fact in the
output traces back to a specific page that was actually visited, and if
something couldn't be confirmed (like a guessed email pattern), it's labeled
as unconfirmed so nobody mistakes it for verified data.

**Why not just use an API or a directory?** There isn't one. "Indoor sports
facility" isn't a business category any government or data provider tracks.
These are small, independent businesses — racquet clubs, church gyms,
YMCAs, sportsplexes — each with its own little website and no shared
registry. The only way to build this list is to search for it and read the
results, the way a human researcher would, just automated and done
thousands of times over.

---

## 2. The six stages, in the order they run

Think of this like a factory assembly line. Each state goes through six
stations, in order:

```
1. DISCOVERY          "What businesses might have indoor courts in this state?"
        |
2. ENRICHMENT         "Visit each one's website and read it."
        |
3. QUALIFICATION      "Does this actually qualify as an indoor-court facility?"
        |
4. NEEDS-REVIEW PASS  "For the maybes, look a little harder before giving up."
        |
5. WIDE CONTACT PASS  "Now that we know who's real, dig deeper for names/emails."
        |
6. BUILD & DELIVER    "Assemble the final spreadsheet."
```

### Stage 1 — Discovery

The tool doesn't know any facilities up front. It builds a giant list of
search queries by combining:

- **Every city/town in the state that's worth checking** (a "market" — e.g.
  `Charlotte NC`, `Wilkesboro NC`). North Carolina alone has **293** of these.
- **Every way you might phrase looking for one** (a "template" — 31 of them,
  e.g. `indoor pickleball courts {city}`, `racquet club {city}`,
  `sportsplex {city}`).

Multiply those together and add a handful of statewide searches, and you get
the total number of Google-style searches the tool has to run. For example:

| State | Cities checked | Search phrasings | Total searches |
|---|---:|---:|---:|
| Nevada (small state) | 28 | 31 | 875 |
| Illinois | 133 | 31 | 4,133 |
| North Carolina | 293 | 31 | 9,094 |

Each search is run through a real browser against five different search
engines (Startpage, Brave, Bing, Yahoo, DuckDuckGo — whichever ones aren't
currently blocking automated traffic), and every business website that shows
up gets added to a candidate list. **This is search-engine traffic, and
search engines rate-limit it** — more on that in Section 3.

### Stage 2 — Enrichment

For every candidate website found in Stage 1, the tool:

1. Opens the homepage.
2. Follows up to 6 more internal links that look like "Contact", "About",
   "Staff", "Membership", "Courts", etc.
3. Reads all the text and HTML from those pages.
4. Extracts: the facility's real name, its city, what sports it offers,
   whether it says "indoor" or "outdoor", any stated court count, any named
   staff members, and any email addresses.

This is also a full browser visit per page — not a lightweight HTTP request.
The tool blocks images/fonts/video to save time, but it still has to load
and render each page like a real visitor would, because a lot of the
content (court counts, staff names) only appears after JavaScript runs.

### Stage 3 — Qualification

Every enriched page gets a verdict:

| Verdict | Meaning | Goes in the final file? |
|---|---|---|
| **Confirmed Indoor** | Site clearly says indoor courts exist | Yes |
| **Indoor and Outdoor** | Both mentioned | Yes |
| **Needs Review** | Has the right sport, but never says indoor *or* outdoor | Parked separately |
| **Outdoor Only** | Explicitly outdoor-only | No |
| **Not Qualified** | Wrong kind of business, out of state, a park district, a retailer, etc. | No |

In practice, **40-55% of everything found lands in "Needs Review"** — most
small-business websites just don't bother stating whether their courts are
indoors, because it's obvious to a local customer. That's not a bug in the
tool; it's genuinely unknowable from the page alone, which is exactly why
Stage 4 exists.

### Stage 4 — Needs-Review re-verification

For every "Needs Review" facility, the tool goes back and reads **12 pages
instead of 6**, this time prioritizing pages likely to mention indoor/outdoor
status directly (FAQ, hours, amenities, "our club" pages) rather than
contact pages. Some fraction of these get upgraded to "Confirmed Indoor" once
the deeper read finds the missing detail. The rest stay parked in a
`NEEDS_REVIEW.csv` file — not thrown away, just flagged as needing a human
or a phone call before outreach.

### Stage 5 — Wide contact crawl

Once the tool knows *which* facilities are real, it goes back one more time
— this time reading **12 pages with a contact-focused lens** (staff,
leadership, directory pages) instead of the indoor/outdoor lens from Stage
4. The idea: a facility's first 6-page pass might miss a "Meet Our Staff"
page buried three clicks deep. This pass exists purely to find more named
people and published email addresses without ever inventing one.

### Stage 6 — Build & deliver

All of that gets assembled into the final spreadsheet: one row per facility
for the master list, and one row per *candidate email* for the outreach
file (a facility with three staff emails becomes three rows). Everything is
merged intelligently — if the same facility was seen in both the enrichment
pass and the wide-contact pass, whichever version found more information
wins.

---

## 3. Why one state takes 6-10+ hours: the real time budget

This is the part everyone actually wants to know. There is no single
bottleneck — it's five things stacking on top of each other.

### (a) Search engines actively fight back

Search engines don't want to be scraped, and they rate-limit aggressively.
On a big state, throughput can collapse from ~35 searches/minute to under 2.
When that happens, the tool makes **all its search workers pause together
for 2 full minutes** to let the rate limit decay, rather than hammering a
wall. This is deliberate and necessary — without it, every search would
just fail.

**Concrete consequence:** a state's 9,000+ searches don't all succeed on the
first pass. Illinois needed 2 attempts (rounds) to get every search to
actually go through; North Carolina needed 2 as well, with over 6,600 of its
9,094 searches rate-limited on the first attempt alone.

### (b) Every visit is a real, full browser page load

This isn't sending lightweight web requests — it's opening an actual
(invisible) Chrome browser tab for every single search *and* every single
website visit, waiting for it to render, then reading the result. A
real browser tab takes real seconds to load, even a fast one.

### (c) The math multiplies fast

One state = (thousands of searches) + (thousands of website visits, each
visiting up to 6-12 pages). North Carolina's search list alone was
**9,094 entries**; after discovery, over **2,300 candidate websites** needed
full visits, each with up to 6 pages read — that's north of **13,000 page
loads** just for Stage 2, before Stages 4 and 5 add another full sweep each.

### (d) Only 2 workers run at once, on purpose

The tool could try to run 10 browser tabs at once to go faster, but that's
exactly what triggers rate-limiting *faster*, not slower — and on a shared
machine it also risks crashing the browser (see Section 5). Two workers is
the deliberately conservative choice that keeps the crawl stable over many
hours unattended, rather than fast but fragile.

### (e) The pipeline runs stages in sequence, not all at once

A state can't start Stage 5 (wide contact crawl) until Stage 3 knows which
facilities qualified, which can't happen until Stage 2 has actually read
every candidate site, which can't happen until Stage 1's searches have
actually gone through. Each stage's total time adds to the next.

### Put together — real numbers from this project

| State | Cities | Searches | Total time (all 6 stages) |
|---|---:|---:|---:|
| Nevada (small) | 28 | 875 | ~40 minutes |
| Indiana | 80 | 2,489 | ~3 hours |
| Illinois | 133 | 4,133 | ~6 hours |
| North Carolina | 293 | 9,094 | ~9-10 hours |

The pattern is consistent: **time scales with how many cities/towns are in
the search list**, because that's what drives both the search volume and the
number of candidate websites found.

---

## 4. How to actually run it

```bash
npm install                      # installs Playwright (the browser driver)
npx playwright install chromium  # downloads the actual browser binary
npm run preflight                # checks which search engines are reachable today
node src/index.js --state NC --all-templates \
  --out NORTH_CAROLINA_INDOOR_COURT_FACILITIES.csv \
  --cache .cache-nc \
  --discovery-concurrency 3 --concurrency 2
```

- `--all-templates` — use every one of the 31 search phrasings for every
  city, instead of a lighter subset. Always use this for a real run.
- `--cache .cache-nc` — where progress checkpoints get saved. **This is the
  most important flag.** If the process is killed, loses network, or the
  machine restarts, running the exact same command again picks up exactly
  where it left off — it does not start over. Every search and every
  website visit is checkpointed individually.
- `--discovery-concurrency 3 --concurrency 2` — 3 parallel search workers, 2
  parallel website-reading workers. Turning these up doesn't reliably speed
  things up (see 3d above) and can destabilize the browser.

After the main crawl, three more commands run in sequence (all wired
together by `run-state-full.sh` in this repo, which is what actually gets
used — you don't need to run these by hand):

```bash
# Stage 4: needs-review re-verification
node src/index.js --state NC --deep --sites-file needs-review-urls.json --cache .cache-ncreview

# Stage 5: wide contact crawl
node src/index.js --state NC --wide --sites-file all-qualified-urls.json --cache .cache-ncwide

# Stage 6: build the final spreadsheets
node src/n8n.js --state NC --in NORTH_CAROLINA_INDOOR_COURT_FACILITIES.csv \
  --contacts .cache-nc/rows.json --contacts2 .cache-ncwide/rows.json \
  --upgrades .cache-ncreview/rows.json \
  --out NC_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv
```

### Checking on a long-running crawl

```bash
tail -f batch.log                                    # watch live progress
node src/check-coverage.mjs --state NC --cache .cache-nc   # did every search actually complete?
```

That second command matters: a crawl can *look* finished (the process
exited normally) while a chunk of its searches were secretly rate-limited
and never really ran. `check-coverage.mjs` checks the real numbers, not just
whether the process finished — this exact gap was caught mid-project (see
below).

---

## 5. What can go wrong (real bugs hit and fixed on this project)

Worth knowing about if you're maintaining this, because none of these were
obvious from reading the code — all three were found by watching a live run
behave strangely and digging in.

**1. A crashed browser page looked like "the website is bad," not "the
browser broke."** When one page crashed the browser's rendering process,
the code treated it as an ordinary failed website and moved on — but it kept
reusing the *same broken browser tab* for the next site, which crashed
identically, forever, cascading through the rest of that worker's whole
list. One state lost 89% of its results this way before it was caught.
**Fix:** browser crashes are now recognized specifically and cause a clean
restart of that worker's tab, instead of being treated as a normal failure.

**2. A hung page could freeze an entire crawl with zero error message.**
Loading a page has a timeout, but *reading* the page afterward (extracting
its text) didn't — so a page that loaded fine but then got stuck (a broken
script, a popup dialog waiting for a click that never comes) could hang the
whole worker forever, with nothing in the log to show anything was wrong. It
looked identical to a healthy, slow-running crawl. **Fix:** the entire
page-read step now has a hard ceiling (~15-40 seconds); if it's exceeded,
that one site is marked as failed and the worker gets a fresh browser tab
before continuing.

**3. Search-list density wasn't consistent between states.** Some states
had a search-city list built at roughly one city per 40,000 people; others
were built at one per 100,000-170,000 — meaning smaller towns were
skipped in some states but not others, without that being a deliberate
choice. **Fix:** always sanity-check a new state's city list against
population before running it, not after.

---

## 6. Where everything lives

| Path | What it is |
|---|---|
| `src/states.js` | Every state's city list, ZIP code ranges, area codes, search phrases. Adding a new state means adding one entry here. |
| `src/index.js` | The main orchestrator — runs Stages 1 and 2. |
| `src/extract.js` | Reads a page and pulls out facts (name, city, sports, emails, staff). |
| `src/classify.js` | Turns extracted facts into a Stage 3 verdict. |
| `src/n8n.js` | Stage 6 — builds the final spreadsheets. |
| `src/check-coverage.mjs` | Verifies a crawl's searches actually completed (not just that the process exited). |
| `.cache-<state>/` | Checkpoint files for a state's crawl. Safe to delete only if you want to re-run that state from zero. |
| `run-state-full.sh` | Runs all six stages for one state, in order, automatically. |
| `run-batch.sh` | Runs `run-state-full.sh` for a whole list of states, one at a time. |
| `<STATE>_INDOOR_COURT_FACILITIES.csv` | The master output — one row per facility. |
| `<XX>_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv` | The actual deliverable — feeds straight into email outreach. |

---

## 7. Quick FAQ

**Q: Can I just run more workers to make it faster?**
No — search engines rate-limit collectively, so more workers hit the wall
sooner, not later, and gain nothing. The 2-3 worker setup is a floor, not a
bottleneck to remove.

**Q: Why not skip the "Needs Review" facilities and just ship what's
confirmed?**
Because 40-55% of everything found normally lands there, and most of them
are real, legitimate facilities whose website just never happened to state
"indoor" in words. Skipping them means silently discarding roughly half the
real leads.

**Q: If it crashes or I lose power, do I lose all the progress?**
No. Every search and every website visit is checkpointed the moment it
completes, in the `.cache-<state>/` folder. Re-running the exact same
command resumes instantly from wherever it stopped — this is true even
mid-search, not just between states.

**Q: Why does the guessed-email feature only fire sometimes?**
By design. A guessed email pattern (like `first.last@facility.com`) is only
generated when there's a real, named person **and** no actual published
email was found for them. If a real email is published, that's always used
instead — a guess never overrides a fact.
