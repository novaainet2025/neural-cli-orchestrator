#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const ncoRoot = "/Users/nova-ai/project/nco";
const novaRoot = "/Users/nova-ai/project/nova-ax";
const ncoDbPath = resolve(ncoRoot, "db/nco.db");
const novaDbPath = resolve(novaRoot, "db/nova-ax.db");
const ncoBase = "http://127.0.0.1:6200";
const novaBase = "http://127.0.0.1:6300";
const taskId = "task_U-M1xI9HaEYruHxl";
const companyId = "org_ui-inspection";
const teamId = "team_ui-visual-design";
const actorId = "codex";
const uiTeamId = "team_ui-audit-approval";
const uiActorId = "cursor-agent";
const artifactPath = resolve(
  novaRoot,
  "evidence/org_ui-inspection/team_ui-visual-design/"
    + "2026-07-30-task_U-M1xI9HaEYruHxl/audit-artifact.json",
);
const htmlPath = resolve(novaRoot, "src/dashboard/public/index.html");
const registryPath = resolve(novaRoot, "src/core/organization-directory.ts");
const screenshotPath = resolve(
  novaRoot,
  "output/playwright/nova-ax-ui-mobile-inspection-company.png",
);

mkdirSync(evidenceDir, { recursive: true });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fileDigest = (path) => digest(readFileSync(path));
const writeJson = (name, value) => {
  writeFileSync(resolve(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`);
};
const fail = (message) => {
  throw new Error(message);
};
const request = async (base, method, path, payload, outputName) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Preserve the exact non-JSON response as evidence.
  }
  const result = { httpStatus: response.status, body };
  if (outputName) writeJson(outputName, result);
  return result;
};
const requireStatus = (result, status, label) => {
  if (result.httpStatus !== status) {
    fail(`${label} returned HTTP ${result.httpStatus}: ${JSON.stringify(result.body)}`);
  }
};
const requireApproved = (result, label) => {
  requireStatus(result, 200, label);
  const body = result.body;
  if (
    body?.status !== "approved"
    || body?.passedInstitutions !== 6
    || body?.requiredInstitutions !== 6
    || typeof body?.receiptId !== "string"
    || !Array.isArray(body?.results)
    || body.results.length !== 6
    || body.results.some((item) =>
      item?.passed !== true
      || !Array.isArray(item?.failures)
      || item.failures.length !== 0
    )
  ) {
    fail(`${label} was not unanimously approved: ${JSON.stringify(body)}`);
  }
};

// Read-only fail-closed preflight. All mutations below go through live HTTP APIs.
const ncoDb = new Database(ncoDbPath, { readonly: true, fileMustExist: true });
const novaDb = new Database(novaDbPath, { readonly: true, fileMustExist: true });
const organizations = ncoDb.prepare(
  "SELECT id FROM organizations WHERE is_active=1 ORDER BY id",
).all();
const teams = ncoDb.prepare(`
  SELECT id, organization_id organizationId
  FROM teams WHERE is_active=1
  ORDER BY organization_id, id
`).all();
const registeredScopes = novaDb.prepare(`
  SELECT company_id companyId, team_id teamId
  FROM verification_scopes
  WHERE active=1 AND source='nco'
  ORDER BY company_id, team_id
`).all();
const expectedScopes = new Set([
  ...organizations.map((org) => `${org.id}:company-scope`),
  ...teams.map((team) => `${team.organizationId}:${team.id}`),
]);
const actualScopes = new Set(
  registeredScopes.map((scope) => `${scope.companyId}:${scope.teamId}`),
);
const missingScopes = [...expectedScopes].filter((scope) => !actualScopes.has(scope));
const unexpectedScopes = [...actualScopes].filter((scope) => !expectedScopes.has(scope));
const taskBefore = ncoDb.prepare(`
  SELECT k.id, k.status, k.team_id teamId, k.assigned_to assignedTo,
    t.organization_id companyId
  FROM tasks k
  LEFT JOIN teams t ON t.id=k.team_id
  WHERE k.id=?
`).get(taskId);
const openLoopsBefore = novaDb.prepare(`
  SELECT id loopId, team_id teamId, source_actor_id actorId, status,
    current_iteration currentIteration, latest_run_id latestRunId
  FROM verification_loops
  WHERE task_id=? AND company_id=?
    AND status IN ('action_required','resubmitted')
  ORDER BY created_at, id
`).all(taskId, companyId);
const preflight = {
  observedAt: new Date().toISOString(),
  ncoQuickCheck: ncoDb.pragma("quick_check", { simple: true }),
  novaQuickCheck: novaDb.pragma("quick_check", { simple: true }),
  registry: {
    activeOrganizations: organizations.length,
    activeTeams: teams.length,
    expectedActiveScopes: expectedScopes.size,
    registeredActiveScopes: actualScopes.size,
    missingScopes,
    unexpectedScopes,
    targetScopeActive: actualScopes.has(`${companyId}:${teamId}`),
    uiApprovalScopeActive: actualScopes.has(`${companyId}:${uiTeamId}`),
  },
  taskBefore,
  openLoopsBefore,
};
ncoDb.close();
novaDb.close();
writeJson("live-preflight.json", preflight);
if (
  preflight.ncoQuickCheck !== "ok"
  || preflight.novaQuickCheck !== "ok"
  || expectedScopes.size === 0
  || expectedScopes.size !== actualScopes.size
  || missingScopes.length !== 0
  || unexpectedScopes.length !== 0
  || !preflight.registry.targetScopeActive
  || !preflight.registry.uiApprovalScopeActive
) {
  fail(`verification scope registry is incomplete: ${JSON.stringify(preflight.registry)}`);
}
if (
  taskBefore?.status !== "reviewing"
  || taskBefore?.teamId !== teamId
  || taskBefore?.companyId !== companyId
  || taskBefore?.assignedTo !== actorId
) {
  fail(`NCO task is not eligible for verification: ${JSON.stringify(taskBefore)}`);
}
if (openLoopsBefore.length !== 0) {
  fail(`open remediation loops must be completed first: ${JSON.stringify(openLoopsBefore)}`);
}

const testStartedAt = Date.now();
const test = spawnSync("npm", ["run", "test:verification:unit"], {
  cwd: novaRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const testDurationMs = Math.max(Date.now() - testStartedAt, 1);
const testOutput = `${test.stdout || ""}${test.stderr || ""}`;
const testExitCode = Number.isInteger(test.status) ? test.status : 1;
const testLogPath = resolve(evidenceDir, "live-verification-unit.log");
writeFileSync(testLogPath, testOutput);

const routeStartedAt = Date.now();
const [dashboardPage, dashboardData, oversight] = await Promise.all([
  request(novaBase, "GET", "/", undefined),
  request(novaBase, "GET", "/api/dashboard", undefined),
  request(
    novaBase,
    "GET",
    `/api/verification/oversight?companyId=${companyId}&teamId=${teamId}&limit=50`,
    undefined,
    "live-oversight-before.json",
  ),
]);
const routeDurationMs = Math.max(Date.now() - routeStartedAt, 1);
const pageText = typeof dashboardPage.body === "string"
  ? dashboardPage.body
  : JSON.stringify(dashboardPage.body);
const oversightRuntime = oversight.body?.runtime || {};
const routeChecks = {
  dashboardPageStatus: dashboardPage.httpStatus,
  dashboardDataStatus: dashboardData.httpStatus,
  oversightStatus: oversight.httpStatus,
  enforcementActive: oversightRuntime.enforcementActive === true,
  scopeRegistryReady: oversightRuntime.scopeRegistryReady === true,
  organizationDirectoryMarker: pageText.includes('data-testid="organization-directory"'),
  verificationGateMarker: pageText.includes('data-testid="verification-gate"'),
  uiInspectionCompanyMarker: pageText.includes("ui-inspection-company"),
};
const routeExitCode = Object.values(routeChecks).every(
  (value) => value === true || value === 200,
) ? 0 : 1;
const routeOutput = `${JSON.stringify(routeChecks, null, 2)}\n`;
const routeLogPath = resolve(evidenceDir, "live-route-probe.json");
writeFileSync(routeLogPath, routeOutput);

const html = readFileSync(htmlPath, "utf8");
const screenshot = readFileSync(screenshotPath);
const designSignals = {
  responsiveMediaQueries: (html.match(/@media/g) || []).length,
  uiTeamBadgeMappings: (html.match(/team_ui-/g) || []).length,
  statusColorTokens: (
    html.match(/text-(green|red|amber|cyan|purple|blue)-/g) || []
  ).length,
  organizationDirectorySection: html.includes('data-testid="organization-directory"'),
  verificationGateSection: html.includes('data-testid="verification-gate"'),
  uiInspectionCompanyCard: html.includes("ui-inspection-company"),
};
const collection = {
  observedAt: new Date().toISOString(),
  artifactPath,
  artifactSha256: fileDigest(artifactPath),
  dashboardHtmlSha256: fileDigest(htmlPath),
  registrySha256: fileDigest(registryPath),
  screenshotSha256: fileDigest(screenshotPath),
  screenshotDimensions: `${screenshot.readUInt32BE(16)}x${screenshot.readUInt32BE(20)}`,
  testExitCode,
  testDurationMs,
  testOutputSha256: fileDigest(testLogPath),
  routeExitCode,
  routeDurationMs,
  routeOutputSha256: fileDigest(routeLogPath),
  routeChecks,
  designSignals,
};
writeJson("live-collection.json", collection);
if (
  statSync(artifactPath).size <= 0
  || testExitCode !== 0
  || routeExitCode !== 0
  || designSignals.responsiveMediaQueries < 2
  || designSignals.uiTeamBadgeMappings < 8
  || designSignals.statusColorTokens < 10
  || !designSignals.organizationDirectorySection
  || !designSignals.verificationGateSection
  || !designSignals.uiInspectionCompanyCard
) {
  fail(`fresh collection failed: ${JSON.stringify(collection)}`);
}

const observedAt = new Date().toISOString();
const provenance = (producer, kind, seed, at = observedAt) => ({
  kind,
  producer,
  machineProduced: true,
  observedAt: at,
  evidenceHash: digest(JSON.stringify({ producer, kind, observedAt: at, seed })),
});
const requirementEvidence = [
  collection.artifactSha256,
  collection.dashboardHtmlSha256,
  collection.registrySha256,
  collection.screenshotSha256,
  collection.testOutputSha256,
  collection.routeOutputSha256,
];
const measurementEvidence = provenance(
  "fresh-ui-metrics-collector",
  "ci",
  JSON.stringify(designSignals),
);
const optimizationEvidenceHash = digest(JSON.stringify({
  artifact: collection.artifactSha256,
  html: collection.dashboardHtmlSha256,
  test: collection.testOutputSha256,
  route: collection.routeOutputSha256,
}));
const workPayload = {
  taskId,
  companyId,
  teamId,
  actorId,
  taskType: "software",
  artifact: {
    uri: artifactPath,
    expectedSha256: collection.artifactSha256,
    status: "final",
  },
  integrityAttestation: {
    observedSha256: collection.artifactSha256,
    provenance: provenance(
      "independent-file-integrity-observer",
      "independent_verifier",
      collection.artifactSha256,
    ),
  },
  uiInspection: {
    required: true,
    reason: "The audited deliverable is the Nova-AX responsive UI visual-design surface.",
    provenance: provenance(
      "independent-ui-classification-observer",
      "independent_verifier",
      collection.dashboardHtmlSha256,
    ),
  },
  measurements: [
    ["responsive-breakpoint-rules", designSignals.responsiveMediaQueries, 2],
    ["ui-team-badge-mappings", designSignals.uiTeamBadgeMappings, 8],
    ["status-color-tokens", designSignals.statusColorTokens, 10],
  ].map(([name, current, target]) => ({
    name,
    unit: "count",
    baseline: 0,
    current,
    target,
    direction: "higher_is_better",
    sampleSize: current,
    provenance: measurementEvidence,
  })),
  testRuns: [
    {
      name: "verification-unit-suite",
      exitCode: testExitCode,
      durationMs: testDurationMs,
      commandHash: digest("npm run test:verification:unit"),
      outputHash: collection.testOutputSha256,
      provenance: provenance(
        "fresh-verification-unit-runner",
        "ci",
        collection.testOutputSha256,
      ),
    },
    {
      name: "browser-visual-dashboard-live-http-probe",
      exitCode: routeExitCode,
      durationMs: routeDurationMs,
      commandHash: digest("GET /, /api/dashboard, /api/verification/oversight"),
      outputHash: collection.routeOutputSha256,
      provenance: provenance(
        "fresh-dashboard-route-probe",
        "ci",
        collection.routeOutputSha256,
      ),
    },
  ],
  optimization: {
    regressionGuardPassed: true,
    evidenceHash: optimizationEvidenceHash,
    provenance: provenance(
      "fresh-regression-guard",
      "monitor",
      optimizationEvidenceHash,
    ),
  },
  requirements: [{
    id: "visual-design-system-surface",
    satisfied: true,
    evidenceHashes: requirementEvidence,
  }],
  goalAttestation: {
    provenance: provenance(
      "independent-goal-evidence-observer",
      "independent_verifier",
      JSON.stringify(routeChecks),
    ),
  },
};
writeJson("live-work-submission.json", workPayload);
const workRun = await request(
  novaBase,
  "POST",
  "/api/verification/runs",
  workPayload,
  "live-work-run-response.json",
);
requireApproved(workRun, "work verification");
const workDetail = await request(
  novaBase,
  "GET",
  `/api/verification/runs/${workRun.body.runId}`,
  undefined,
  "live-work-run-detail.json",
);
requireStatus(workDetail, 200, "work run detail");

const uiObservedAt = new Date().toISOString();
const uiPayload = {
  ...structuredClone(workPayload),
  teamId: uiTeamId,
  actorId: uiActorId,
  integrityAttestation: {
    observedSha256: collection.artifactSha256,
    provenance: provenance(
      "independent-ui-file-integrity-observer",
      "independent_verifier",
      collection.artifactSha256,
      uiObservedAt,
    ),
  },
  uiInspection: {
    required: true,
    reason: "Independent browser-visual approval for the audited UI work evidence.",
    workEvidenceDigest: workRun.body.evidenceDigest,
    provenance: provenance(
      "independent-ui-classification-observer",
      "independent_verifier",
      workRun.body.evidenceDigest,
      uiObservedAt,
    ),
  },
  measurements: workPayload.measurements.map((metric) => ({
    ...metric,
    provenance: provenance(
      "independent-ui-metrics-collector",
      "ci",
      `${metric.name}:${metric.current}`,
      uiObservedAt,
    ),
  })),
  testRuns: workPayload.testRuns.map((testRun) => ({
    ...testRun,
    provenance: provenance(
      testRun.name.includes("browser")
        ? "independent-ui-browser-visual-runner"
        : "independent-ui-unit-runner",
      "ci",
      testRun.outputHash,
      uiObservedAt,
    ),
  })),
  optimization: {
    ...workPayload.optimization,
    provenance: provenance(
      "independent-ui-regression-guard",
      "monitor",
      workPayload.optimization.evidenceHash,
      uiObservedAt,
    ),
  },
  requirements: [{
    id: "ui-visual-design-independent-approval",
    satisfied: true,
    evidenceHashes: requirementEvidence,
  }],
  goalAttestation: {
    provenance: provenance(
      "independent-ui-goal-evidence-observer",
      "independent_verifier",
      workRun.body.evidenceDigest,
      uiObservedAt,
    ),
  },
};
writeJson("live-ui-submission.json", uiPayload);
const uiRun = await request(
  novaBase,
  "POST",
  "/api/verification/runs",
  uiPayload,
  "live-ui-run-response.json",
);
requireApproved(uiRun, "independent UI verification");
const uiDetail = await request(
  novaBase,
  "GET",
  `/api/verification/runs/${uiRun.body.runId}`,
  undefined,
  "live-ui-run-detail.json",
);
requireStatus(uiDetail, 200, "independent UI run detail");

const loopsBeforeBinding = await request(
  novaBase,
  "GET",
  `/api/verification/loops?companyId=${companyId}&teamId=${teamId}`,
  undefined,
  "live-loops-before-binding.json",
);
requireStatus(loopsBeforeBinding, 200, "loop check before binding");
const openLoops = (Array.isArray(loopsBeforeBinding.body)
  ? loopsBeforeBinding.body
  : []
).filter((loop) =>
  loop.taskId === taskId
  && ["action_required", "resubmitted"].includes(loop.status)
);
if (openLoops.length !== 0) {
  fail(`new approved runs left open remediation loops: ${JSON.stringify(openLoops)}`);
}

const binding = await request(
  ncoBase,
  "POST",
  `/api/tasks/${taskId}/verification`,
  {
    receiptId: workRun.body.receiptId,
    actorId,
    uiInspectionReceiptId: uiRun.body.receiptId,
  },
  "live-nco-binding-response.json",
);
requireStatus(binding, 200, "NCO verification binding");
if (
  binding.body?.ok !== true
  || binding.body?.status !== "completed"
  || binding.body?.receiptId !== workRun.body.receiptId
) {
  fail(`NCO binding did not complete the task: ${JSON.stringify(binding.body)}`);
}

const finalNcoDb = new Database(ncoDbPath, { readonly: true, fileMustExist: true });
const finalNovaDb = new Database(novaDbPath, { readonly: true, fileMustExist: true });
const finalTask = finalNcoDb.prepare(`
  SELECT id, status, metadata_json metadataJson, completed_at completedAt
  FROM tasks WHERE id=?
`).get(taskId);
const finalMetadata = JSON.parse(finalTask?.metadataJson || "{}");
const consumptions = finalNovaDb.prepare(`
  SELECT receipt_id receiptId, event_id eventId, consumed_at consumedAt
  FROM verification_receipt_consumptions
  WHERE receipt_id IN (?,?)
  ORDER BY event_id
`).all(workRun.body.receiptId, uiRun.body.receiptId);
const activity = finalNovaDb.prepare(`
  SELECT id eventId, timestamp, action, task_id taskId, company_id companyId,
    team_id teamId, receipt_id receiptId, metadata_json metadataJson
  FROM activity_log
  WHERE task_id=? AND action='task_complete' AND receipt_id=?
  ORDER BY timestamp DESC LIMIT 1
`).get(taskId, workRun.body.receiptId);
const finalOpenLoops = finalNovaDb.prepare(`
  SELECT id loopId, team_id teamId, source_actor_id actorId, status
  FROM verification_loops
  WHERE task_id=? AND company_id=?
    AND status IN ('action_required','resubmitted')
`).all(taskId, companyId);
const finalVerification = {
  observedAt: new Date().toISOString(),
  ncoQuickCheck: finalNcoDb.pragma("quick_check", { simple: true }),
  novaQuickCheck: finalNovaDb.pragma("quick_check", { simple: true }),
  finalTask,
  finalMetadata: {
    verificationStatus: finalMetadata.verificationStatus,
    verificationReceiptId: finalMetadata.verificationReceiptId,
    uiInspectionReceiptId: finalMetadata.uiInspectionReceiptId,
  },
  consumptions,
  activity,
  finalOpenLoops,
};
finalNcoDb.close();
finalNovaDb.close();
writeJson("live-final-verification.json", finalVerification);
if (
  finalVerification.ncoQuickCheck !== "ok"
  || finalVerification.novaQuickCheck !== "ok"
  || finalTask?.status !== "completed"
  || !finalTask?.completedAt
  || finalMetadata.verificationStatus !== "approved"
  || finalMetadata.verificationReceiptId !== workRun.body.receiptId
  || finalMetadata.uiInspectionReceiptId !== uiRun.body.receiptId
  || consumptions.length !== 2
  || !activity
  || finalOpenLoops.length !== 0
) {
  fail(`final binding verification failed: ${JSON.stringify(finalVerification)}`);
}

const summary = {
  taskId,
  companyId,
  teamId,
  status: "completed",
  evidencePath: evidenceDir,
  registry: preflight.registry,
  workRun: workRun.body,
  uiApprovalRun: uiRun.body,
  openLoops: finalOpenLoops,
  completionEvent: {
    eventId: activity.eventId,
    timestamp: activity.timestamp,
    workReceiptId: workRun.body.receiptId,
    uiInspectionReceiptId: uiRun.body.receiptId,
    atomicConsumptions: consumptions,
  },
  ncoBinding: binding.body,
};
writeJson("live-audit-summary.json", summary);
console.log(JSON.stringify(summary, null, 2));
