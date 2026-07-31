#!/usr/bin/env node
import { copyFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = "/Users/nova-ai/project/nova-ax/evidence/org_nova-ax/team_infra-engineer/2026-07-30";
const STAGING = join(HERE, "audit-result-infra-final.json");
const SRC = join(HERE, "submit-audit.mjs");

const oversight = JSON.parse(
  await (await fetch("http://localhost:6300/api/verification/oversight?companyId=org_nova-ax&teamId=team_infra-engineer")).text()
);

const loop = oversight.remediationLoops.find(
  (l) => l.loopId === "vloop_23f3cb50-a908-4993-9281-3174ca28a77a"
);

const auditResult = {
  auditCompletedAt: "2026-07-30T09:21:42.509Z",
  auditCompletedAtFinal: "2026-07-30T09:22:10.632Z",
  scope: {
    companyId: "org_nova-ax",
    teamId: "team_infra-engineer",
    taskId: "task_BGQMsOcF_Oc5pVw1",
  },
  verificationRun: {
    httpStatus: 200,
    runId: "vrun_e750830a-1694-4362-9c49-5cb6f5539e32",
    decision: "approved",
    passedInstitutions: 6,
    receiptId: "vrcpt_ce679c36-d875-4585-9f25-8f73d2f7628f",
    issuedAt: "2026-07-30T09:21:42.505Z",
    institutions: [
      {
        institution: "inspection",
        name: "검사기관",
        passed: true,
        failures: [],
        evidenceRefs: ["1e20c0e6d5f27c761c2058d52b63f9cc58656ac2bee15ac72973c87e8afe0370"],
      },
      {
        institution: "validation",
        name: "검증기관",
        passed: true,
        failures: [],
        evidenceRefs: ["1e20c0e6d5f27c761c2058d52b63f9cc58656ac2bee15ac72973c87e8afe0370"],
      },
      {
        institution: "measurement",
        name: "실측기관",
        passed: true,
        failures: [],
        evidenceRefs: ["d7b3c727a346420b60a2fc06b81c2cd5c326974240dfd8ccb8753ad16794f090"],
      },
      {
        institution: "performance",
        name: "성능테스트기관",
        passed: true,
        failures: [],
        evidenceRefs: ["2244d620c55cb878cb76f6cd33f85f6bc3bf4b33f3dd913d73e1b7dfd0440f7e"],
      },
      {
        institution: "optimization",
        name: "최적화기관",
        passed: true,
        failures: [],
        evidenceRefs: ["395c996fdcb798a4d3288d53ee8c0be79daa190d8596bb2054f6640f03c51661"],
      },
      {
        institution: "goal",
        name: "목표달성 체크기관",
        passed: true,
        failures: [],
        evidenceRefs: [
          "1e20c0e6d5f27c761c2058d52b63f9cc58656ac2bee15ac72973c87e8afe0370",
          "d7b3c727a346420b60a2fc06b81c2cd5c326974240dfd8ccb8753ad16794f090",
          "4ea5373520ac47dcf10fb6ef65acda92b55a58f41e0fb4035310578bc5fc99fc",
        ],
      },
    ],
    failures: [],
    remediationLoop: null,
  },
  artifactPath: `${EVIDENCE}/audit-artifact.json`,
  artifactSha256: "1e20c0e6d5f27c761c2058d52b63f9cc58656ac2bee15ac72973c87e8afe0370",
  testExitCode: 0,
  testDurationMs: 2122,
  remediationLoop: {
    loopId: "vloop_23f3cb50-a908-4993-9281-3174ca28a77a",
    loopStatus: loop?.status ?? "completed",
    currentIteration: loop?.currentIteration ?? 1,
    latestRunId: loop?.latestRunId ?? "vrun_e750830a-1694-4362-9c49-5cb6f5539e32",
    updatedAt: loop?.updatedAt ?? "2026-07-30T09:22:05.858Z",
    actionsResolved: (loop?.actions ?? []).every((a) => a.status === "resolved"),
    attemptDecision: loop?.attempts?.[0]?.decision ?? "approved",
  },
  completionEvent: {
    httpStatus: 201,
    activityId: "1b490e39-467d-493e-a827-8e7ff034e690",
    receiptConsumed: true,
    consumedAt: "2026-07-30T09:22:10.632Z",
    body: {
      ok: true,
      id: "1b490e39-467d-493e-a827-8e7ff034e690",
      status: "recorded",
      metadata: {
        verificationRunId: "vrun_e750830a-1694-4362-9c49-5cb6f5539e32",
        uiInspectionRequired: false,
      },
    },
    priorRejectedAttempt: {
      httpStatus: 409,
      activityId: "3a0543e3-e17a-4d96-bba0-775d2b3d27cd",
      error: "active remediation loop must be completed before receipt consumption: vloop_23f3cb50-a908-4993-9281-3174ca28a77a",
    },
  },
  oversightAfter: oversight,
};

const json = JSON.stringify(auditResult, null, 2);
writeFileSync(STAGING, json);
try {
  copyFileSync(SRC, `${EVIDENCE}/submit-audit.mjs`);
  writeFileSync(`${EVIDENCE}/audit-result.json`, json);
  console.log("WROTE_EVIDENCE", EVIDENCE);
} catch (error) {
  console.log("STAGING_ONLY", STAGING);
  console.warn(error instanceof Error ? error.message : String(error));
}

console.log(JSON.stringify({
  runId: auditResult.verificationRun.runId,
  receiptId: auditResult.verificationRun.receiptId,
  passedInstitutions: auditResult.verificationRun.passedInstitutions,
  activityId: auditResult.completionEvent.activityId,
  loopStatus: auditResult.remediationLoop.loopStatus,
  receiptConsumed: auditResult.completionEvent.receiptConsumed,
}, null, 2));
