#!/bin/sh
set -e
cd /Users/nova-ai/project/nco

echo "=== STEP 1 ==="
sqlite3 db/nco.db "SELECT id, report_date, report_slot, status, length(coalesce(body_md,'')) as body_len FROM work_reports WHERE team_id='team_tech-port-02-safety-license' ORDER BY report_date, report_slot;"

echo "=== STEP 2 ==="
node data/fix-safety-license-reports.mjs

echo "=== STEP 3 ==="
sqlite3 db/nco.db "SELECT id, report_date, report_slot, status, length(coalesce(body_md,'')) as body_len FROM work_reports WHERE team_id='team_tech-port-02-safety-license' ORDER BY report_date, report_slot;"

echo "=== STEP 4 ==="
node data/nova-ax-audit-staging/org_technology-porting/team_tech-port-02-safety-license/2026-07-30/run-safety-license-audit.mjs
