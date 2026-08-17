#!/bin/bash
# Full verified pipeline for Ohio, New Jersey, Virginia, one at a time.
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO" || exit 1
source ./run-state-full.sh
BATCHDATE=20260817

say "########## BATCH: OH -> NJ -> VA ##########"
run_full_state OH Ohio OHIO "$BATCHDATE"
run_full_state NJ "New Jersey" NEW_JERSEY "$BATCHDATE"
run_full_state VA Virginia VIRGINIA "$BATCHDATE"
say "########## BATCH COMPLETE: OH, NJ, VA ##########"
