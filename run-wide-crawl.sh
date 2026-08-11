#!/bin/bash
# Contact-yield pass: re-enrich every already-qualified (and needs-review)
# facility with --wide (12 pages, contact-oriented hints, unlike --deep's
# indoor-evidence hints) to find named people/emails on sites with deeper
# structures than the original 6-page crawl reached. Scoped to facilities
# already in the master CSV, not the full discovered-domain set, since
# "Not Qualified" sites never reach the deliverable regardless of contacts.
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO" || exit 1
export PATH="/c/Program Files/nodejs:$PATH"
LOG="$REPO/widecrawl.log"
BATCHDATE=20260810

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

wide_state() {
  local CODE=$1 NAME=$2 UPPER=$3
  local LOWER; LOWER=$(echo "$CODE" | tr 'A-Z' 'a-z')

  say "===== $NAME ($CODE) wide contact crawl starting ====="

  say "$CODE step 1/2  building site list from current master CSV"
  node -e "
import fs from 'node:fs';
const {readRows}=await import('./src/reoon.js');
let rs=[]; try{ rs=readRows('${UPPER}_INDOOR_COURT_FACILITIES.csv'); }catch(e){}
const urls=[...new Set(rs.map(r=>r.Website).filter(Boolean))];
fs.mkdirSync('.tmp', {recursive: true});
fs.writeFileSync('.tmp/${LOWER}-wide-sites.json', JSON.stringify(urls));
console.log('facilities to re-crawl wide:', urls.length);
" >> "$LOG" 2>&1

  say "$CODE step 2/2  wide re-crawl (12 pages, contact hints, concurrency 2)"
  node src/index.js --state "$CODE" --wide \
    --sites-file ".tmp/${LOWER}-wide-sites.json" \
    --cache ".cache-${LOWER}wide" \
    --out ".tmp/${LOWER}-wide.csv" --concurrency 2 >> "$LOG" 2>&1
  say "$CODE wide re-crawl done"

  say "$CODE rebuilding deliverables with merged contact data + commit"
  node src/n8n.js --state "$CODE" \
    --in "${UPPER}_INDOOR_COURT_FACILITIES.csv" \
    --contacts ".cache-${LOWER}/rows.json" \
    --contacts2 ".cache-${LOWER}wide/rows.json" \
    --upgrades ".cache-${LOWER}review/rows.json" \
    --out "${CODE}_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv" \
    --locations "${CODE}_INDOOR_COURTS_LOCATIONS.csv" \
    --review "${CODE}_INDOOR_COURTS_NEEDS_REVIEW.csv" \
    --track-id "${CODE}-COURTS-001" --batch "${CODE}-COURTS-${BATCHDATE}-B004" >> "$LOG" 2>&1

  git add "${UPPER}_INDOOR_COURT_FACILITIES.csv" \
    "${CODE}_INDOOR_COURTS_N8N_READY_WITH_CANDIDATE_EMAILS.csv" \
    "${CODE}_INDOOR_COURTS_LOCATIONS.csv" "${CODE}_INDOOR_COURTS_NEEDS_REVIEW.csv" 2>>"$LOG"
  if ! git diff --cached --quiet 2>>"$LOG"; then
    git commit -q -m "Widen the contact-page crawl for ${NAME} to find more emails/contacts

Re-enriched every qualified and needs-review ${NAME} facility with --wide
(12 interior pages using the default contact-oriented hints -- contact,
staff, team, leadership, directory, membership -- rather than --deep's
indoor-evidence hints). Sites with deeper structures than the original
6-page crawl reached may now show a published email or named person they
didn't before. Merged on top of the original contact pass; whichever pass
found more for a given facility wins.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>" >> "$LOG" 2>&1
    say "===== $NAME wide crawl complete, committed ====="
  else
    say "===== $NAME wide crawl complete, nothing changed ====="
  fi
}

say "########## WIDE CONTACT CRAWL: WA -> AZ -> NV -> OR ##########"

wide_state WA Washington WASHINGTON
wide_state AZ Arizona ARIZONA
wide_state NV Nevada NEVADA
wide_state OR Oregon OREGON

say "########## WIDE CONTACT CRAWL COMPLETE ##########"
