#!/usr/bin/env bash
set -euo pipefail

nco_db="/Users/nova-ai/project/nco/db/nco.db"
ax_db="/Users/nova-ai/project/nova-ax/db/nova-ax.db"
artifact="/Users/nova-ai/project/nco/data/team-runner/team_tech-port-07-value-gate-report-2026-07-23.md"

target_status="$(sqlite3 -readonly "$nco_db" \
  "SELECT status FROM tasks WHERE id='task_QWziltLgea4US5tr';")"
target_verification="$(sqlite3 -readonly "$nco_db" \
  "SELECT json_extract(metadata_json,'$.verificationStatus') FROM tasks WHERE id='task_QWziltLgea4US5tr';")"
prior_binding="$(sqlite3 -readonly "$nco_db" \
  "SELECT status || '|' || json_extract(metadata_json,'$.verificationStatus') || '|' || json_extract(metadata_json,'$.verificationReceiptId') FROM tasks WHERE id='task_pximRcfB6RefFcJF';")"
prior_run="$(sqlite3 -readonly "$ax_db" \
  "SELECT status || '|' || passed_institutions || '|' || json_array_length(results_json) || '|' || (SELECT COUNT(*) FROM json_each(results_json) WHERE json_extract(value,'$.passed')=1) FROM verification_runs WHERE id='vrun_9e1ec892-98cb-45bc-b9be-20c311740d1e';")"
receipt_consumptions="$(sqlite3 -readonly "$ax_db" \
  "SELECT COUNT(*) FROM verification_receipt_consumptions WHERE receipt_id='vrcpt_0933c4d8-1190-4dba-8855-bca47c09d95b';")"
loop_result="$(sqlite3 -readonly "$ax_db" \
  "SELECT l.status || '|' || a.decision FROM verification_loops l JOIN verification_loop_attempts a ON a.loop_id=l.id WHERE l.id='vloop_4c2e82d4-6d1b-42d9-a1ec-4b69d295e26a' AND a.id='vattempt_7d6d1614-18c3-4038-8edd-8a628cdc4359';")"
artifact_hash="$(shasum -a 256 "$artifact" | awk '{print $1}')"
response_hash="$(sqlite3 -readonly "$nco_db" \
  "SELECT response FROM tasks WHERE id='task_QWziltLgea4US5tr';" | shasum -a 256 | awk '{print $1}')"
target_runs="$(sqlite3 -readonly "$ax_db" \
  "SELECT COUNT(*) FROM verification_runs WHERE task_id='task_QWziltLgea4US5tr';")"
target_receipts="$(sqlite3 -readonly "$ax_db" \
  "SELECT COUNT(*) FROM verification_receipts WHERE task_id='task_QWziltLgea4US5tr';")"
scope_open_loops="$(sqlite3 -readonly "$ax_db" \
  "SELECT COUNT(*) FROM verification_loops WHERE company_id='org_technology-porting' AND team_id='team_tech-port-07-value-gate-report' AND status IN ('action_required','resubmitted');")"
latest_submitted="$(sqlite3 -readonly "$nco_db" \
  "SELECT COUNT(*) FROM work_reports WHERE report_date='2026-07-30' AND status='submitted' AND ((subject_kind='organization' AND subject_id='org_technology-porting') OR (subject_kind='team' AND subject_id='team_tech-port-07-value-gate-report'));")"
unreceived_reports="$(sqlite3 -readonly "$nco_db" \
  "SELECT COUNT(*) FROM work_reports WHERE status IN ('missed','pending') AND ((subject_kind='organization' AND subject_id='org_technology-porting') OR (subject_kind='team' AND subject_id='team_tech-port-07-value-gate-report'));")"

test "$target_status" = "reviewing"
test "$target_verification" = "pending"
test "$prior_binding" = "completed|approved|vrcpt_0933c4d8-1190-4dba-8855-bca47c09d95b"
test "$prior_run" = "approved|6|6|6"
test "$receipt_consumptions" = "1"
test "$loop_result" = "completed|approved"
test "$artifact_hash" = "dc5475cdbab96a2234067260082c859eb8a2caa3612ce19748852c478e25a1b7"
test "$response_hash" = "578c5128ba53cc69bf1b6f3b2a9980c566be38793f1dd3a797f4bdf4e497a380"
test "$target_runs" = "0"
test "$target_receipts" = "0"
test "$scope_open_loops" = "0"
test "$latest_submitted" = "4"
test "$unreceived_reports" = "10"

printf '%s\n' \
  "ground_truth_assertions=13/13" \
  "target_status=$target_status" \
  "target_verification=$target_verification" \
  "target_runs=$target_runs" \
  "target_receipts=$target_receipts" \
  "scope_open_loops=$scope_open_loops" \
  "latest_2026-07-30_reports_submitted=$latest_submitted/4" \
  "historical_unreceived_reports=$unreceived_reports" \
  "response_export_sha256=$response_hash" \
  "artifact_sha256=$artifact_hash"
