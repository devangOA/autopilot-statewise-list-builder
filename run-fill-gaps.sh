#!/bin/bash
# Close discovery gaps left by rate-limit starvation in the first pass.
# Resuming discovery+enrichment on the same cache is safe and cheap: already-
# done queries and already-attempted domains are skipped, only the missing
# queries run, and any newly discovered sites get enriched. Then re-run
# needs-review re-verification and rebuild so the deliverables reflect
# whatever the gap-fill finds.
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO" || exit 1
export PATH="/c/Program Files/nodejs:$PATH"
LOG="$REPO/fillgaps.log"
BATCHDATE=20260810

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

fill_state() {
  local CODE=$1 NAME=$2 UPPER=$3
  local LOWER; LOWER=$(echo "$CODE" | tr 'A-Z' 'a-z')

  say "===== $NAME ($CODE) gap-fill starting ====="

  say "$CODE phase 1/3  resume discovery + enrichment (fills starved queries)"
  node src/index.js --state "$CODE" --all-templates \
    --out "${UPPER}_INDOOR_COURT_FACILITIES.csv" \
    --cache ".cache-${LOWER}" \
    --discovery-concurrency 3 --concurrency 2 >> "$LOG" 2>&1
  say "$CODE phase 1 done"

  say "$CODE phase 2/3  needs-review re-verification (re-run over any new facilities)"
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

  say "$CODE phase 3/3  rebuilding deliverables + commit"
  node src/n8n.js --state "$CODE" \
    --in "${UPPER}_INDOOR_COURT_FACILITIES.csv" \
    --contacts ".cache-${LOWER}/rows.json" \
    --upgrades ".cache-${LOWER}review/rows.json" \
    --out "${CODE}_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv" \
    --locations "${CODE}_INDOOR_COURTS_LOCATIONS.csv" \
    --review "${CODE}_INDOOR_COURTS_NEEDS_REVIEW.csv" \
    --track-id "${CODE}-COURTS-001" --batch "${CODE}-COURTS-${BATCHDATE}-B003" >> "$LOG" 2>&1

  git add "${UPPER}_INDOOR_COURT_FACILITIES.csv" \
    "${CODE}_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv" \
    "${CODE}_INDOOR_COURTS_LOCATIONS.csv" "${CODE}_INDOOR_COURTS_NEEDS_REVIEW.csv" 2>>"$LOG"
  if ! git diff --cached --quiet 2>>"$LOG"; then
    git commit -q -m "Fill discovery gaps for ${NAME} left by rate-limit starvation

The first pass logged every planned query but some were starved by shared
search-engine rate limits and never actually ran (not marked done, so never
retried within that single pass). Resumed discovery+enrichment on the same
cache to run only the missing queries and enrich anything new they found,
then rebuilt the deliverables.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>" >> "$LOG" 2>&1
    say "===== $NAME gap-fill complete, committed ====="
  else
    say "===== $NAME gap-fill complete, nothing changed ====="
  fi
}

say "########## GAP-FILL: WA -> AZ -> NV -> OR ##########"

fill_state WA Washington WASHINGTON
fill_state AZ Arizona ARIZONA
fill_state NV Nevada NEVADA
fill_state OR Oregon OREGON

say "########## GAP-FILL COMPLETE ##########"
