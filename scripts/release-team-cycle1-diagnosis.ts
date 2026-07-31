/**
 * Integration and Release team — cycle 1 read-only diagnosis.
 * CommandGate-safe: npx tsx scripts/release-team-cycle1-diagnosis.ts
 *
 * Outputs T1 evidence for HR cycle 1/3 without mutating DB or scorer state.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { computeTeamScores } from '../src/core/team-scorer.js';

const ROOT = resolve(import.meta.dirname, '..');
const DB = process.env.DATABASE_PATH ?? resolve(ROOT, 'db/nco.db');
const TEAM_ID = 'team_gov-engineering-release';
const WINDOW = process.env.RELEASE_DIAG_WINDOW ?? '48 hours';

interface TaskRow {
  id: string;
  status: string;
  assigned_to: string | null;
  error: string | null;
  response_len: number;
  audit_marked: number;
  verification_status: string | null;
  receipt_present: number;
  created_at: string;
}

function main(): void {
  if (!existsSync(DB)) {
    console.error(`error: database not found at ${DB}`);
    process.exit(1);
  }

  const db = new Database(DB, { readonly: true, fileMustExist: true });

  console.log('# release-team-cycle1-diagnosis');
  console.log(`generated_at=${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
  console.log(`database=${DB}`);
  console.log(`team_id=${TEAM_ID}`);
  console.log(`window=${WINDOW}`);
  console.log();

  const score = computeTeamScores(db).find((row) => row.teamId === TEAM_ID);
  console.log('## scorer_snapshot');
  console.log(JSON.stringify(score ?? { teamId: TEAM_ID, missing: true }, null, 2));
  console.log();

  const gateToggle = process.env.NCO_SCORER_AUDIT_APPROVAL_GATE ?? '(default:on)';
  console.log(`audit_gate_toggle=${gateToggle}`);
  console.log();

  const tasks = db.prepare(`
    SELECT
      id,
      status,
      assigned_to,
      substr(COALESCE(error, ''), 1, 120) AS error,
      length(COALESCE(response, '')) AS response_len,
      CASE
        WHEN json_valid(COALESCE(metadata_json, ''))
          AND (
            COALESCE(json_extract(metadata_json, '$.organizationAuditRequired'), 0) = 1
            OR TRIM(COALESCE(json_extract(metadata_json, '$.verificationStatus'), '')) <> ''
          )
        THEN 1 ELSE 0
      END AS audit_marked,
      CASE
        WHEN json_valid(COALESCE(metadata_json, ''))
        THEN json_extract(metadata_json, '$.verificationStatus')
        ELSE NULL
      END AS verification_status,
      CASE
        WHEN json_valid(COALESCE(metadata_json, ''))
          AND TRIM(COALESCE(json_extract(metadata_json, '$.verificationReceiptId'), '')) <> ''
        THEN 1 ELSE 0
      END AS receipt_present,
      created_at
    FROM tasks
    WHERE team_id = ?
      AND datetime(created_at) >= datetime('now', ?)
    ORDER BY created_at DESC
  `).all(TEAM_ID, `-${WINDOW}`) as TaskRow[];

  console.log('## tasks_48h');
  console.log(`count=${tasks.length}`);
  for (const row of tasks) {
    console.log(JSON.stringify(row));
  }
  console.log();

  const fleet = db.prepare(`
    SELECT
      COUNT(*) AS completed_48h,
      SUM(CASE
        WHEN json_valid(COALESCE(metadata_json, ''))
          AND json_extract(metadata_json, '$.verificationStatus') = 'approved'
          AND TRIM(COALESCE(json_extract(metadata_json, '$.verificationReceiptId'), '')) <> ''
        THEN 1 ELSE 0
      END) AS approved_with_receipt_48h
    FROM tasks
    WHERE status = 'completed'
      AND team_id IS NOT NULL
      AND datetime(created_at) >= datetime('now', ?)
  `).get(`-${WINDOW}`) as { completed_48h: number; approved_with_receipt_48h: number };

  console.log('## fleet_audit_pipeline');
  console.log(JSON.stringify(fleet, null, 2));
  console.log();

  const zeroCompletionTeams = computeTeamScores(db).filter((row) => row.completion === 0).length;
  const activeTeams = computeTeamScores(db).length;
  console.log('## fleet_completion_collapse');
  console.log(JSON.stringify({
    activeTeams,
    zeroCompletionTeams,
    zeroCompletionRatio: activeTeams > 0 ? round1((zeroCompletionTeams / activeTeams) * 100) : 0,
  }, null, 2));

  db.close();
}

function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

main();
