#!/bin/bash
# Batch runner: Illinois, Georgia, Indiana, North Carolina, South Carolina.
# One state at a time (shared search-engine rate limits), each through the
# full verified pipeline in run-state-full.sh.
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO" || exit 1
source ./run-state-full.sh
BATCHDATE=20260811

say "########## BATCH: IL -> GA -> IN -> NC -> SC ##########"

run_full_state IL Illinois ILLINOIS "$BATCHDATE"
run_full_state GA Georgia GEORGIA "$BATCHDATE"
run_full_state IN Indiana INDIANA "$BATCHDATE"
run_full_state NC "North Carolina" NORTH_CAROLINA "$BATCHDATE"
run_full_state SC "South Carolina" SOUTH_CAROLINA "$BATCHDATE"

say "########## BATCH COMPLETE ##########"
