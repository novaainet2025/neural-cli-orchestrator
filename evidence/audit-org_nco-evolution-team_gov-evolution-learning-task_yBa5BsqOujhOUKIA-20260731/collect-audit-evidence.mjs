import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const HERE = dirname(fileURLToPath(import.meta.url));
const NCO_ROOT = resolve(HERE, "../..");
const NCO_DB = resolve(NCO_ROOT, "db/nco.db");
const AX_DB = "/Users/nova-ai/project/nova-ax/db/nova-ax.db";
const PRIOR_AUDIT =
  "/Users/nova-ai/project/nova-ax/evidence/org_nco-evolution/" +
  "team_gov-evolution-learning/2026-07-30/audit-result.json";

const TASK_ID = "task_yBa5BsqOujhOUKIA";
const TARGET_TASK_ID = "task_x21RZj7Pog5HXkTi";
const CITED_TASK_ID = "task__IhkK9T9s085QlyT";
const COMPANY_ID = "org_nco-evolution";
const TEAM_ID = "team_gov-evolution-learning";
const ACTOR_ID = "codex";

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

const json = (name, value) => {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(resolve(HERE, name), body);
  return sha256(body);
};

const commandProbe = (command, args, cwd = NCO_ROOT) => {
  try {
    const stdout = execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    return { command: [command, ...args], exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      command: [command, ...args],
      exitCode: typeof error.status === "number" ? error.status : null,
      signal: error.signal || null,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || error.message || ""),
    };
  }
};

const nco = new Database(NCO_DB, { readonly: true });
const ax = new Database(AX_DB, { readonly: true });

const subject = nco.prepare(`
  SELECT id,status,assigned_to,team_id,prompt,response,metadata_json,
         created_at,updated_at,last_activity_at,last_heartbeat_at,completed_at
  FROM tasks WHERE id=?
`).get(TASK_ID);
const target = nco.prepare(`
  SELECT id,status,assigned_to,team_id,response,metadata_json,
         created_at,updated_at,last_activity_at,last_heartbeat_at,completed_at
  FROM tasks WHERE id=?
`).get(TARGET_TASK_ID);
const citedTask = nco.prepare(`
  SELECT id,status,assigned_to,team_id,metadata_json,created_at,updated_at,completed_at
  FROM tasks WHERE id=?
`).get(CITED_TASK_ID);
const team = nco.prepare("SELECT * FROM teams WHERE id=?").get(TEAM_ID);
const organization = nco.prepare("SELECT * FROM organizations WHERE id=?").get(COMPANY_ID);

if (!subject || !target || !team || !organization) {
  throw new Error("Required NCO ground-truth row is missing");
}

const subjectBound = subject.last_activity_at;
const targetMetadata = JSON.parse(target.metadata_json || "{}");
const subjectMetadata = JSON.parse(subject.metadata_json || "{}");

const subjectRuns = ax.prepare(`
  SELECT id,task_id,company_id,team_id,actor_id,status,passed_institutions,
         evidence_digest,created_at
  FROM verification_runs WHERE task_id=? ORDER BY created_at
`).all(TASK_ID);
const subjectReceipts = ax.prepare(`
  SELECT r.id,r.run_id,r.task_id,r.company_id,r.team_id,r.actor_id,r.evidence_digest,
         r.issued_at,c.id AS consumption_id,c.event_id,c.consumed_at
  FROM verification_receipts r
  LEFT JOIN verification_receipt_consumptions c ON c.receipt_id=r.id
  WHERE r.task_id=? ORDER BY r.issued_at
`).all(TASK_ID);
const subjectLoops = ax.prepare(`
  SELECT * FROM verification_loops WHERE task_id=? ORDER BY created_at
`).all(TASK_ID);

const targetRunsAsOf = ax.prepare(`
  SELECT id,status,passed_institutions,actor_id,created_at
  FROM verification_runs
  WHERE task_id=? AND created_at <= ?
  ORDER BY created_at
`).all(TARGET_TASK_ID, subjectBound);
const targetReceiptsAsOf = ax.prepare(`
  SELECT id,run_id,actor_id,issued_at
  FROM verification_receipts
  WHERE task_id=? AND issued_at <= ?
  ORDER BY issued_at
`).all(TARGET_TASK_ID, subjectBound);
const targetLoops = ax.prepare(`
  SELECT * FROM verification_loops WHERE task_id=? ORDER BY created_at
`).all(TARGET_TASK_ID);
const targetConsumptions = ax.prepare(`
  SELECT c.id,c.receipt_id,c.event_id,c.consumed_at
  FROM verification_receipt_consumptions c
  JOIN verification_receipts r ON r.id=c.receipt_id
  WHERE r.task_id=? ORDER BY c.consumed_at
`).all(TARGET_TASK_ID);

const citedReceipts = ax.prepare(`
  SELECT r.id,r.run_id,r.task_id,r.actor_id,r.issued_at,
         c.id AS consumption_id,c.event_id,c.consumed_at
  FROM verification_receipts r
  LEFT JOIN verification_receipt_consumptions c ON c.receipt_id=r.id
  WHERE r.task_id=? ORDER BY r.issued_at
`).all(CITED_TASK_ID);

const scopeOpenLoops = ax.prepare(`
  SELECT * FROM verification_loops
  WHERE company_id=? AND team_id=? AND status IN ('action_required','resubmitted')
  ORDER BY created_at
`).all(COMPANY_ID, TEAM_ID);

const directives = ax.prepare(`
  SELECT * FROM verification_directives
  WHERE company_id=? AND team_id=?
    AND (
      subject_task_id IN (?,?)
      OR task_id IN (?,?)
    )
  ORDER BY created_at
`).all(
  COMPANY_ID,
  TEAM_ID,
  TASK_ID,
  TARGET_TASK_ID,
  TASK_ID,
  TARGET_TASK_ID,
);

const workReports = nco.prepare(`
  SELECT id,report_date,report_slot,subject_kind,subject_id,organization_id,team_id,
         status,source_task_id,submitted_at,created_at,updated_at
  FROM work_reports
  WHERE (subject_kind='organization' AND subject_id=?)
     OR (subject_kind='team' AND subject_id=?)
  ORDER BY report_date,subject_kind,report_slot
`).all(COMPANY_ID, TEAM_ID);

const reportDates = [...new Set(workReports.map((row) => row.report_date))];
const latestReportDate = reportDates.at(-1) || null;
const latestReports = workReports.filter((row) => row.report_date === latestReportDate);
const historicalMisses = workReports.filter((row) => row.status === "missed");
const submittedReports = workReports.filter((row) => row.status === "submitted");

const claims = [
  {
    id: "C01",
    claim: `No Nova-AX run existed for ${TARGET_TASK_ID} when ${TASK_ID} stopped producing output`,
    expected: 0,
    observed: targetRunsAsOf.length,
    verified: targetRunsAsOf.length === 0,
    evidence: "verification_runs bounded by subject.last_activity_at",
  },
  {
    id: "C02",
    claim: `No receipt existed for ${TARGET_TASK_ID} in the same bounded window`,
    expected: 0,
    observed: targetReceiptsAsOf.length,
    verified: targetReceiptsAsOf.length === 0,
    evidence: "verification_receipts bounded by subject.last_activity_at",
  },
  {
    id: "C03",
    claim: `No remediation loop exists for ${TARGET_TASK_ID}`,
    expected: 0,
    observed: targetLoops.length,
    verified: targetLoops.length === 0,
    evidence: "verification_loops current ledger",
  },
  {
    id: "C04",
    claim: `${TARGET_TASK_ID} remains reviewing/pending verification`,
    expected: "reviewing/pending",
    observed: `${target.status}/${targetMetadata.verificationStatus || "unset"}`,
    verified:
      target.status === "reviewing" &&
      targetMetadata.verificationStatus === "pending",
    evidence: "NCO tasks row",
  },
  {
    id: "C05",
    claim: "The cited two approved receipts belong to another task and are not reusable",
    expected: "2 receipts; 2 consumed; all bound to cited task",
    observed:
      `${citedReceipts.length} receipts; ` +
      `${citedReceipts.filter((row) => row.consumption_id).length} consumed; ` +
      `${citedReceipts.filter((row) => row.task_id === CITED_TASK_ID).length} bound to cited task`,
    verified:
      citedReceipts.length === 2 &&
      citedReceipts.every((row) => row.task_id === CITED_TASK_ID && row.consumption_id),
    evidence: "verification_receipts joined to verification_receipt_consumptions",
  },
  {
    id: "C06",
    claim: `Directive vdir_511c06cc-5695-4c79-aab2-3068a9ae731f binds ${TARGET_TASK_ID} to ${TASK_ID}`,
    expected: "matching dispatched directive",
    observed:
      directives.find(
        (row) => row.id === "vdir_511c06cc-5695-4c79-aab2-3068a9ae731f",
      ) || null,
    verified: directives.some(
      (row) =>
        row.id === "vdir_511c06cc-5695-4c79-aab2-3068a9ae731f" &&
        row.subject_task_id === TARGET_TASK_ID &&
        row.task_id === TASK_ID &&
        row.status === "dispatched",
    ),
    evidence: "verification_directives current ledger",
  },
  {
    id: "C07",
    claim: `${TASK_ID} was running at the exact time its report text was emitted`,
    expected: "historical state transition evidence",
    observed: `current task row is ${subject.status}; no immutable task-status history row was found`,
    verified: false,
    evidence: "snapshot task row is insufficient to reconstruct the prior transient state",
  },
  {
    id: "C08",
    claim: "The two HTTP_STATUS:000 observations prove that both services were down",
    expected: "server-side availability evidence",
    observed:
      "current shell cannot connect; sandbox also denies listen and PM2 RPC access, " +
      "so client-side HTTP 000 does not identify the server-side cause",
    verified: false,
    evidence: "runtime probes below; causal attribution remains unverified",
  },
];

const runtimeProbes = {
  ncoHealth: commandProbe("curl", [
    "-sS",
    "--max-time",
    "5",
    "-w",
    "\nHTTP_STATUS:%{http_code}\n",
    "http://127.0.0.1:6200/api/health",
  ]),
  novaAxHealth: commandProbe("curl", [
    "-sS",
    "--max-time",
    "5",
    "-w",
    "\nHTTP_STATUS:%{http_code}\n",
    "http://127.0.0.1:6300/api/health",
  ]),
  pm2Supervisor: commandProbe("pm2", ["jlist"]),
};

const fileEvidence = [NCO_DB, AX_DB, PRIOR_AUDIT].map((path) => {
  const body = readFileSync(path);
  const stat = statSync(path);
  return {
    path,
    byteSize: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256: sha256(body),
  };
});

const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  audit: {
    companyId: COMPANY_ID,
    teamId: TEAM_ID,
    taskId: TASK_ID,
    targetOfSubjectReport: TARGET_TASK_ID,
    actorId: ACTOR_ID,
    evidenceTier: "T1 SQLite rows + file bytes; runtime probes are T2 diagnostics",
  },
  subjectBound,
  organization,
  team,
  subject: { ...subject, metadata: subjectMetadata },
  target: { ...target, metadata: targetMetadata },
  citedTask,
  verification: {
    subjectRuns,
    subjectReceipts,
    subjectLoops,
    targetRunsAsOf,
    targetReceiptsAsOf,
    targetLoops,
    targetConsumptions,
    citedReceipts,
    scopeOpenLoops,
    directives,
  },
  workReportObligations: {
    total: workReports.length,
    submitted: submittedReports.length,
    missed: historicalMisses.length,
    latestReportDate,
    latestTotal: latestReports.length,
    latestSubmitted: latestReports.filter((row) => row.status === "submitted").length,
    historicalMisses,
    rows: workReports,
  },
  claims,
  runtimeProbes,
  fileEvidence,
  completionGate: {
    canClaimDone: false,
    reasons: [
      `${TASK_ID} has no fresh verification run`,
      `${TASK_ID} has no approved receipt`,
      "NCO completion binding was not attempted without a valid current-task receipt",
      `${historicalMisses.length} company/team work-report obligations remain missed in the ledger`,
      "Nova-AX and NCO connector calls were cancelled outside this collector",
    ],
  },
};

nco.close();
ax.close();

const evidenceHash = json("audit-evidence.json", evidence);
const verifiedClaims = claims.filter((item) => item.verified);
const unverifiedClaims = claims.filter((item) => !item.verified);

const lines = [
  `# Blocked audit — ${TASK_ID}`,
  "",
  `- Company/team: \`${COMPANY_ID}\` / \`${TEAM_ID}\``,
  `- Evidence generated: ${evidence.generatedAt}`,
  `- Evidence SHA-256: \`${evidenceHash}\``,
  `- Subject output bound: ${subjectBound}`,
  "",
  "## Current completion gate",
  "",
  `- Fresh run for current task: ${subjectRuns.length}`,
  `- Current-task receipts: ${subjectReceipts.length}`,
  `- Current-task open loops: ${subjectLoops.filter((row) => ["action_required", "resubmitted"].includes(row.status)).length}`,
  `- Scope open loops: ${scopeOpenLoops.length}`,
  `- NCO task state: ${subject.status}/${subjectMetadata.verificationStatus || "unset"}`,
  "- Completion binding: not attempted because no valid current-task receipt exists",
  "",
  "## Institution decisions",
  "",
  "| Institution | Decision |",
  "|---|---|",
  "| inspection | unverified |",
  "| validation | unverified |",
  "| measurement | unverified |",
  "| performance | unverified |",
  "| optimization | unverified |",
  "| goal | unverified |",
  "",
  "## Work-report obligations in current scope",
  "",
  `- Latest scheduled date (${latestReportDate}): ${latestReports.filter((row) => row.status === "submitted").length}/${latestReports.length} submitted`,
  `- All ledger rows: ${submittedReports.length}/${workReports.length} submitted`,
  `- Historical missed rows: ${historicalMisses.length}`,
  ...historicalMisses.map(
    (row) =>
      `  - ${row.id}: ${row.report_date} ${row.report_slot}, ${row.subject_kind}/${row.subject_id}`,
  ),
  "",
  "## Subject-report adjudication",
  "",
  `- Verified claims: ${verifiedClaims.length}/${claims.length}`,
  ...verifiedClaims.map(
    (item) => `  - ${item.id}: ${item.claim} → ${JSON.stringify(item.observed)}`,
  ),
  `- Unverified claims: ${unverifiedClaims.length}/${claims.length}`,
  ...unverifiedClaims.map(
    (item) => `  - ${item.id}: ${item.claim} → ${JSON.stringify(item.observed)}`,
  ),
  "",
  "## Remaining blockers",
  "",
  ...evidence.completionGate.reasons.map((reason) => `- ${reason}`),
  "",
  "## Ground-truth files",
  "",
  ...fileEvidence.map(
    (item) =>
      `- \`${item.path}\` — ${item.byteSize} bytes — SHA-256 \`${item.sha256}\``,
  ),
  "",
];

writeFileSync(resolve(HERE, "AUDIT-REPORT.md"), `${lines.join("\n")}\n`);
console.log(
  JSON.stringify(
    {
      ok: true,
      taskId: TASK_ID,
      evidenceHash,
      freshRunCount: subjectRuns.length,
      receiptCount: subjectReceipts.length,
      scopeOpenLoops: scopeOpenLoops.length,
      latestWorkReports: `${latestReports.filter((row) => row.status === "submitted").length}/${latestReports.length}`,
      allWorkReports: `${submittedReports.length}/${workReports.length}`,
      verifiedClaims: `${verifiedClaims.length}/${claims.length}`,
      reportPath: resolve(HERE, "AUDIT-REPORT.md"),
      evidencePath: resolve(HERE, "audit-evidence.json"),
    },
    null,
    2,
  ),
);
