#!/bin/bash
# Catch-up run: phase 1 (discovery+enrichment) already completed and is cached
# for WA/AZ/NV/OR. This runs only phase 2 (needs-review re-verification, which
# silently no-op'd due to a /tmp path bug) and phase 3 (rebuild deliverables
# with the --upgrades pass, then commit) for each.
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO" || exit 1
export PATH="/c/Program Files/nodejs:$PATH"
LOG="$REPO/reverify.log"
BATCHDATE=20260810

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

reverify_state() {
  local CODE=$1 NAME=$2 UPPER=$3
  local LOWER; LOWER=$(echo "$CODE" | tr 'A-Z' 'a-z')

  say "===== $NAME ($CODE) re-verification starting ====="

  say "$CODE phase 2/3  needs-review re-verification"
  node -e "
import fs from 'node:fs';
const {readRows}=await import('./src/reoon.js');
const {looksLikePublisher,looksLikeNonFacilityOrg}=await import('./src/finalize.js');
let rs=[]; try{ rs=readRows('${UPPER}_INDOOR_COURT_FACILITIES.csv'); }catch(e){}
const nr=rs.filter(r=>r['Qualification Status']==='Needs Review')
           .filter(r=>!looksLikePublisher(r)&&!looksLikeNonFacilityOrg(r));
const urls=[...new Set(nr.map(r=>r.Website).filter(Boolean))];
fs.mkdirSync('.tmp', {recursive: true});
fs.writeFileSync('.tmp/${LOWER}-review-sites.json', JSON.stringify(urls));
console.log('needs-review sites to re-verify:', urls.length);
" >> "$LOG" 2>&1

  if [ -s ".tmp/${LOWER}-review-sites.json" ]; then
    node src/index.js --state "$CODE" --deep \
      --sites-file ".tmp/${LOWER}-review-sites.json" \
      --cache ".cache-${LOWER}review" \
      --out ".tmp/${LOWER}-review.csv" --concurrency 2 >> "$LOG" 2>&1
  fi
  say "$CODE phase 2 done"

  say "$CODE phase 3/3  rebuilding deliverables with upgrades + commit"
  node src/n8n.js --state "$CODE" \
    --in "${UPPER}_INDOOR_COURT_FACILITIES.csv" \
    --contacts ".cache-${LOWER}/rows.json" \
    --upgrades ".cache-${LOWER}review/rows.json" \
    --out "${CODE}_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv" \
    --locations "${CODE}_INDOOR_COURTS_LOCATIONS.csv" \
    --review "${CODE}_INDOOR_COURTS_NEEDS_REVIEW.csv" \
    --track-id "${CODE}-COURTS-001" --batch "${CODE}-COURTS-${BATCHDATE}-B002" >> "$LOG" 2>&1

  git add "${UPPER}_INDOOR_COURT_FACILITIES.csv" \
    "${CODE}_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv" \
    "${CODE}_INDOOR_COURTS_LOCATIONS.csv" "${CODE}_INDOOR_COURTS_NEEDS_REVIEW.csv" 2>>"$LOG"
  if ! git diff --cached --quiet 2>>"$LOG"; then
    git commit -q -m "Re-verify ${NAME} Needs Review facilities with a deeper crawl

The first pass over ${NAME} never actually ran its needs-review
re-verification step (a /tmp path bug on Windows made it silently no-op).
This re-runs it: a 12-page, indoor-focused re-crawl of every remaining
Needs Review facility, promoting any that now show indoor/outdoor evidence
into the qualified deliverable and rebuilding the candidate-email CSV.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>" >> "$LOG" 2>&1
    say "===== $NAME re-verification complete, committed ====="
  else
    say "===== $NAME re-verification complete, nothing changed ====="
  fi
}

say "########## RE-VERIFICATION CATCH-UP: WA -> AZ -> NV -> OR ##########"

reverify_state WA Washington WASHINGTON
reverify_state AZ Arizona ARIZONA
reverify_state NV Nevada NEVADA
reverify_state OR Oregon OREGON

say "########## RE-VERIFICATION CATCH-UP COMPLETE ##########"
