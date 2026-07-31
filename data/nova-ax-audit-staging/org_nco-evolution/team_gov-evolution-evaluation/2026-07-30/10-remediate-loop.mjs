/**
 * Resolves open remediation loop using the already-approved primary run.
 */
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const AX = "http://localhost:6300";
const LOOP = "vloop_047582eb-7a6b-4d47-a661-499eee16fb6f";

const decision = JSON.parse(readFileSync(join(HERE, "verification-decision.json"), "utf8"));
if (decision.status !== "approved" || decision.passedInstitutions !== 6) {
  console.error("no approved 6/6 run available for loop resolution");
  process.exit(1);
}

console.log(`using approved run ${decision.runId} receipt ${decision.receiptId}`);

const loopRes = await fetch(`${AX}/api/verification/loops/${LOOP}`);
const loop = await loopRes.json();
const L = loop.loop || loop;
console.log(`loop status: ${L.status}, pending actions: ${L.actions.filter(a => a.status === "pending").length}`);

const refsByInstitution = Object.fromEntries(decision.results.map(r => [r.institution, r.evidenceRefs]));
const criteria = L.actions.filter(a => a.status === "pending").map(a => ({
  actionId: a.id,
  evidenceHashes: [refsByInstitution[a.institution]?.[0]].filter(Boolean),
}));
console.log("criteria:", JSON.stringify(criteria, null, 2));

if (criteria.length > 0) {
  const attRes = await fetch(`${AX}/api/verification/loops/${LOOP}/attempts`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorId: "claude-code", runId: decision.runId, criteria }),
  });
  const attempt = await attRes.json();
  writeFileSync(join(HERE, "loop-attempt.json"), JSON.stringify({ httpStatus: attRes.status, attempt }, null, 2) + "\n");
  console.log(`attempt HTTP ${attRes.status}`, JSON.stringify(attempt, null, 2));
  if (attRes.status !== 200 && attRes.status !== 201) process.exit(1);
}

const loopAfterRes = await fetch(`${AX}/api/verification/loops/${LOOP}`);
const loopAfter = await loopAfterRes.json();
writeFileSync(join(HERE, "loop-after.json"), JSON.stringify(loopAfter, null, 2) + "\n");
console.log(`loop after: ${(loopAfter.loop || loopAfter).status}`);

const payload = {
  agentId: "claude-code", agentName: "Claude Code", action: "task_complete",
  description: "team_gov-evolution-evaluation 정기 감사: 평가 설계 산출물 인벤토리 및 6기관 검증 완료",
  taskId: "task_yRDfIvg60k_d6nbN", companyId: "org_nco-evolution",
  teamId: "team_gov-evolution-evaluation", receiptId: decision.receiptId,
  metadata: {
    runId: decision.runId, evidenceDigest: decision.evidenceDigest,
    evidenceDir: "evidence/audit-gov-evolution-evaluation-20260730", loopId: LOOP,
  },
};
writeFileSync(join(HERE, "completion-event-payload.json"), JSON.stringify(payload, null, 2) + "\n");

const res = await fetch(`${AX}/api/activity`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
});
const body = await res.json();
writeFileSync(join(HERE, "completion-event.json"), JSON.stringify({ httpStatus: res.status, body }, null, 2) + "\n");
console.log(`completion HTTP ${res.status}`, JSON.stringify(body));
process.exit(res.status === 200 && body.ok ? 0 : 1);
