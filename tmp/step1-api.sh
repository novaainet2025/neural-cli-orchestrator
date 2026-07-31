#!/bin/sh
TEAM=team_tech-port-02-safety-license
BASE=http://localhost:6200
for d in 2026-07-24 2026-07-25 2026-07-26 2026-07-27 2026-07-28 2026-07-29 2026-07-30; do
  for s in am pm; do
    json=$(curl -s "${BASE}/api/work-reports?date=${d}&slot=${s}&org=org_technology-porting")
    id=$(printf '%s' "$json" | sed -n "s/.*\"id\":\"\(wr_[^\"]*\)\"[^}]*\"subjectId\":\"${TEAM}\".*/\1/p" | head -1)
    status=$(printf '%s' "$json" | sed -n "s/.*\"subjectId\":\"${TEAM}\"[^}]*\"status\":\"\([^\"]*\)\".*/\1/p" | head -1)
    body=$(printf '%s' "$json" | sed -n "s/.*\"subjectId\":\"${TEAM}\"[^}]*\"bodyMd\":\(null\|\"[^\"]*\"\).*/\1/p" | head -1)
    if [ -n "$id" ]; then
      if [ "$body" = "null" ] || [ -z "$body" ]; then blen=0; else blen=1; fi
      echo "${id}|${d}|${s}|${status}|${blen}"
    fi
  done
done
