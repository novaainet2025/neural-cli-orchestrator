#!/bin/bash
set -euo pipefail
TEAM="team_tech-port-02-safety-license"
BASE="http://localhost:6200"

submit_one() {
  local date="$1"
  local slot="$2"
  local file="/Users/nova-ai/project/nco/data/team-runner/${TEAM}-${date}.md"
  local json
  json=$(curl -sS "${BASE}/api/work-reports?date=${date}&slot=${slot}")
  # Extract report id for our team from JSON without jq
  local id
  id=$(printf '%s' "$json" | sed -n "s/.*\"id\":\"\(wr_[^\"]*\)\"[^}]*\"subjectId\":\"${TEAM}\".*/\1/p" | head -1)
  if [ -z "$id" ]; then
    echo "NO_REPORT for ${date} ${slot}"
    return 1
  fi
  local body
  body=$(cat "$file")
  local payload
  payload=$(printf '{"title":"Safety License daily report","bodyMd":%s}' "$(python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' <<<"$body")")
  echo "Submitting ${id} (${date} ${slot})..."
  curl -sS -X POST "${BASE}/api/work-reports/${id}/submit" \
    -H "Content-Type: application/json" \
    -d "$payload"
  echo ""
}

submit_one "2026-07-25" "pm"
submit_one "2026-07-26" "am"

echo "STATUS_COUNTS:"
curl -sS "${BASE}/api/work-reports/range?from=2026-07-23&to=2026-07-30" | python3 -c "
import json,sys
d=json.load(sys.stdin)
team='team_tech-port-02-safety-license'
rows=[r for r in d.get('reports',[]) if r.get('subjectId')==team]
from collections import Counter
c=Counter(r['status'] for r in rows)
print(dict(c))
for r in rows:
    if r['status']=='missed':
        print('STILL_MISSED', r['reportDate'], r['reportSlot'], r['id'])
"
