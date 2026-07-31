#!/usr/bin/env bash
set -euo pipefail

nco_db="/Users/nova-ai/project/nco/db/nco.db"
ax_db="/Users/nova-ai/project/nova-ax/db/nova-ax.db"
artifact="/Users/nova-ai/project/nco/data/team-runner/team_tech-port-07-value-gate-report-2026-07-23.md"
target_task="task_RDSFWmojiQWyLIVZ"
source_task="task_n6fEyN7Da3AS2l3X"
company_id="org_technology-porting"
team_id="team_tech-port-07-value-gate-report"

target_status="$(sqlite3 -readonly "$nco_db" \
  "SELECT status FROM tasks WHERE id='$target_task';")"
target_verification="$(sqlite3 -readonly "$nco_db" \
  "SELECT json_extract(metadata_json,'$.verificationStatus') FROM tasks WHERE id='$target_task';")"
source_status="$(sqlite3 -readonly "$nco_db" \
  "SELECT status FROM tasks WHERE id='$source_task';")"
source_verification="$(sqlite3 -readonly "$nco_db" \
  "SELECT json_extract(metadata_json,'$.verificationStatus') FROM tasks WHERE id='$source_task';")"
target_runs="$(sqlite3 -readonly "$ax_db" \
  "SELECT COUNT(*) FROM verification_runs WHERE task_id='$target_task';")"
target_receipts="$(sqlite3 -readonly "$ax_db" \
  "SELECT COUNT(*) FROM verification_receipts WHERE task_id='$target_task';")"
target_loops="$(sqlite3 -readonly "$ax_db" \
  "SELECT COUNT(*) FROM verification_loops WHERE task_id='$target_task';")"
scope_open_loops="$(sqlite3 -readonly "$ax_db" \
  "SELECT COUNT(*) FROM verification_loops WHERE company_id='$company_id' AND team_id='$team_id' AND status IN ('action_required','resubmitted');")"
target_directive="$(sqlite3 -readonly "$ax_db" \
  "SELECT status || '|' || COALESCE(task_id,'') || '|' || attempt_count FROM verification_directives WHERE subject_task_id='$target_task' ORDER BY created_at DESC LIMIT 1;")"
prior_receipt="$(sqlite3 -readonly "$ax_db" \
  "SELECT task_id || '|' || (SELECT COUNT(*) FROM verification_receipt_consumptions c WHERE c.receipt_id=r.id) FROM verification_receipts r WHERE id='vrcpt_0933c4d8-1190-4dba-8855-bca47c09d95b';")"
prior_loop="$(sqlite3 -readonly "$ax_db" \
  "SELECT l.status || '|' || a.decision FROM verification_loops l JOIN verification_loop_attempts a ON a.loop_id=l.id WHERE l.id='vloop_4c2e82d4-6d1b-42d9-a1ec-4b69d295e26a' AND a.id='vattempt_7d6d1614-18c3-4038-8edd-8a628cdc4359';")"
unreceived_reports="$(sqlite3 -readonly "$nco_db" \
  "SELECT COUNT(*) FROM work_reports WHERE status IN ('missed','pending') AND ((subject_kind='organization' AND subject_id='$company_id') OR (subject_kind='team' AND subject_id='$team_id'));")"
artifact_hash="$(shasum -a 256 "$artifact" | awk '{print $1}')"
target_response_hash="$(sqlite3 -readonly "$nco_db" \
  "SELECT response FROM tasks WHERE id='$target_task';" | shasum -a 256 | awk '{print $1}')"

set +e
nco_http="$(curl -sS --connect-timeout 1 -o /dev/null -w '%{http_code}' http://localhost:6200/api/tasks/"$target_task" 2>/dev/null)"
nco_curl_exit=$?
ax_http="$(curl -sS --connect-timeout 1 -o /dev/null -w '%{http_code}' http://localhost:6300/api/health 2>/dev/null)"
ax_curl_exit=$?
set -e

test "$target_status" = "reviewing"
test "$target_verification" = "pending"
test "$source_status" = "reviewing"
test "$source_verification" = "pending"
test "$target_runs" = "0"
test "$target_receipts" = "0"
test "$target_loops" = "0"
test "$scope_open_loops" = "0"
test "$target_directive" = "dispatched|task_NaAusuFjzF6IyL3n|3"
test "$prior_receipt" = "task_pximRcfB6RefFcJF|1"
test "$prior_loop" = "completed|approved"
test "$unreceived_reports" = "10"
test "$artifact_hash" = "dc5475cdbab96a2234067260082c859eb8a2caa3612ce19748852c478e25a1b7"
test "$target_response_hash" = "60083b8e7c77d15ef386e22ee968b24c08720674ae1270a22d9dce5ce60532f9"
test "$nco_curl_exit" -ne 0
test "$ax_curl_exit" -ne 0

printf '%s\n' \
  "ground_truth_assertions=16/16" \
  "target_status=$target_status" \
  "target_verification=$target_verification" \
  "source_task_status=$source_status" \
  "source_task_verification=$source_verification" \
  "target_runs=$target_runs" \
  "target_receipts=$target_receipts" \
  "target_loops=$target_loops" \
  "scope_open_loops=$scope_open_loops" \
  "target_directive=$target_directive" \
  "prior_receipt_subject_and_consumptions=$prior_receipt" \
  "prior_loop_and_attempt=$prior_loop" \
  "historical_unreceived_reports=$unreceived_reports" \
  "target_response_sha256=$target_response_hash" \
  "artifact_sha256=$artifact_hash" \
  "nco_probe=http_$nco_http,curl_exit_$nco_curl_exit" \
  "nova_ax_probe=http_$ax_http,curl_exit_$ax_curl_exit"
