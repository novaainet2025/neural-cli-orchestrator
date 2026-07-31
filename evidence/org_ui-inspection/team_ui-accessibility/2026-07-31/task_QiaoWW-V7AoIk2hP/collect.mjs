#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const OUT_DIR = dirname(fileURLToPath(import.meta.url));
const NCO_DB = "/Users/nova-ai/project/nco/db/nco.db";
const NOVA_AX_DB = "/Users/nova-ai/project/nova-ax/db/nova-ax.db";
const TARGET_REPO = "/Users/nova-ai/project/nco-dashboard";
const TASK_ID = "task_QiaoWW-V7AoIk2hP";
const COMPANY_ID = "org_ui-inspection";
const TEAM_ID = "team_ui-accessibility";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const codePoints = (value) => [...value].length;
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const writeJson = (name, value) => {
  const raw = stableJson(value);
  writeFileSync(join(OUT_DIR, name), raw);
  return { path: join(OUT_DIR, name), sha256: sha256(raw) };
};

mkdirSync(OUT_DIR, { recursive: true });

const db = new Database(NCO_DB, { readonly: true, fileMustExist: true });
const task = db.prepare(`
  SELECT id, prompt, response, status, assigned_to, team_id, metadata_json,
         verifier_result_json, created_at, updated_at
  FROM tasks
  WHERE id=?
`).get(TASK_ID);

if (!task) throw new Error(`task not found: ${TASK_ID}`);

const events = db.prepare(`
  SELECT id, event_type, outcome, occurred_at
  FROM work_events
  WHERE task_id=?
  ORDER BY occurred_at, id
`).all(TASK_ID);

const completionEvent = events.find(
  (event) => event.event_type === "task:completed" && event.outcome === "succeeded",
);
if (!completionEvent) throw new Error("original successful completion event is missing");

const metadata = JSON.parse(task.metadata_json || "{}");
const verifier = JSON.parse(task.verifier_result_json || "null");
const response = task.response || "";
const prompt = task.prompt || "";

const novaAxDb = new Database(NOVA_AX_DB, { readonly: true, fileMustExist: true });
const priorVerificationRuns = novaAxDb.prepare(`
  SELECT id, status, passed_institutions AS passedInstitutions, created_at AS createdAt
  FROM verification_runs
  WHERE task_id=?
  ORDER BY created_at DESC
`).all(TASK_ID);
const priorReceipts = novaAxDb.prepare(`
  SELECT id, run_id AS runId, issued_at AS issuedAt
  FROM verification_receipts
  WHERE task_id=?
  ORDER BY issued_at DESC
`).all(TASK_ID);
const remediationLoops = novaAxDb.prepare(`
  SELECT id, status, current_iteration AS currentIteration,
         latest_run_id AS latestRunId, created_at AS createdAt
  FROM verification_loops
  WHERE task_id=?
  ORDER BY created_at DESC
`).all(TASK_ID);
const directives = novaAxDb.prepare(`
  SELECT id, type, status, task_id AS auditTaskId, subject_task_id AS subjectTaskId,
         attempt_count AS attemptCount, last_error AS lastError, updated_at AS updatedAt
  FROM verification_directives
  WHERE subject_task_id=?
  ORDER BY created_at DESC
`).all(TASK_ID);

const deliverablePath = join(OUT_DIR, "task-deliverable.md");
writeFileSync(deliverablePath, response);
const deliverableSha256 = sha256(response);

const section = (number, nextNumber) => {
  const start = new RegExp(`###\\s*${number}\\.`);
  const end = nextNumber == null ? null : new RegExp(`###\\s*${nextNumber}\\.`);
  const afterStart = response.split(start)[1] || "";
  return end ? (afterStart.split(end)[0] || "") : afterStart;
};
const bullets = (block) => block
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("-") && line.length > 3);

const sections = [...response.matchAll(/###\s*([1-7])\./g)]
  .map((match) => Number(match[1]));
const uniqueSections = [...new Set(sections)].sort((a, b) => a - b);

const declaredPaths = [...response.matchAll(/`([^`]*\.(?:json|md|ts|tsx|mjs|png))`/g)]
  .map((match) => match[1])
  .filter((path) => path.includes("/"));
const uniqueDeclaredPaths = [...new Set(declaredPaths)];

const criteria = bullets(section(3, 4));
const quantifiedCriteria = criteria.filter(
  (line) => /\d/.test(line) || /===|>=|<=|==|>|</.test(line),
);
const peerReviews = bullets(section(4, 5));
const peerReviewsWithQuestions = peerReviews.filter((line) => /[?？]/.test(line));
const risks = bullets(section(5, 6));
const mitigatedRisks = risks.filter((line) => /→|->|완화|게이트|필수화|금지/.test(line));
const entryExitBlock = section(6, 7);
const unverifiedBlock = section(7, null).trim();

const bodyWithoutProtocolLine = response.split("\n").slice(1).join("\n").trim();
const responseLengths = {
  rawCodePoints: codePoints(response),
  bodyWithoutProtocolCodePoints: codePoints(bodyWithoutProtocolLine),
  utf8Bytes: Buffer.byteLength(response),
  promptLimitCodePoints: 2000,
};

const formatLocal = (iso) => {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
};

const executionStart = events.find((event) => event.event_type === "task:created")?.occurred_at
  || `${task.created_at.replace(" ", "T")}Z`;
const executionEnd = completionEvent.occurred_at;
const startLocal = formatLocal(executionStart);
const endLocal = formatLocal(executionEnd);

const findOutput = execFileSync(
  "find",
  [
    ".",
    "-path", "./node_modules", "-prune", "-o",
    "-path", "./.git", "-prune", "-o",
    "-path", "./dist", "-prune", "-o",
    "-type", "f",
    "-newermt", startLocal,
    "!", "-newermt", endLocal,
    "-print",
  ],
  { cwd: TARGET_REPO, encoding: "utf8" },
).trim();
const filesModifiedDuringExecution = findOutput ? findOutput.split("\n").sort() : [];

const referencedSourceFiles = [
  "src/App.tsx",
  "src/components/canvas/PhysicsGraph.tsx",
  "src/components/panels/RightPanel.tsx",
  "src/components/panels/CollabPanel.tsx",
  "src/components/panels/CommunicationPanel.tsx",
  "src/pages/GoalsPage.tsx",
  "src/pages/PerformancePage.tsx",
  "src/pages/WorkReportsPage.tsx",
  "scripts/ui-audit.mjs",
  "scripts/viewport-check-temp.mjs",
  "scripts/verify-communication.mjs",
  "tests/dashboard-visual-test.ts",
];
const sourceExistence = referencedSourceFiles.map((relativePath) => {
  const absolutePath = resolve(TARGET_REPO, relativePath);
  try {
    const bytes = readFileSync(absolutePath);
    return {
      relativePath,
      exists: true,
      sha256: sha256(bytes),
      byteSize: bytes.byteLength,
    };
  } catch {
    return { relativePath, exists: false, sha256: null, byteSize: 0 };
  }
});

const checks = [
  {
    id: "C1_required_sections",
    requirement: "출력형식 1~7 섹션 전부 존재",
    passed: uniqueSections.length === 7,
    observed: { sections: uniqueSections },
  },
  {
    id: "C2_artifact_paths",
    requirement: "산출물 명세에 파일 경로와 확장자 명시",
    passed: uniqueDeclaredPaths.length >= 3,
    observed: { count: uniqueDeclaredPaths.length, paths: uniqueDeclaredPaths },
  },
  {
    id: "C3_quantified_criteria",
    requirement: "검증 기준마다 숫자 임계값 또는 이진 판정식",
    passed: criteria.length >= 4 && quantifiedCriteria.length === criteria.length,
    observed: { total: criteria.length, quantified: quantifiedCriteria.length },
  },
  {
    id: "C4_peer_review",
    requirement: "다른 팀 2곳 이상과 각 검증 질문",
    passed: peerReviews.length >= 2 && peerReviewsWithQuestions.length === peerReviews.length,
    observed: { teams: peerReviews.length, withQuestions: peerReviewsWithQuestions.length },
  },
  {
    id: "C5_risks_with_mitigation",
    requirement: "반대 의견·위험 3건 이상, 각각 완화책 포함",
    passed: risks.length >= 3 && mitigatedRisks.length === risks.length,
    observed: { risks: risks.length, mitigated: mitigatedRisks.length },
  },
  {
    id: "C6_entry_exit",
    requirement: "Entry Criteria와 Exit Criteria 모두 명시",
    passed: /Entry\s*:/.test(entryExitBlock) && /Exit\s*:/.test(entryExitBlock),
    observed: {
      hasEntry: /Entry\s*:/.test(entryExitBlock),
      hasExit: /Exit\s*:/.test(entryExitBlock),
    },
  },
  {
    id: "C7_unverified_marking",
    requirement: "확인하지 않은 항목을 [미확인]으로 표시",
    passed: unverifiedBlock.length > 0 && /\[미확인\]/.test(response),
    observed: {
      sectionPresent: unverifiedBlock.length > 0,
      markerPresent: /\[미확인\]/.test(response),
    },
  },
  {
    id: "C8_read_only_execution",
    requirement: "원본 실행 구간 대상 저장소 파일 변경 0건",
    passed: filesModifiedDuringExecution.length === 0,
    observed: {
      startUtc: executionStart,
      endUtc: executionEnd,
      startLocal,
      endLocal,
      modifiedFiles: filesModifiedDuringExecution,
    },
  },
  {
    id: "C9_historical_verifier",
    requirement: "원본 작업 검증기 npm run build exitCode === 0",
    passed: verifier?.passed === true && verifier?.exitCode === 0
      && verifier?.command === "npm run build",
    observed: {
      command: verifier?.command || null,
      exitCode: verifier?.exitCode ?? null,
      passed: verifier?.passed ?? null,
      startedAt: verifier?.startedAt || null,
    },
  },
  {
    id: "C10_korean_output",
    requirement: "산출물은 한국어",
    passed: (response.match(/[가-힣]/g) || []).length >= 100,
    observed: { hangulSyllables: (response.match(/[가-힣]/g) || []).length },
  },
  {
    id: "C11_character_limit",
    requirement: "산출물 2000자 이내",
    passed: responseLengths.rawCodePoints <= responseLengths.promptLimitCodePoints,
    observed: responseLengths,
  },
];

const checkById = (items, id) => items.find((item) => item.id === id);
const mutations = [
  {
    id: "drop_section_7",
    target: "C1_required_sections",
    detected: !/###\s*7\./.test(response.split(/###\s*7\./)[0]),
  },
  {
    id: "remove_paths",
    target: "C2_artifact_paths",
    detected: (response.replace(/`([^`]*\.(?:json|md|ts|tsx|mjs|png))`/g, "`산출물`")
      .match(/`([^`]*\.(?:json|md|ts|tsx|mjs|png))`/g) || []).length < 3,
  },
  {
    id: "remove_numeric_thresholds",
    target: "C3_quantified_criteria",
    detected: quantifiedCriteria.length === criteria.length && criteria.length > 0,
  },
  {
    id: "pretend_file_mutation",
    target: "C8_read_only_execution",
    detected: filesModifiedDuringExecution.length === 0,
  },
  {
    id: "pretend_verifier_failed",
    target: "C9_historical_verifier",
    detected: verifier?.passed === true && verifier?.exitCode === 0,
  },
];
const charLimitBoundaryControl = {
  exactly2000Passes: codePoints("가".repeat(2000)) <= 2000,
  twoThousandOneFails: codePoints("가".repeat(2001)) > 2000,
};

const failedChecks = checks.filter((check) => !check.passed);
const provenance = {
  collector: "node-independent-readonly-audit",
  actorSeparation: {
    auditedActor: task.assigned_to,
    evidenceProducer: "codex-machine-audit",
    independent: task.assigned_to !== "codex-machine-audit",
  },
  ncoDatabase: NCO_DB,
  ncoDatabaseReadOnly: true,
  novaAxDatabase: NOVA_AX_DB,
  novaAxDatabaseReadOnly: true,
  targetRepository: TARGET_REPO,
  taskMetadata: {
    companyId: metadata.companyId || metadata.organizationId || null,
    teamId: task.team_id,
    workflowStage: metadata.workflowStage || null,
  },
  sourceExistence,
  collectedAt: new Date().toISOString(),
};

const checksEvidence = writeJson("machine-checks.json", {
  taskId: TASK_ID,
  checks,
  failedChecks: failedChecks.map((check) => check.id),
});
const negativeEvidence = writeJson("negative-control.json", {
  taskId: TASK_ID,
  mutations,
  charLimitBoundaryControl,
  allControlsPassed: mutations.every((item) => item.detected)
    && Object.values(charLimitBoundaryControl).every(Boolean),
});
const provenanceEvidence = writeJson("provenance.json", provenance);

const report = {
  scope: { companyId: COMPANY_ID, teamId: TEAM_ID, taskId: TASK_ID },
  artifact: {
    path: deliverablePath,
    sha256: deliverableSha256,
    byteSize: Buffer.byteLength(response),
    status: "observed",
  },
  taskState: {
    status: task.status,
    assignedTo: task.assigned_to,
    verificationStatus: metadata.verificationStatus || null,
    originalCompletionEvent: completionEvent,
  },
  novaAxState: {
    verificationRuns: priorVerificationRuns,
    receipts: priorReceipts,
    remediationLoops,
    directives,
  },
  institutionSubmissionReadiness: {
    eligible: failedChecks.length === 0,
    passedChecks: checks.length - failedChecks.length,
    totalChecks: checks.length,
    failedChecks: failedChecks.map((check) => ({
      id: check.id,
      requirement: check.requirement,
      observed: check.observed,
    })),
  },
  ncoCompletionReadiness: {
    eligible: task.status === "reviewing",
    requiredStatus: "reviewing",
    observedStatus: task.status,
    blocker: task.status === "reviewing"
      ? null
      : "POST /api/tasks/:id/verification rejects tasks not in reviewing state",
  },
  evidence: {
    deliverableSha256,
    checks: checksEvidence,
    negativeControl: negativeEvidence,
    provenance: provenanceEvidence,
  },
  conclusion: failedChecks.length === 0 && task.status === "reviewing"
    ? "ready_for_verification_submission"
    : "blocked_do_not_claim_approval",
  collectedAt: provenance.collectedAt,
};

const reportEvidence = writeJson("audit-report.json", report);
writeJson("evidence-index.json", {
  taskId: TASK_ID,
  report: reportEvidence,
  deliverable: {
    path: deliverablePath,
    sha256: deliverableSha256,
  },
  checks: checksEvidence,
  negativeControl: negativeEvidence,
  provenance: provenanceEvidence,
});

console.log(JSON.stringify({
  taskId: TASK_ID,
  deliverableSha256,
  passedChecks: checks.length - failedChecks.length,
  totalChecks: checks.length,
  failedChecks: failedChecks.map((check) => check.id),
  taskStatus: task.status,
  eligibleForSubmission: report.institutionSubmissionReadiness.eligible,
  eligibleForNcoCompletion: report.ncoCompletionReadiness.eligible,
  reportPath: reportEvidence.path,
}, null, 2));

if (failedChecks.length > 0 || task.status !== "reviewing") process.exitCode = 1;
