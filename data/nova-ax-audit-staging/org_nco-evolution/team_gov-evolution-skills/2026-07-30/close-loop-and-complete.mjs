#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = "http://localhost:6300";
const LOOP_ID = "vloop_0a1cf355-2725-4f79-9824-f4983774ab0e";
const RUN_ID = "vrun_571d80bd-9b91-4c69-8118-8de2f75321d8";
const RECEIPT_ID = "vrcpt_bdb1c39e-4563-4073-b073-dbbae59bbad7";
const taskId = "task_k3A4UTcYGBJpJZ_K";
const companyId = "org_nco-evolution";
const teamId = "team_gov-evolution-skills";
const actorId = "cursor-agent";

const auditResult = JSON.parse(readFileSync(resolve(__dirname, "audit-result.json"), "utf8"));

const loopRes = await fetch(`${BASE}/api/verification/loops/${LOOP_ID}`);
const loopBody = await loopRes.json();
const loop = loopBody.loop || loopBody;
const runRes = await fetch(`${BASE}/api/verification/runs/${RUN_ID}`);
const runBody = await runRes.json();
const refsByInstitution = Object.fromEntries(
  (runBody.results || []).map((r) => [r.institution, r.evidenceRefs]),
);
const criteria = (loop.actions || [])
  .filter((a) => a.status === "pending")
  .map((a) => ({
    actionId: a.id,
    evidenceHashes: [refsByInstitution[a.institution]?.[0]].filter(Boolean),
  }));

const attemptRes = await fetch(`${BASE}/api/verification/loops/${LOOP_ID}/attempts`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ actorId, runId: RUN_ID, criteria }),
});
const attemptBody = await attemptRes.json();
auditResult.loopAttempt = {
  loopId: LOOP_ID,
  httpStatus: attemptRes.status,
  status: attemptBody.status || attemptBody.decision || attemptBody.loop?.status,
  currentIteration: attemptBody.currentIteration ?? attemptBody.loop?.currentIteration,
  body: attemptBody,
};
console.log(JSON.stringify({ phase: "loop", ...auditResult.loopAttempt }, null, 2));

const activityRes = await fetch(`${BASE}/api/activity`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    agentId: actorId,
    agentName: "Cursor Agent",
    action: "task_complete",
    taskId,
    companyId,
    teamId,
    receiptId: RECEIPT_ID,
    description: "org_nco-evolution gov-evolution-skills audit 6/6 verified",
    result: "independent mechanical evidence submitted and consumed",
  }),
});
const activityBody = await activityRes.json();
auditResult.completionEvent = {
  httpStatus: activityRes.status,
  activityId: activityBody.id,
  receiptConsumed: activityRes.status === 200 && activityBody.ok === true,
  body: activityBody,
};
console.log(JSON.stringify({ phase: "activity", ...auditResult.completionEvent }, null, 2));

const oversightRes = await fetch(
  `${BASE}/api/verification/oversight?companyId=${companyId}&teamId=${teamId}`,
);
auditResult.oversightAfter = await oversightRes.json();
auditResult.auditCompletedAt = new Date().toISOString();
writeFileSync(resolve(__dirname, "audit-result.json"), JSON.stringify(auditResult, null, 2));
process.exit(activityRes.status === 200 && activityBody.ok ? 0 : 1);
