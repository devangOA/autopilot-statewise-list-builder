#!/bin/bash
# Resume after the browser-crash-cascade fix (src/browser.js BROWSER_GONE now
# catches "Page crashed"). Georgia and Indiana's attempted.json already had
# the falsely-crashed domains removed (via a one-off cleanup, not part of
# this script) so re-running them here re-enriches exactly those domains
# under the fixed code, then proceeds through needs-review + wide crawl +
# rebuild + commit as normal. This will produce a new commit for GA/IN that
# supersedes the earlier flawed one. North Carolina and South Carolina were
# never started, so they run clean from the start.
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO" || exit 1
source ./run-state-full.sh
BATCHDATE=20260811

say "########## RESUME BATCH (post crash-cascade fix): GA -> IN -> NC -> SC ##########"

run_full_state GA Georgia GEORGIA "$BATCHDATE"
run_full_state IN Indiana INDIANA "$BATCHDATE"
run_full_state NC "North Carolina" NORTH_CAROLINA "$BATCHDATE"
run_full_state SC "South Carolina" SOUTH_CAROLINA "$BATCHDATE"

say "########## RESUME BATCH COMPLETE ##########"
