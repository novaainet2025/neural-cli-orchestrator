import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const auditScriptPath = resolve(evidenceDir, "run-audit.mjs");
const machineEvidencePath = resolve(evidenceDir, "machine-evidence.json");
const submissionPath = resolve(evidenceDir, "verification-submission.json");
const outputPath = resolve(evidenceDir, "blocked-state.json");
const auditTaskId = "task_fJg32GBz8EhFZiMQ";
const companyId = "org_ui-inspection";
const teamId = "team_ui-ux-design";
const novaDbPath = "/Users/nova-ai/project/nova-ax/db/nova-ax.db";
const ncoDbPath = "/Users/nova-ai/project/nco/db/nco.db";
const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
const requireFromNovaAx = createRequire(
  "/Users/nova-ai/project/nova-ax/package.json",
);
const Database = requireFromNovaAx("better-sqlite3");

const attempt = spawnSync(process.execPath, [auditScriptPath], {
  cwd: "/Users/nova-ai/project/nova-ax",
  encoding: "utf8",
  timeout: 30_000,
});
const machineEvidence = JSON.parse(
  await readFile(machineEvidencePath, "utf8"),
);
const submission = await readFile(submissionPath);

const novaDb = new Database(novaDbPath, {
  readonly: true,
  fileMustExist: true,
});
const runs = novaDb.prepare(`
  SELECT id,task_id,company_id,team_id,actor_id,status,
         passed_institutions,evidence_digest,created_at
  FROM verification_runs
  WHERE task_id=? AND company_id=? AND team_id=?
  ORDER BY created_at
`).all(auditTaskId, companyId, teamId);
const receipts = novaDb.prepare(`
  SELECT r.id,r.run_id,r.task_id,r.company_id,r.team_id,r.actor_id,
         r.evidence_digest,r.issued_at,c.id consumption_id,
         c.event_id,c.consumed_at
  FROM verification_receipts r
  LEFT JOIN verification_receipt_consumptions c ON c.receipt_id=r.id
  WHERE r.task_id=? AND r.company_id=? AND r.team_id=?
  ORDER BY r.issued_at
`).all(auditTaskId, companyId, teamId);
const taskLoops = novaDb.prepare(`
  SELECT id,original_run_id,task_id,status,current_iteration,
         max_iterations,latest_run_id,created_at,updated_at
  FROM verification_loops
  WHERE task_id=? AND company_id=? AND team_id=?
  ORDER BY created_at
`).all(auditTaskId, companyId, teamId);
const scopeOpenLoops = novaDb.prepare(`
  SELECT id,original_run_id,task_id,status,current_iteration,
         max_iterations,latest_run_id,created_at,updated_at
  FROM verification_loops
  WHERE company_id=? AND team_id=?
    AND status IN ('action_required','resubmitted')
  ORDER BY created_at
`).all(companyId, teamId);
novaDb.close();

const ncoDb = new Database(ncoDbPath, {
  readonly: true,
  fileMustExist: true,
});
const task = ncoDb.prepare(`
  SELECT id,status,assigned_to,team_id,progress,error,
         metadata_json,created_at,updated_at,completed_at
  FROM tasks
  WHERE id=?
`).get(auditTaskId);
ncoDb.close();

const result = {
  observedAt: new Date().toISOString(),
  evidenceTier: 1,
  scope: { companyId, teamId },
  auditTaskId,
  status: runs.length === 0 ? "blocked_unverified" : "inspect_runs",
  machineContract: machineEvidence.contract,
  artifact: machineEvidence.artifact,
  submission: {
    path: submissionPath,
    sha256: sha256(submission),
  },
  submissionAttempt: {
    command: `${process.execPath} ${auditScriptPath}`,
    cwd: "/Users/nova-ai/project/nova-ax",
    exitCode: attempt.status,
    signal: attempt.signal,
    stdout: attempt.stdout,
    stderr: attempt.stderr,
    error: attempt.error
      ? {
          name: attempt.error.name,
          message: attempt.error.message,
        }
      : null,
  },
  novaAx: {
    runs,
    receipts,
    taskLoops,
    scopeOpenLoops,
  },
  nco: {
    task: task
      ? {
          ...task,
          metadata: JSON.parse(task.metadata_json || "{}"),
          metadata_json: undefined,
        }
      : null,
  },
  completionCriteria: {
    newRunCreated: runs.length > 0,
    sixOfSixApproved:
      runs.some(
        (run) =>
          run.status === "approved" && run.passed_institutions === 6,
      ),
    receiptIssued: receipts.length > 0,
    receiptConsumed:
      receipts.some((receipt) => receipt.consumption_id != null),
    noOpenTaskLoops:
      taskLoops.every(
        (loop) =>
          !["action_required", "resubmitted"].includes(loop.status),
      ),
  },
  blockers: [
    "Nova-AX and NCO loopback HTTP connections are denied in the current sandbox.",
    "Nova-AX MCP and NCO MCP calls were cancelled by the tool surface.",
    "In-process official API injection cannot write the Nova-AX DB because it is outside the writable workspace.",
  ],
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  outputPath,
  status: result.status,
  machineChecks:
    `${result.machineContract.passedChecks}/${result.machineContract.totalChecks}`,
  runs: runs.length,
  receipts: receipts.length,
  openTaskLoops: taskLoops.filter(
    (loop) => ["action_required", "resubmitted"].includes(loop.status),
  ).length,
  submissionExitCode: attempt.status,
  submissionError:
    attempt.stderr.match(/SqliteError: [^\n]+/)?.[0] || null,
}));
