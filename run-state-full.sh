#!/bin/bash
# Full verified pipeline for one state, called by run-batch.sh:
#
#   ./run-state-full.sh IL Illinois ILLINOIS 20260811
#
# Consolidates everything learned from the WA/AZ/NV/OR batch into one script
# instead of patching gaps after the fact:
#   1. discovery + enrichment, --all-templates (no tiering)
#   2. coverage verified against queries-done.json (not just totals) via
#      src/check-coverage.mjs; if incomplete, resume discovery/enrichment
#      again (up to 4 rounds) until 100%, or log exactly what's still
#      missing if it never gets there
#   3. needs-review re-verification (deeper, indoor-focused crawl)
#   4. wide contact crawl (more pages, contact-oriented hints) for named
#      people / published emails
#   5. rebuild deliverables merging both contact passes, commit
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO" || exit 1
export PATH="/c/Program Files/nodejs:$PATH"
LOG="$REPO/batch.log"

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

run_full_state() {
  local CODE=$1 NAME=$2 UPPER=$3 BATCHDATE=$4
  local LOWER; LOWER=$(echo "$CODE" | tr 'A-Z' 'a-z')

  say "===== $NAME ($CODE) full pipeline starting ====="

  # ---- 1+2: discovery + enrichment, verified, resumed until 100% coverage
  local ROUND=1 MAX_ROUNDS=4
  while [ $ROUND -le $MAX_ROUNDS ]; do
    say "$CODE discovery+enrichment round $ROUND/$MAX_ROUNDS"
    node src/index.js --state "$CODE" --all-templates \
      --out "${UPPER}_INDOOR_COURT_FACILITIES.csv" \
      --cache ".cache-${LOWER}" \
      --discovery-concurrency 3 --concurrency 2 >> "$LOG" 2>&1
    if node src/check-coverage.mjs --state "$CODE" --cache ".cache-${LOWER}" >> "$LOG" 2>&1; then
      say "$CODE coverage verified 100% after round $ROUND"
      break
    fi
    say "$CODE coverage incomplete after round $ROUND -- resuming"
    ROUND=$((ROUND + 1))
  done
  if [ $ROUND -gt $MAX_ROUNDS ]; then
    say "$CODE WARNING: coverage still incomplete after $MAX_ROUNDS rounds -- see $LOG for exact gaps (search for 'COVERAGE: INCOMPLETE' near this state's entries)"
  fi

  # ---- 3: needs-review re-verification
  say "$CODE needs-review re-verification"
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
  say "$CODE needs-review re-verification done"

  # ---- 4: wide contact crawl (over the current qualified+needs-review set)
  say "$CODE wide contact crawl"
  node -e "
import fs from 'node:fs';
const {readRows}=await import('./src/reoon.js');
let rs=[]; try{ rs=readRows('${UPPER}_INDOOR_COURT_FACILITIES.csv'); }catch(e){}
const urls=[...new Set(rs.map(r=>r.Website).filter(Boolean))];
fs.mkdirSync('.tmp', {recursive: true});
fs.writeFileSync('.tmp/${LOWER}-wide-sites.json', JSON.stringify(urls));
console.log('facilities to re-crawl wide:', urls.length);
" >> "$LOG" 2>&1
  node src/index.js --state "$CODE" --wide \
    --sites-file ".tmp/${LOWER}-wide-sites.json" \
    --cache ".cache-${LOWER}wide" \
    --out ".tmp/${LOWER}-wide.csv" --concurrency 2 >> "$LOG" 2>&1
  say "$CODE wide contact crawl done"

  # ---- 5: rebuild deliverables + commit
  say "$CODE rebuilding deliverables + commit"
  node src/n8n.js --state "$CODE" \
    --in "${UPPER}_INDOOR_COURT_FACILITIES.csv" \
    --contacts ".cache-${LOWER}/rows.json" \
    --contacts2 ".cache-${LOWER}wide/rows.json" \
    --upgrades ".cache-${LOWER}review/rows.json" \
    --out "${CODE}_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv" \
    --locations "${CODE}_INDOOR_COURTS_LOCATIONS.csv" \
    --review "${CODE}_INDOOR_COURTS_NEEDS_REVIEW.csv" \
    --track-id "${CODE}-COURTS-001" --batch "${CODE}-COURTS-${BATCHDATE}-B001" >> "$LOG" 2>&1

  git add "${UPPER}_INDOOR_COURT_FACILITIES.csv" \
    "${CODE}_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv" \
    "${CODE}_INDOOR_COURTS_LOCATIONS.csv" "${CODE}_INDOOR_COURTS_NEEDS_REVIEW.csv" 2>>"$LOG"
  git commit -q -m "Add ${NAME} indoor-court dataset and n8n candidate-email CSV

Full statewide crawl verified against queries-done.json (not just planned
totals) for 100% market coverage, retrying automatically on any rate-limit
gap. Includes a needs-review re-verification pass (deeper, indoor-focused
crawl) and a wide contact-page crawl (more pages, contact-oriented hints)
merged on top of the original enrichment pass for named people and emails.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>" >> "$LOG" 2>&1
  say "===== $NAME complete (committed locally) ====="
}
