/**
 * Audit pipeline health snapshot (AP-1..AP-6).
 * Read-only against db/nco.db. Runnable via CommandGate allowlist:
 *   npx tsx scripts/audit-pipeline-health.ts
 *
 * Bash twin: scripts/audit-pipeline-health.sh (not in agent allowlist).
 */
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const DB = process.env.DATABASE_PATH ?? resolve(ROOT, 'db/nco.db');
const WINDOW = process.env.AUDIT_PIPELINE_WINDOW ?? '48 hours';

interface MetricRow {
  metric: string;
  name: string;
  value: number | null;
}

interface BucketRow {
  bucket: string;
  n: number;
}

function main(): void {
  if (!existsSync(DB)) {
    console.error(`error: database not found at ${DB}`);
    process.exit(1);
  }

  const db = new Database(DB, { readonly: true, fileMustExist: true });

  console.log('# audit-pipeline-health');
  console.log(`generated_at=${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
  console.log(`database=${DB}`);
  console.log(`window=${WINDOW}`);
  console.log();

  const metrics = db
    .prepare(
      `
SELECT 'AP-1' AS metric, 'reviewing_queue_48h' AS name, COUNT(*) AS value
FROM tasks
WHERE status='reviewing'
  AND datetime(created_at) >= datetime('now', ?)

UNION ALL

SELECT 'AP-2', 'marked_completed_without_approval_48h', COUNT(*)
FROM tasks
WHERE status='completed'
  AND json_valid(COALESCE(metadata_json, ''))
  AND COALESCE(json_extract(metadata_json, '$.organizationAuditRequired'), 0) = 1
  AND COALESCE(json_extract(metadata_json, '$.verificationStatus'), '') != 'approved'
  AND datetime(created_at) >= datetime('now', ?)

UNION ALL

SELECT 'AP-3_enter', 'reviewing_entered_48h', COUNT(*)
FROM tasks
WHERE status IN ('reviewing', 'completed', 'failed', 'cancelled')
  AND json_valid(COALESCE(metadata_json, ''))
  AND COALESCE(json_extract(metadata_json, '$.organizationAuditRequired'), 0) = 1
  AND datetime(created_at) >= datetime('now', ?)

UNION ALL

SELECT 'AP-3_approved', 'marked_approved_48h', COUNT(*)
FROM tasks
WHERE json_valid(COALESCE(metadata_json, ''))
  AND json_extract(metadata_json, '$.verificationStatus') = 'approved'
  AND TRIM(COALESCE(json_extract(metadata_json, '$.verificationReceiptId'), '')) != ''
  AND datetime(created_at) >= datetime('now', ?)

UNION ALL

SELECT 'AP-4', 'approved_with_receipt_48h', COUNT(*)
FROM tasks
WHERE json_valid(COALESCE(metadata_json, ''))
  AND json_extract(metadata_json, '$.verificationStatus') = 'approved'
  AND TRIM(COALESCE(json_extract(metadata_json, '$.verificationReceiptId'), '')) != ''
  AND datetime(created_at) >= datetime('now', ?)

UNION ALL

SELECT 'AP-5', 'team_tasks_marked_at_enqueue_48h',
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
  )
FROM tasks
WHERE datetime(created_at) >= datetime('now', ?)

UNION ALL

SELECT 'AP-6', 'team_completed_bypassing_reviewing_48h', COUNT(*)
FROM tasks
WHERE team_id IS NOT NULL
  AND status='completed'
  AND datetime(created_at) >= datetime('now', ?)
      `,
    )
    .all(`-${WINDOW}`, `-${WINDOW}`, `-${WINDOW}`, `-${WINDOW}`, `-${WINDOW}`, `-${WINDOW}`, `-${WINDOW}`) as MetricRow[];

  console.log('metric          name                                      value');
  for (const row of metrics) {
    const metric = row.metric.padEnd(15);
    const name = row.name.padEnd(42);
    const value = row.value ?? 'NULL';
    console.log(`${metric} ${name} ${value}`);
  }
  console.log();

  const buckets = db
    .prepare(
      `
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
    AND datetime(created_at) >= datetime('now', ?)
)
GROUP BY bucket
      `,
    )
    .all(`-${WINDOW}`) as BucketRow[];

  console.log('bucket          n');
  for (const row of buckets) {
    console.log(`${row.bucket.padEnd(15)} ${row.n}`);
  }

  db.close();
}

main();
