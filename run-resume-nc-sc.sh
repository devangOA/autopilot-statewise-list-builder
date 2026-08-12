#!/bin/bash
# Resume after the fetchPage hang fix. North Carolina's enrichment was
# effectively complete (2220/2221, with the 2221st -- whereorg.com --
# already marked attempted directly) when it stalled; re-running it here
# will confirm coverage and proceed straight to needs-review + wide crawl +
# build + commit. South Carolina is untouched and runs clean from scratch.
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO" || exit 1
source ./run-state-full.sh
BATCHDATE=20260812

say "########## RESUME (post fetchPage-hang fix): NC -> SC ##########"

run_full_state NC "North Carolina" NORTH_CAROLINA "$BATCHDATE"
run_full_state SC "South Carolina" SOUTH_CAROLINA "$BATCHDATE"

say "########## BATCH FULLY COMPLETE: IL, GA, IN, NC, SC ##########"
