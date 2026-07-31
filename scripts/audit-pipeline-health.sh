#!/usr/bin/env bash
# Audit pipeline health snapshot (AP-1..AP-6).
# Read-only against db/nco.db. Safe to run during scorer lease contention.
# NCO agent CommandGate: bash/sqlite3 not allowlisted — use instead:
#   npx tsx scripts/audit-pipeline-health.ts
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${DATABASE_PATH:-$ROOT/db/nco.db}"
WINDOW="${AUDIT_PIPELINE_WINDOW:-48 hours}"

if [[ ! -f "$DB" ]]; then
  echo "error: database not found at $DB" >&2
  exit 1
fi

echo "# audit-pipeline-health"
echo "generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "database=$DB"
echo "window=$WINDOW"
echo

sqlite3 -header -column "$DB" <<SQL
SELECT 'AP-1' AS metric, 'reviewing_queue_48h' AS name, COUNT(*) AS value
FROM tasks
WHERE status='reviewing'
  AND datetime(created_at) >= datetime('now', '-${WINDOW}');

SELECT 'AP-2' AS metric, 'marked_completed_without_approval_48h' AS name, COUNT(*) AS value
FROM tasks
WHERE status='completed'
  AND json_valid(COALESCE(metadata_json, ''))
  AND COALESCE(json_extract(metadata_json, '$.organizationAuditRequired'), 0) = 1
  AND COALESCE(json_extract(metadata_json, '$.verificationStatus'), '') != 'approved'
  AND datetime(created_at) >= datetime('now', '-${WINDOW}');

SELECT 'AP-3_enter' AS metric, 'reviewing_entered_48h' AS name, COUNT(*) AS value
FROM tasks
WHERE status IN ('reviewing', 'completed', 'failed', 'cancelled')
  AND json_valid(COALESCE(metadata_json, ''))
  AND COALESCE(json_extract(metadata_json, '$.organizationAuditRequired'), 0) = 1
  AND datetime(created_at) >= datetime('now', '-${WINDOW}');

SELECT 'AP-3_approved' AS metric, 'marked_approved_48h' AS name, COUNT(*) AS value
FROM tasks
WHERE json_valid(COALESCE(metadata_json, ''))
  AND json_extract(metadata_json, '$.verificationStatus') = 'approved'
  AND TRIM(COALESCE(json_extract(metadata_json, '$.verificationReceiptId'), '')) != ''
  AND datetime(created_at) >= datetime('now', '-${WINDOW}');

SELECT 'AP-4' AS metric, 'approved_with_receipt_48h' AS name, COUNT(*) AS value
FROM tasks
WHERE json_valid(COALESCE(metadata_json, ''))
  AND json_extract(metadata_json, '$.verificationStatus') = 'approved'
  AND TRIM(COALESCE(json_extract(metadata_json, '$.verificationReceiptId'), '')) != ''
  AND datetime(created_at) >= datetime('now', '-${WINDOW}');

SELECT 'AP-5' AS metric, 'team_tasks_marked_at_enqueue_48h' AS name,
  ROUND(
    100.0 * SUM(
      CASE
        WHEN team_id IS NOT NULL
          AND json_valid(COALESCE(metadata_json, ''))
          AND COALESCE(json_extract(metadata_json, '$.organizationAuditRequired'), 0) = 1
        THEN 1 ELSE 0
      END
    ) / NULLIF(SUM(CASE WHEN team_id IS NOT NULL THEN 1 ELSE 0 END), 0),
    1
  ) AS value_pct
FROM tasks
WHERE datetime(created_at) >= datetime('now', '-${WINDOW}');

SELECT 'AP-6' AS metric, 'team_completed_bypassing_reviewing_48h' AS name, COUNT(*) AS value
FROM tasks
WHERE team_id IS NOT NULL
  AND status='completed'
  AND datetime(created_at) >= datetime('now', '-${WINDOW}')
  AND (
    NOT json_valid(COALESCE(metadata_json, ''))
    OR COALESCE(json_extract(metadata_json, '$.organizationAuditRequired'), 0) != 1
  );

SELECT bucket, COUNT(*) AS n
FROM (
  SELECT
    CASE
      WHEN json_valid(COALESCE(metadata_json, ''))
        AND COALESCE(json_extract(metadata_json, '$.organizationAuditRequired'), 0) = 1
      THEN 'marked'
      WHEN json_valid(COALESCE(metadata_json, ''))
        AND TRIM(COALESCE(json_extract(metadata_json, '$.verificationStatus'), '')) != ''
      THEN 'marked'
      ELSE 'legacy'
    END AS bucket
  FROM tasks
  WHERE status='completed'
    AND team_id IS NOT NULL
    AND datetime(created_at) >= datetime('now', '-${WINDOW}')
)
GROUP BY bucket;
SQL
