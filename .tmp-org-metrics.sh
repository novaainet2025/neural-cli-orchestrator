#!/bin/bash
set -e
cd /Users/nova-ai/project/nco
DB="db/nco.db"
BK="db/backups/nco-pre-org-topology-20260727-0055.db"

echo "=== LIVE DB: $DB ==="

echo "--- 1 active_orgs ---"
sqlite3 "$DB" "SELECT COUNT(*) FROM organizations WHERE is_active=1;"

echo "--- 2 active_teams ---"
sqlite3 "$DB" "SELECT COUNT(*) FROM teams WHERE is_active=1;"

echo "--- 3 teams_under_3_members_count ---"
sqlite3 "$DB" "
SELECT COUNT(*) FROM (
  SELECT t.id
  FROM teams t
  WHERE t.is_active = 1
  AND (
    SELECT COUNT(*)
    FROM team_members tm
    JOIN agents a ON tm.member_ref = a.id AND tm.member_type = 'provider'
    WHERE tm.team_id = t.id AND tm.removed_at IS NULL AND a.enabled = 1
  ) < 3
);"

echo "--- 3b teams_under_3_members_list ---"
sqlite3 -header -column "$DB" "
SELECT t.id, t.name,
  (SELECT COUNT(*)
   FROM team_members tm
   JOIN agents a ON tm.member_ref = a.id AND tm.member_type = 'provider'
   WHERE tm.team_id = t.id AND tm.removed_at IS NULL AND a.enabled = 1
  ) AS enabled_provider_members
FROM teams t
WHERE t.is_active = 1
AND (
  SELECT COUNT(*)
  FROM team_members tm
  JOIN agents a ON tm.member_ref = a.id AND tm.member_type = 'provider'
  WHERE tm.team_id = t.id AND tm.removed_at IS NULL AND a.enabled = 1
) < 3
ORDER BY t.id;"

echo "--- 4 missing_lead ---"
sqlite3 "$DB" "SELECT COUNT(*) FROM teams WHERE is_active=1 AND (lead IS NULL OR lead='');"

echo "--- 5 missing_charter ---"
sqlite3 "$DB" "SELECT COUNT(*) FROM teams WHERE is_active=1 AND (charter IS NULL OR charter='');"

echo "--- 6 org_design_audits_last_10 ---"
sqlite3 -json "$DB" "
SELECT id, audit_time, source, status,
  active_organizations, active_teams,
  org_expected, org_present, org_repaired,
  cap_expected, cap_present, cap_repaired,
  members_before_zero, members_before_one, members_before_two,
  members_after_coverage,
  collaboration_coverage_before, collaboration_coverage_after,
  missing_lead_before, missing_lead_after,
  missing_charter_before, missing_charter_after,
  actions_json, evidence_json
FROM organization_design_audits
ORDER BY audit_time DESC
LIMIT 10;"

echo "--- 6b specific_audit_ids ---"
sqlite3 -json "$DB" "
SELECT id, audit_time, source, status,
  active_organizations, active_teams,
  org_expected, org_present, org_repaired,
  cap_expected, cap_present, cap_repaired,
  members_before_zero, members_before_one, members_before_two,
  members_after_coverage,
  collaboration_coverage_before, collaboration_coverage_after,
  missing_lead_before, missing_lead_after,
  missing_charter_before, missing_charter_after,
  actions_json, evidence_json
FROM organization_design_audits
WHERE id IN (
  'org-design_GgSswOAH1UEgVs5b',
  'org-design_MHuoScsNE0bjjQ1o',
  'org-design_lrCgBDTA1u_9lelL',
  'org-design_LGRmlg9l_13jjgvk'
);"

echo "--- 7 team_consolidations_kd ---"
sqlite3 -header -column "$DB" "
SELECT * FROM team_consolidations
WHERE old_team_id LIKE 'team_kd-%' OR new_team_id LIKE 'team_kd-%'
ORDER BY consolidated_at DESC;"

echo "--- 8 required_counts ---"
sqlite3 "$DB" "SELECT 'required_organizations', COUNT(*) FROM required_organizations UNION ALL SELECT 'required_capabilities', COUNT(*) FROM required_capabilities;"

echo "--- 9 kd_teams_status ---"
sqlite3 -header -column "$DB" "
SELECT id, is_active, lead, substr(charter,1,80) AS charter_preview
FROM teams
WHERE id IN (
  'team_kd-harness','team_kd-memory','team_kd-obsidian',
  'team_kd-prompt','team_kd-provider','team_kd-quality-hygiene'
)
ORDER BY id;"

echo "--- 10 cron_org_design ---"
sqlite3 -header -column "$DB" "
SELECT id, description, schedule, enabled, task_type, timezone, updated_at
FROM cron_jobs WHERE id = 'org-design-hourly-audit';"

echo "--- 11 tasks_columns ---"
sqlite3 -header -column "$DB" "PRAGMA table_info(tasks);"

echo "--- 11b failed_tasks_24h_updated_at ---"
sqlite3 "$DB" "
SELECT COUNT(*) FROM tasks
WHERE status IN ('failed','timeout','timed_out')
AND updated_at > datetime('now','-24 hours');" 2>&1 || echo "updated_at query failed"

echo "--- 11c failed_tasks_24h_created_at ---"
sqlite3 "$DB" "
SELECT COUNT(*) FROM tasks
WHERE status IN ('failed','timeout','timed_out')
AND created_at > datetime('now','-24 hours');" 2>&1 || echo "created_at query failed"

echo "--- 12 commander_tables ---"
sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%commander%' OR name LIKE '%operation%audit%');"

echo "--- 12b commander_operation_audits_recent ---"
sqlite3 -json "$DB" "
SELECT * FROM commander_operation_audits ORDER BY audit_time DESC LIMIT 10;" 2>&1 || echo "commander_operation_audits query failed"

echo "--- 15 collaboration_coverage ---"
sqlite3 -header -column "$DB" "
SELECT
  COUNT(*) AS total_active_teams,
  SUM(CASE WHEN member_count >= 3 THEN 1 ELSE 0 END) AS teams_with_3plus,
  ROUND(CAST(SUM(CASE WHEN member_count >= 3 THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0), 4) AS coverage_fraction
FROM (
  SELECT t.id,
    (SELECT COUNT(*)
     FROM team_members tm
     JOIN agents a ON tm.member_ref = a.id AND tm.member_type = 'provider'
     WHERE tm.team_id = t.id AND tm.removed_at IS NULL AND a.enabled = 1
    ) AS member_count
  FROM teams t
  WHERE t.is_active = 1
);"

echo "=== BACKUP DB: $BK ==="
if [ -f "$BK" ]; then
  echo "--- backup 1 active_orgs ---"
  sqlite3 "$BK" "SELECT COUNT(*) FROM organizations WHERE is_active=1;"
  echo "--- backup 2 active_teams ---"
  sqlite3 "$BK" "SELECT COUNT(*) FROM teams WHERE is_active=1;"
  echo "--- backup org_design_audits_count ---"
  sqlite3 "$BK" "SELECT COUNT(*) FROM organization_design_audits;" 2>&1 || echo "no audits table in backup"
else
  echo "BACKUP NOT FOUND"
fi

echo "--- 13 backups_ls ---"
ls -la db/backups/nco-pre-org-topology* 2>&1
