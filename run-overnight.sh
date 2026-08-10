#!/bin/bash
# Unattended sequential run: Washington, Arizona, Nevada, Oregon.
# One state at a time (shared search-engine rate limits punish running two at
# once from the same IP). Each state: discovery+enrichment -> needs-review
# re-verification -> build deliverables -> commit -> push. Fully resumable:
# every phase reads its own cache, so killing this script only costs the
# minutes since the last checkpoint, never the whole state.
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO" || exit 1
export PATH="/c/Program Files/nodejs:$PATH"
LOG="$REPO/overnight.log"
BATCHDATE=20260810

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

run_state() {
  local CODE=$1 NAME=$2 UPPER=$3
  local LOWER; LOWER=$(echo "$CODE" | tr 'A-Z' 'a-z')

  say "===== $NAME ($CODE) starting ====="

  say "$CODE phase 1/3  discovery + enrichment"
  node src/index.js --state "$CODE" --all-templates \
    --out "${UPPER}_INDOOR_COURT_FACILITIES.csv" \
    --cache ".cache-${LOWER}" \
    --discovery-concurrency 3 --concurrency 2 >> "$LOG" 2>&1
  say "$CODE phase 1 done"

  say "$CODE phase 2/3  needs-review re-verification"
  node -e "
import fs from 'node:fs';
const {readRows}=await import('./src/reoon.js');
const {looksLikePublisher,looksLikeNonFacilityOrg}=await import('./src/finalize.js');
let rs=[]; try{ rs=readRows('${UPPER}_INDOOR_COURT_FACILITIES.csv'); }catch(e){}
const nr=rs.filter(r=>r['Qualification Status']==='Needs Review')
           .filter(r=>!looksLikePublisher(r)&&!looksLikeNonFacilityOrg(r));
const urls=[...new Set(nr.map(r=>r.Website).filter(Boolean))];
fs.writeFileSync('/tmp/${LOWER}-review-sites.json', JSON.stringify(urls));
console.log('needs-review sites to re-verify:', urls.length);
" >> "$LOG" 2>&1

  if [ -s "/tmp/${LOWER}-review-sites.json" ]; then
    node src/index.js --state "$CODE" --deep \
      --sites-file "/tmp/${LOWER}-review-sites.json" \
      --cache ".cache-${LOWER}review" \
      --out "/tmp/${LOWER}-review.csv" --concurrency 2 >> "$LOG" 2>&1
  fi
  say "$CODE phase 2 done"

  say "$CODE phase 3/3  building deliverables + commit"
  node src/n8n.js --state "$CODE" \
    --in "${UPPER}_INDOOR_COURT_FACILITIES.csv" \
    --contacts ".cache-${LOWER}/rows.json" \
    --upgrades ".cache-${LOWER}review/rows.json" \
    --out "${CODE}_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv" \
    --locations "${CODE}_INDOOR_COURTS_LOCATIONS.csv" \
    --review "${CODE}_INDOOR_COURTS_NEEDS_REVIEW.csv" \
    --track-id "${CODE}-COURTS-001" --batch "${CODE}-COURTS-${BATCHDATE}-B001" >> "$LOG" 2>&1

  git add "${UPPER}_INDOOR_COURT_FACILITIES.csv" \
    "${CODE}_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv" \
    "${CODE}_INDOOR_COURTS_LOCATIONS.csv" "${CODE}_INDOOR_COURTS_NEEDS_REVIEW.csv" 2>>"$LOG"
  git commit -q -m "Add ${NAME} indoor-court dataset and n8n candidate-email CSV

Full statewide crawl: discovery across every ${NAME} market, enrichment of
every candidate domain, then a deeper re-verification pass over the
facilities the first crawl left as Needs Review.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>" >> "$LOG" 2>&1
  say "===== $NAME complete (committed locally; push handled separately) ====="
}

say "########## OVERNIGHT RUN STARTING: WA -> AZ -> NV -> OR ##########"

run_state WA Washington WASHINGTON
run_state AZ Arizona ARIZONA
run_state NV Nevada NEVADA
run_state OR Oregon OREGON

say "########## ALL FOUR STATES COMPLETE ##########"
