# Project Status — 2026-08-11

Ten states crawled. Nothing is running. Everything is committed and pushed.

---

## Candidate-email files ready for Reoon

All in `~/Desktop/autopilot-statewise-list-builder/` and
`~/dev/autopilot-statewise-list-builder/`, and on GitHub.

| State | Rows | Status |
| --- | ---: | --- |
| California | 2,381 | complete |
| New York | 2,185 | complete (older two-step format) |
| Pennsylvania | 2,067 | **partial — see below** |
| Texas | 1,515 | complete |
| Washington | 1,185 | complete (Ryan) |
| Tennessee | 913 | complete |
| Florida | 852 | complete |
| Oregon | 787 | complete (Ryan) |
| Arizona | 692 | complete (Ryan) |
| Nevada | 52 | complete (Ryan) — **unusually small, worth checking** |

**12,629 candidate emails total.**

Each state also has `_LOCATIONS.csv` (branch addresses) and
`_NEEDS_REVIEW.csv` (indoor status unconfirmed).

Every candidate file is the exact 17-column n8n format, validated: no duplicate
addresses, one email per row, guessed patterns labelled, nothing marked
Reoon-verified before verification.

---

## Unfinished work

### Pennsylvania — paused mid-run

| Phase | Progress |
| --- | --- |
| Discovery | 6,400 / 10,240 queries (63%) — 3,840 left |
| Enrichment | 3,690 / 4,131 domains (89%) — 441 left |
| Needs-review re-verification | **never run** |

Paused when the machine hit memory pressure (load reached 49). The 2,067 rows
delivered are valid but built from partial coverage. Roughly 4–6 hours to
finish. Full instructions in `PENNSYLVANIA_RESUME.md`.

Checkpoints live in `.cache-pa/` — gitignored, local only, and represent hours
of crawling. **Do not delete `~/dev/autopilot-statewise-list-builder`.**

### Michigan — configured, never started

253 markets, 7,852 queries ready in `src/states.js`.

### Nevada — worth questioning

18 facilities against Arizona's 477 and Oregon's 389. The file is valid and
passes every check, but the number looks low for the state. Ask Ryan whether
that run completed.

---

## Git

| Branch | Head | Contents |
| --- | --- | --- |
| `claude/pa-mi-integration` | `6e7e156` | **everything** — all ten states |
| `claude/wa-az-nv-or-integration` | `6e7e156` | same commit (Ryan's branch) |
| `claude/tx-integration` | `52b2e1f` | Texas |
| `claude/fl-tn-integration` | `41cceb9` | Florida + Tennessee |
| `claude/california-indoor-courts` | `841e704` | California |
| `main` | `6dd3e5a` | New York + developer's PR #2 |

Nothing merged into `main` beyond PR #2. `claude/pa-mi-integration` is the
branch to work from — Ryan's work fast-forwarded cleanly into it with no
divergence.

---

## Coordination with Ryan

Ryan crawled WA, AZ, NV and OR from a remote Windows machine. His branch was a
strict descendant of this one, so the merge was a fast-forward with no
conflicts. He contributed one genuine fix now in the shared code: the CLI
entry-point guard uses `pathToFileURL` instead of string-concatenating a
`file://` URL, which was broken on Windows paths.

Divide remaining states explicitly before either side starts, to avoid
duplicate crawling.

---

## Next steps, in order

1. Upload the nine candidate CSVs to Reoon; verify the `Final Email` column
2. Apply the keep/drop rules — keep Valid; drop Invalid, Disposable, Spamtrap,
   Disabled; review Catch-all individually; where several guessed patterns for
   one person come back Catch-all, keep only the most likely one
3. Upload survivors to n8n — the files are already in n8n's format, so there is
   no second conversion step
4. Finish Pennsylvania (4–6 hrs), then Michigan
5. Decide what to do with the ~2,400 Needs Review facilities across all states —
   they have confirmed court sports but unstated indoor status, and over half
   already carry an email

---

## Reference documents

- `DEVELOPER_GUIDE.md` — how the whole tool works, for a new developer
- `PENNSYLVANIA_RESUME.md` — exact commands to resume the PA crawl
- `N8N_INDOOR_COURTS_5_ROW_REFERENCE.csv` — source of truth for the output format
