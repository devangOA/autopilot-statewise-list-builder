#!/bin/bash
# Full verified pipeline for Utah alone.
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO" || exit 1
source ./run-state-full.sh
BATCHDATE=20260813

say "########## UTAH ##########"
run_full_state UT Utah UTAH "$BATCHDATE"
say "########## UTAH COMPLETE ##########"
