import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

const ncoDbPath = "/Users/nova-ai/project/nco/db/nco.db";
const novaAxDbPath = "/Users/nova-ai/project/nova-ax/db/nova-ax.db";
const mirrorPath =
  "/Users/nova-ai/obsidian/mac-obsidian/07-SESSIONS/NCO-WORK-JOURNAL/WORK-REPORTS/2026-07/wr_EF4bugKnd2-4QXHf.md";
const verifiedArtifactPath =
  "/Users/nova-ai/project/nova-ax/evidence/org_nco-government/company-scope/2026-07-30/company-scope-audit-bundle.json";
const verificationTestLogPath =
  "/Users/nova-ai/project/nco/data/nova-ax-audit-staging/org_nco-government/company-scope/2026-07-30/verification-suite.log";
const pm2PidPath = "/Users/nova-ai/.pm2/pids/nova-ax-6.pid";
const companyId = "org_nco-government";
const teamId = "company-scope";
const workReportId = "wr_EF4bugKnd2-4QXHf";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function openReadonly(path) {
  return new Database(path, { readonly: true, fileMustExist: true });
}

const nco = openReadonly(ncoDbPath);
const novaAx = openReadonly(novaAxDbPath);

const organization = nco
  .prepare("SELECT id,name,is_active FROM organizations WHERE id=?")
  .get(companyId);
const activeTeams = nco
  .prepare("SELECT COUNT(*) AS count FROM teams WHERE organization_id=? AND is_active=1")
  .get(companyId);
const workReport = nco
  .prepare(`
    SELECT id,status,subject_kind,subject_id,organization_id,team_id,
      source_task_id,report_date,report_slot,submitted_at,body_md
    FROM work_reports
    WHERE id=?
  `)
  .get(workReportId);
const sourceTask = nco
  .prepare(`
    SELECT id,status,assigned_to,response,error,completed_at
    FROM tasks
    WHERE id=?
  `)
  .get(workReport.source_task_id);

const scope = novaAx
  .prepare(`
    SELECT company_id,team_id,team_name,active,source,last_seen_at
    FROM verification_scopes
    WHERE company_id=? AND team_id=?
  `)
  .get(companyId, teamId);
const auditDirective = novaAx
  .prepare(`
    SELECT id,type,status,work_report_id,task_id,dispatched_at,last_error,
      attempt_count,next_attempt_at,created_at,updated_at
    FROM verification_directives
    WHERE company_id=? AND team_id=? AND type='audit_required'
    ORDER BY created_at DESC
    LIMIT 1
  `)
  .get(companyId, teamId);
const directiveTask = auditDirective?.task_id
  ? nco
      .prepare(`
        SELECT id,status,assigned_to,error,created_at,completed_at
        FROM tasks
        WHERE id=?
      `)
      .get(auditDirective.task_id)
  : null;
const counts = novaAx
  .prepare(`
    SELECT
      (SELECT COUNT(*) FROM verification_runs
        WHERE company_id=? AND team_id=?) AS runs,
      (SELECT COUNT(*) FROM verification_receipts r
        JOIN verification_runs v ON v.id=r.run_id
        WHERE v.company_id=? AND v.team_id=?) AS receipts,
      (SELECT COUNT(*) FROM verification_receipt_consumptions c
        JOIN verification_receipts r ON r.id=c.receipt_id
        JOIN verification_runs v ON v.id=r.run_id
        WHERE v.company_id=? AND v.team_id=?) AS consumptions,
      (SELECT COUNT(*) FROM activity_log
        WHERE company_id=? AND team_id=? AND action='task_complete') AS completionEvents,
      (SELECT COUNT(*) FROM verification_loops
        WHERE company_id=? AND team_id=?
          AND status IN ('action_required','resubmitted')) AS openLoops
  `)
  .get(
    companyId,
    teamId,
    companyId,
    teamId,
    companyId,
    teamId,
    companyId,
    teamId,
    companyId,
    teamId
  );

const approvedRunRow = novaAx
  .prepare(`
    SELECT id,task_id,company_id,team_id,actor_id,task_type,status,
      passed_institutions,evidence_digest,evidence_summary_json,results_json,created_at
    FROM verification_runs
    WHERE company_id=? AND team_id=? AND status='approved'
    ORDER BY created_at DESC,rowid DESC
    LIMIT 1
  `)
  .get(companyId, teamId);
const approvedRun = approvedRunRow
  ? {
      id: approvedRunRow.id,
      taskId: approvedRunRow.task_id,
      companyId: approvedRunRow.company_id,
      teamId: approvedRunRow.team_id,
      actorId: approvedRunRow.actor_id,
      taskType: approvedRunRow.task_type,
      status: approvedRunRow.status,
      passedInstitutions: approvedRunRow.passed_institutions,
      evidenceDigest: approvedRunRow.evidence_digest,
      evidenceSummary: JSON.parse(approvedRunRow.evidence_summary_json),
      results: JSON.parse(approvedRunRow.results_json),
      createdAt: approvedRunRow.created_at,
    }
  : null;
const receipt = approvedRun
  ? novaAx
      .prepare(`
        SELECT r.id,r.run_id,r.task_id,r.company_id,r.team_id,r.actor_id,
          r.evidence_digest,r.issued_at,c.id AS consumption_id,c.event_id,c.consumed_at
        FROM verification_receipts r
        LEFT JOIN verification_receipt_consumptions c ON c.receipt_id=r.id
        WHERE r.run_id=?
      `)
      .get(approvedRun.id)
  : null;
const loop = approvedRun
  ? novaAx
      .prepare(`
        SELECT id,original_run_id,task_id,company_id,team_id,source_actor_id,
          status,current_iteration,max_iterations,latest_run_id,created_at,updated_at
        FROM verification_loops
        WHERE company_id=? AND team_id=? AND latest_run_id=?
        ORDER BY updated_at DESC
        LIMIT 1
      `)
      .get(companyId, teamId, approvedRun.id)
  : null;
const attempt = loop
  ? novaAx
      .prepare(`
        SELECT id,loop_id,iteration,actor_id,run_id,criteria_json,decision,created_at
        FROM verification_loop_attempts
        WHERE loop_id=? AND run_id=?
      `)
      .get(loop.id, approvedRun.id)
  : null;
const remediationCounts = loop
  ? novaAx
      .prepare(`
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved,
          SUM(CASE WHEN status<>'resolved' THEN 1 ELSE 0 END) AS unresolved
        FROM verification_remediations
        WHERE loop_id=?
      `)
      .get(loop.id)
  : null;
const completionEvent = receipt?.event_id
  ? novaAx
      .prepare(`
        SELECT id,timestamp,agent_id,action,task_id,company_id,team_id,receipt_id,metadata_json
        FROM activity_log
        WHERE id=?
      `)
      .get(receipt.event_id)
  : null;

let health;
try {
  const response = await fetch("http://localhost:6300/api/health", {
    signal: AbortSignal.timeout(3_000),
  });
  health = {
    reachable: true,
    statusCode: response.status,
    bodySha256: sha256(await response.text()),
  };
} catch (error) {
  health = {
    reachable: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

let pm2Pid = null;
let pm2PidAlive = false;
try {
  pm2Pid = Number(readFileSync(pm2PidPath, "utf8").trim());
  process.kill(pm2Pid, 0);
  pm2PidAlive = true;
} catch {
  pm2PidAlive = false;
}

const bodySha256 = sha256(workReport.body_md);
const responseSha256 = sha256(sourceTask.response || "");
const mirror = readFileSync(mirrorPath);
const verifiedArtifact = readFileSync(verifiedArtifactPath);
const verificationTestLog = readFileSync(verificationTestLogPath);
const inspectionResult = approvedRun?.results.find(
  (item) => item.institution === "inspection"
);
const performanceResult = approvedRun?.results.find(
  (item) => item.institution === "performance"
);

const result = {
  collectedAt: new Date().toISOString(),
  target: { companyId, teamId },
  databases: {
    nco: {
      path: ncoDbPath,
      integrityCheck: nco.pragma("integrity_check", { simple: true }),
    },
    novaAx: {
      path: novaAxDbPath,
      production: true,
      integrityCheck: novaAx.pragma("integrity_check", { simple: true }),
    },
  },
  sourceWork: {
    organization,
    activeTeamCount: Number(activeTeams.count),
    workReport: {
      id: workReport.id,
      status: workReport.status,
      subjectKind: workReport.subject_kind,
      subjectId: workReport.subject_id,
      organizationId: workReport.organization_id,
      teamId: workReport.team_id,
      sourceTaskId: workReport.source_task_id,
      reportDate: workReport.report_date,
      reportSlot: workReport.report_slot,
      submittedAt: workReport.submitted_at,
      bodySha256,
    },
    sourceTask: {
      id: sourceTask.id,
      status: sourceTask.status,
      assignedTo: sourceTask.assigned_to,
      completedAt: sourceTask.completed_at,
      error: sourceTask.error,
      responseSha256,
    },
    responseMatchesPersistedBody: responseSha256 === bodySha256,
    mirror: {
      path: mirrorPath,
      sha256: sha256(mirror),
      byteSize: mirror.byteLength,
      containsWorkReportId: mirror.includes(Buffer.from(workReportId)),
      containsBody: mirror.includes(Buffer.from(workReport.body_md)),
    },
  },
  verification: {
    scope,
    auditDirective,
    directiveTask,
    counts,
    approvedRun,
    receipt,
    loop,
    attempt: attempt
      ? { ...attempt, criteria: JSON.parse(attempt.criteria_json) }
      : null,
    remediationCounts,
    completionEvent: completionEvent
      ? {
          ...completionEvent,
          metadata: JSON.parse(completionEvent.metadata_json),
        }
      : null,
    evidenceFiles: {
      verifiedArtifact: {
        path: verifiedArtifactPath,
        sha256: sha256(verifiedArtifact),
        byteSize: verifiedArtifact.byteLength,
        matchesInspectionReference:
          inspectionResult?.evidenceRefs?.includes(sha256(verifiedArtifact)) === true,
      },
      testLog: {
        path: verificationTestLogPath,
        sha256: sha256(verificationTestLog),
        byteSize: verificationTestLog.byteLength,
        matchesPerformanceReference:
          performanceResult?.evidenceRefs?.includes(sha256(verificationTestLog)) === true,
      },
    },
  },
  runtime: {
    health,
    pm2Pid,
    pm2PidAlive,
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

nco.close();
novaAx.close();
