import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const ncoRoot = "/Users/nova-ai/project/nco";
const novaDbPath = "/Users/nova-ai/project/nova-ax/db/nova-ax.db";
const ncoDbPath = `${ncoRoot}/db/nco.db`;
const taskId = "task_pnxUEketwozTapq7";
const companyId = "org_web-scraping";
const teamId = "team_web-scrape-04-dynamic-implementation";
const require = createRequire(`${ncoRoot}/package.json`);
const Database = require("better-sqlite3");

const novaDb = new Database(novaDbPath, {
  readonly: true,
  fileMustExist: true,
});
const ncoDb = new Database(ncoDbPath, {
  readonly: true,
  fileMustExist: true,
});

const state = {
  observedAt: new Date().toISOString(),
  sources: { novaDbPath, ncoDbPath },
  ncoTask: ncoDb.prepare(`
    SELECT id, status, assigned_to, team_id, metadata_json,
      created_at, updated_at, completed_at
    FROM tasks WHERE id=?
  `).get(taskId),
  verificationRuns: novaDb.prepare(`
    SELECT id, task_id, company_id, team_id, actor_id, status,
      passed_institutions, evidence_digest, results_json, created_at
    FROM verification_runs
    WHERE task_id=?
    ORDER BY created_at DESC
  `).all(taskId),
  receipts: novaDb.prepare(`
    SELECT r.id AS receipt_id, r.run_id, r.task_id, r.actor_id,
      r.evidence_digest, r.issued_at,
      c.id AS consumption_id, c.event_id, c.consumed_at
    FROM verification_receipts r
    LEFT JOIN verification_receipt_consumptions c ON c.receipt_id=r.id
    WHERE r.task_id=?
    ORDER BY r.issued_at DESC
  `).all(taskId),
  loops: novaDb.prepare(`
    SELECT id, original_run_id, task_id, status, current_iteration,
      max_iterations, latest_run_id, created_at, updated_at
    FROM verification_loops
    WHERE task_id=?
    ORDER BY created_at DESC
  `).all(taskId),
  directives: novaDb.prepare(`
    SELECT id, company_id, team_id, subject_task_id, type, status,
      work_report_id, task_id, last_error, attempt_count,
      created_at, updated_at
    FROM verification_directives
    WHERE company_id=? AND team_id=?
    ORDER BY created_at DESC
  `).all(companyId, teamId),
  completionEvents: novaDb.prepare(`
    SELECT id, timestamp, agent_id, action, description, result,
      task_id, company_id, team_id, receipt_id, metadata_json
    FROM activity_log
    WHERE task_id=? OR receipt_id IN (
      SELECT id FROM verification_receipts WHERE task_id=?
    )
    ORDER BY timestamp DESC
  `).all(taskId, taskId),
};

novaDb.close();
ncoDb.close();

const path = resolve(evidenceDir, "authority-state.json");
writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
console.log(JSON.stringify({
  path,
  observedAt: state.observedAt,
  taskStatus: state.ncoTask?.status ?? null,
  runCount: state.verificationRuns.length,
  receiptCount: state.receipts.length,
  openLoops: state.loops.filter((loop) =>
    loop.status === "action_required" || loop.status === "resubmitted"
  ).length,
  queuedSubjectDirectives: state.directives.filter((directive) =>
    directive.subject_task_id === taskId
      && (directive.status === "queued" || directive.status === "dispatched")
  ).length,
}, null, 2));
