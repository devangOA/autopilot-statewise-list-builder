#!/bin/zsh
# Unattended end-to-end run for one state.
#
#   ./run-state.sh PA "Pennsylvania" PENNSYLVANIA 20260806
#
# Phases: discovery -> enrichment -> needs-review re-verification -> build ->
# copy to the Desktop folder -> commit. Every phase resumes from its own cache,
# so an interruption costs minutes rather than work.
set -u
CODE=$1            # PA
NAME=$2            # Pennsylvania
UPPER=$3           # PENNSYLVANIA  (master CSV prefix)
BATCHDATE=$4       # 20260806
LOWER=$(echo "$CODE" | tr 'A-Z' 'a-z')

REPO=~/dev/autopilot-statewise-list-builder
DESK=~/Desktop/autopilot-statewise-list-builder
LOG=/tmp/${LOWER}-run.log
cd "$REPO" || exit 1

say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

say "===== $NAME ($CODE) starting ====="

# ---------------------------------------------------------------- discovery +
# enrichment. One process: discovery fans out queries, then enrichment crawls
# every domain it found. Two workers each, one Scrapling fallback worker.
say "phase 1/4  discovery + enrichment"
# --all-templates: every market gets all 31 query angles, no tiering. Three
# discovery workers rather than two -- the machine is otherwise idle and the
# binding constraint is engine rate limits, which the shared cooldown handles.
node src/index.js --state "$CODE" --all-templates \
  --out "${UPPER}_INDOOR_COURT_FACILITIES.csv" \
  --cache ".cache-${LOWER}" \
  --discovery-concurrency 3 --concurrency 2 >> "$LOG" 2>&1
say "phase 1 done: $(grep -c '^' "${UPPER}_INDOOR_COURT_FACILITIES.csv" 2>/dev/null) lines in master"

# --------------------------------------------------- needs-review re-verify.
# A deeper crawl (12 pages, indoor-focused hints) over facilities the first
# pass left unresolved. Anything that now shows indoor evidence is promoted.
say "phase 2/4  needs-review re-verification"
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
say "phase 2 done"

# ------------------------------------------------------------------- build.
say "phase 3/4  building candidate-email CSVs"
node src/n8n.js --state "$CODE" \
  --in "${UPPER}_INDOOR_COURT_FACILITIES.csv" \
  --contacts ".cache-${LOWER}/rows.json" \
  --upgrades ".cache-${LOWER}review/rows.json" \
  --out "${CODE}_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv" \
  --locations "${CODE}_INDOOR_COURTS_LOCATIONS.csv" \
  --review "${CODE}_INDOOR_COURTS_NEEDS_REVIEW.csv" \
  --track-id "${CODE}-COURTS-001" --batch "${CODE}-COURTS-${BATCHDATE}-B001" >> "$LOG" 2>&1
say "phase 3 done"

# ------------------------------------------------- copy out, then persist it.
say "phase 4/4  copying to Desktop folder and committing"
for f in "${UPPER}_INDOOR_COURT_FACILITIES.csv" \
         "${CODE}_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv" \
         "${CODE}_INDOOR_COURTS_LOCATIONS.csv" \
         "${CODE}_INDOOR_COURTS_NEEDS_REVIEW.csv"; do
  [ -f "$f" ] && cp "$f" "$DESK/$f" 2>/dev/null && say "  copied $f"
done

git add -A src/ test/ "${UPPER}_INDOOR_COURT_FACILITIES.csv" \
  "${CODE}_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv" \
  "${CODE}_INDOOR_COURTS_LOCATIONS.csv" "${CODE}_INDOOR_COURTS_NEEDS_REVIEW.csv" 2>/dev/null
git commit -q -m "Add ${NAME} indoor-court dataset and n8n candidate-email CSV

Full statewide crawl: discovery across every ${NAME} market, enrichment of
every candidate domain, then a deeper re-verification pass over the facilities
the first crawl left as Needs Review.

Non-facility organizations, weak location evidence and page-furniture company
names are filtered at build time, so the master CSV stays a faithful record of
what was crawled.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" >> "$LOG" 2>&1
git push -u origin "$(git rev-parse --abbrev-ref HEAD)" >> "$LOG" 2>&1
say "===== $NAME complete ====="
