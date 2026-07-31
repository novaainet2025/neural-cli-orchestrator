#!/bin/bash
DB="/Users/nova-ai/project/nova-ax/db/nova-ax.db"

echo "=== Query 1 ==="
sqlite3 "$DB" "SELECT id, task_id, status, passed_institutions, evidence_digest, created_at FROM verification_runs WHERE id='vrun_d9338941-4f11-42ea-b297-7d7a2f5c7cac';"

echo "=== Query 2 ==="
sqlite3 "$DB" "SELECT id, run_id, task_id, evidence_digest, issued_at FROM verification_receipts WHERE id='vrcpt_7a8085a3-ae44-43ae-9c87-da4d7b88a5ca';"

echo "=== Query 3 ==="
sqlite3 "$DB" "SELECT id, receipt_id, event_id, consumed_at FROM verification_receipt_consumptions WHERE receipt_id='vrcpt_7a8085a3-ae44-43ae-9c87-da4d7b88a5ca';"

echo "=== Query 4 ==="
sqlite3 "$DB" "SELECT id, task_id, status, type FROM verification_directives WHERE id='vdir_fbcc1e20-b7e8-43e0-b53c-0f301281b7d6';"

echo "=== Query 5 ==="
sqlite3 "$DB" "SELECT id, action, receipt_id, task_id FROM activity_log WHERE id='axevt_hr_director_audit_cycle1_c6afc6a6-abde-4779-a1a6-833333fd1198';"

echo "=== Query 6 ==="
sqlite3 "$DB" "SELECT COUNT(*) FROM verification_loops WHERE company_id='org_nova-ax' AND team_id='team_hr-director' AND status IN ('action_required','resubmitted');"

echo "=== Query 7 ==="
shasum -a 256 /Users/nova-ai/project/nova-ax/evidence/org_nova-ax/team_hr-director/2026-07-30/hr-director-audit-bundle-cycle1.json
