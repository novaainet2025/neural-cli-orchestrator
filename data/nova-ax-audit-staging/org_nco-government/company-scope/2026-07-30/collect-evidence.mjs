import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "../../../../../node_modules/better-sqlite3/lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../../../../..");
const ncoDbPath = join(projectRoot, "db/nco.db");
const novaAxDbPath = "/Users/nova-ai/project/nova-ax/db/nova-ax.db";
const reportsRoot = join(projectRoot, "REPORTS");
const artifactPath = join(here, "company-scope-audit-bundle.json");

const companyId = "org_nco-government";
const teamId = "company-scope";
const observedAt = new Date().toISOString();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const GOVERNMENT_REPORT_PATTERNS = [
  /Constitution-and-Policy/i,
  /Rights-Ethics/i,
  /HR-Capability-Lifecycle/i,
  /Treasury-and-Resource-Stewardship/i,
  /Transparency-Appeals-and-Public-Record/i,
  /nco-government/i,
  /투명성이의제기공공기록/i,
  /NCO-org-topology-audit/i,
];

function isGovernmentReport(relativePath) {
  return GOVERNMENT_REPORT_PATTERNS.some((pattern) => pattern.test(relativePath));
}

async function inventoryGovernmentReports(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(root, entry.name);
    const rel = relative(projectRoot, path);
    if (isGovernmentReport(rel)) files.push(path);
  }

  const observations = await Promise.all(files.map(async (path) => {
    const [bytes, metadata] = await Promise.all([readFile(path), stat(path)]);
    return {
      path: relative(projectRoot, path),
      byteSize: bytes.byteLength,
      sha256: sha256(bytes),
      modifiedAt: metadata.mtime.toISOString(),
    };
  }));
  return observations.sort((a, b) =>
    b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path)
  );
}

const ncoDb = new Database(ncoDbPath, { readonly: true, fileMustExist: true });
const novaAxDb = new Database(novaAxDbPath, { readonly: true, fileMustExist: true });

const directive = novaAxDb.prepare(`
  SELECT id, company_id AS companyId, team_id AS teamId, type, status,
         work_report_id AS workReportId, task_id AS taskId, loop_id AS loopId,
         attempt_count AS attemptCount, last_error AS lastError,
         created_at AS createdAt, updated_at AS updatedAt
  FROM verification_directives
  WHERE company_id=? AND team_id=? AND type='audit_required'
  ORDER BY created_at DESC
  LIMIT 1
`).get(companyId, teamId);

const taskId = directive?.taskId;
if (!taskId) {
  throw new Error(`No audit_required directive taskId for ${companyId}/${teamId}`);
}

const sourceTask = ncoDb.prepare(`
  SELECT id, status, assigned_to AS assignedTo, priority, created_at AS createdAt,
         updated_at AS updatedAt, completed_at AS completedAt, error,
         json_extract(metadata_json, '$.workReportId') AS workReportId,
         json_extract(metadata_json, '$.verificationDirectiveId') AS verificationDirectiveId
  FROM tasks
  WHERE id=?
`).get(taskId);

const scopes = novaAxDb.prepare(`
  SELECT company_id AS companyId, team_id AS teamId, team_name AS teamName,
         active, source, last_seen_at AS lastSeenAt
  FROM verification_scopes
  WHERE company_id=?
  ORDER BY team_id
`).all(companyId);

const runs = novaAxDb.prepare(`
  SELECT id AS runId, task_id AS taskId, team_id AS teamId, actor_id AS actorId,
         status, passed_institutions AS passedInstitutions, evidence_digest AS evidenceDigest,
         created_at AS createdAt
  FROM verification_runs
  WHERE company_id=?
  ORDER BY created_at DESC
`).all(companyId);

const loops = novaAxDb.prepare(`
  SELECT id AS loopId, original_run_id AS originalRunId, task_id AS taskId,
         team_id AS teamId, source_actor_id AS actorId, status,
         current_iteration AS currentIteration, max_iterations AS maxIterations,
         latest_run_id AS latestRunId, created_at AS createdAt, updated_at AS updatedAt
  FROM verification_loops
  WHERE company_id=?
  ORDER BY created_at DESC
`).all(companyId);

const taskCounts = ncoDb.prepare(`
  SELECT t.status, COUNT(*) AS count
  FROM tasks t
  JOIN teams tm ON tm.id=t.team_id
  WHERE tm.organization_id=?
  GROUP BY t.status
  ORDER BY t.status
`).all(companyId);

const latestCompletedTasks = ncoDb.prepare(`
  SELECT t.id, t.team_id AS teamId, t.assigned_to AS assignedTo,
         t.status, t.completed_at AS completedAt, t.workflow_stage AS workflowStage,
         json_extract(t.metadata_json, '$.workReportId') AS workReportId
  FROM tasks t
  JOIN teams tm ON tm.id=t.team_id
  WHERE tm.organization_id=? AND t.status='completed'
  ORDER BY COALESCE(t.completed_at, t.updated_at) DESC
  LIMIT 20
`).all(companyId);

const reportFiles = await inventoryGovernmentReports(reportsRoot);
const gitHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: projectRoot,
  encoding: "utf8",
}).trim();

const bundle = {
  schemaVersion: 1,
  observedAt,
  scope: { companyId, teamId },
  auditBinding: {
    taskId,
    directive,
    sourceTask,
  },
  sourceFacts: {
    activeScopes: scopes,
    taskStatusCounts: taskCounts,
    latestCompletedTasks,
    verificationRuns: runs,
    remediationLoops: loops,
    openCompanyScopeLoops: loops.filter((loop) =>
      loop.teamId === teamId && ["action_required", "resubmitted"].includes(loop.status)
    ),
  },
  artifactInventory: {
    root: relative(projectRoot, reportsRoot),
    fileCount: reportFiles.length,
    totalBytes: reportFiles.reduce((sum, file) => sum + file.byteSize, 0),
    files: reportFiles,
  },
  repository: { head: gitHead },
  assertions: {
    successClaimed: false,
    sourceTaskStatus: sourceTask?.status ?? "missing",
    directiveStatus: directive?.status ?? "missing",
    note: "이 번들은 관찰된 원본 상태를 보존하며 검증 승인 전 성공을 주장하지 않는다.",
  },
};

await writeFile(artifactPath, `${JSON.stringify(bundle, null, 2)}\n`);
const artifactBytes = await readFile(artifactPath);
console.log(JSON.stringify({
  artifactPath,
  artifactSha256: sha256(artifactBytes),
  artifactByteSize: artifactBytes.byteLength,
  taskId,
  reportFileCount: reportFiles.length,
  reportTotalBytes: bundle.artifactInventory.totalBytes,
  activeScopeCount: scopes.length,
  sourceTaskStatus: sourceTask?.status ?? null,
  directiveStatus: directive?.status ?? null,
  openCompanyScopeLoopCount: bundle.sourceFacts.openCompanyScopeLoops.length,
  observedAt,
}, null, 2));
