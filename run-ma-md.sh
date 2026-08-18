#!/bin/bash
# Full verified pipeline for Massachusetts and Maryland, one at a time.
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO" || exit 1
source ./run-state-full.sh
BATCHDATE=20260818

say "########## BATCH: MA -> MD ##########"
run_full_state MA Massachusetts MASSACHUSETTS "$BATCHDATE"
run_full_state MD Maryland MARYLAND "$BATCHDATE"
say "########## BATCH COMPLETE: MA, MD ##########"
