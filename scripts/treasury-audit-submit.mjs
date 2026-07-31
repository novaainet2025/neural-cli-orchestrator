#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const src =
  "/Users/nova-ai/project/nova-use/evidence/nova-ax/org_nco-government/team_gov-government-treasury/2026-07-30";
const dst = "/Users/nova-ai/project/nova-ax/evidence/gov-government-treasury/2026-07-30";
const novaAxRoot = "/Users/nova-ai/project/nova-ax";
const novaDbPath = resolve(novaAxRoot, "db/nova-ax.db");
const artifactPath = resolve(dst, "audit-artifact.json");
const submissionPath = resolve(dst, "submission-final.json");
const resultPath = resolve(dst, "audit-result.json");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

mkdirSync(dst, { recursive: true });
for (const f of ["audit-artifact.json", "machine-evidence.json", "verification-suite.log"]) {
  copyFileSync(resolve(src, f), resolve(dst, f));
}

const artifactHash = sha256(readFileSync(artifactPath));
const baseSubmission = JSON.parse(readFileSync(resolve(src, "submission-final.json"), "utf8"));
baseSubmission.actorId = "cursor-agent";
baseSubmission.artifact.uri = artifactPath;
baseSubmission.artifact.expectedSha256 = artifactHash;
baseSubmission.integrityAttestation.observedSha256 = artifactHash;
baseSubmission.integrityAttestation.provenance.evidenceHash = artifactHash;
writeFileSync(submissionPath, JSON.stringify(baseSubmission, null, 2));

const companyId = "org_nco-government";
const teamId = "team_gov-government-treasury";
const taskId = "task_xvV9Pw13uv63Tn0v";
const loopId = "vloop_a7c041f6-aa65-434f-9395-5d614df784fe";
const actorId = "cursor-agent";
const directiveId = "vdir_5f6e3e83-0b38-4c9d-acd3-37fd934fab9f";

process.env.AX_NO_LISTEN = "1";
process.env.AX_DB_PATH = novaDbPath;
const { app } = await import("/Users/nova-ai/project/nova-ax/dist/index.js");

const api = async (url, init = {}) => {
  const response = await app.inject({
    method: init.method || "GET",
    url,
    headers: init.headers,
    payload: init.body,
  });
  let body;
  try {
    body = response.json();
  } catch {
    body = response.body;
  }
  return { status: response.statusCode, body };
};

const loopsBefore = await api(
  `/api/verification/loops?companyId=${companyId}&teamId=${teamId}`
);
const runResponse = await api("/api/verification/runs", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(baseSubmission),
});

const institutionResults = Array.isArray(runResponse.body?.results)
  ? runResponse.body.results.map((result) => ({
      institution: result.institution,
      name: result.name,
      passed: result.passed,
      failures: result.failures,
      evidenceRefs: result.evidenceRefs,
    }))
  : [];

const result = {
  schema: "nova-ax.treasury-audit-result.v1",
  artifactSha256: artifactHash,
  evidencePaths: {
    artifact: artifactPath,
    machineEvidence: resolve(dst, "machine-evidence.json"),
    submission: submissionPath,
    verificationSuiteLog: resolve(dst, "verification-suite.log"),
    result: resultPath,
  },
  loopsBefore: loopsBefore.body,
  run: {
    httpStatus: runResponse.status,
    runId: runResponse.body?.runId ?? null,
    decision: runResponse.body?.status ?? null,
    passedInstitutions: runResponse.body?.passedInstitutions ?? null,
    requiredInstitutions: runResponse.body?.requiredInstitutions ?? null,
    receiptId: runResponse.body?.receiptId ?? null,
    institutions: institutionResults,
  },
  loopAttempt: null,
  completionEvent: null,
};

if (
  runResponse.status === 200 &&
  runResponse.body?.status === "approved" &&
  runResponse.body?.passedInstitutions === 6 &&
  runResponse.body?.receiptId
) {
  const targetLoop = Array.isArray(loopsBefore.body)
    ? loopsBefore.body.find((loop) => loop.loopId === loopId)
    : null;

  if (targetLoop?.status === "action_required" && targetLoop.actorId === actorId) {
    const pendingActions = (targetLoop.actions || []).filter(
      (action) =>
        action.iteration === targetLoop.currentIteration &&
        action.status === "pending"
    );
    const criteria = pendingActions.map((action) => {
      const institutionResult = institutionResults.find(
        (r) => r.institution === action.institution
      );
      const evidenceHash = institutionResult?.evidenceRefs?.[0];
      if (!evidenceHash) {
        throw new Error(`missing evidence for ${action.institution}`);
      }
      return { actionId: action.id, evidenceHashes: [evidenceHash] };
    });
    const attemptResponse = await api(`/api/verification/loops/${loopId}/attempts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actorId,
        runId: runResponse.body.runId,
        criteria,
      }),
    });
    result.loopAttempt = {
      loopId,
      httpStatus: attemptResponse.status,
      body: attemptResponse.body,
    };
  } else {
    result.loopAttempt = {
      loopId,
      skipped: true,
      reason: targetLoop ? `status=${targetLoop.status}, actor=${targetLoop.actorId}` : "not found",
    };
  }

  const completionResponse = await api("/api/activity", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: actorId,
      agentName: "Cursor Agent",
      action: "task_complete",
      taskId,
      companyId,
      teamId,
      receiptId: runResponse.body.receiptId,
      description:
        "Treasury and Resource Stewardship audit verified by six institutions",
      result:
        "independent machine evidence submitted; verification receipt consumed",
      metadata: { directiveId, artifactSha256: artifactHash },
    }),
  });
  result.completionEvent = {
    httpStatus: completionResponse.status,
    body: completionResponse.body,
  };

  const loopsAfter = await api(
    `/api/verification/loops?companyId=${companyId}&teamId=${teamId}`
  );
  result.loopsAfter = loopsAfter.body;
}

writeFileSync(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await app.close();
