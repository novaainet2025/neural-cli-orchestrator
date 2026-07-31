/** Binds the approved receipt to a completion event; the server consumes it single-use. */
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const decision = JSON.parse(readFileSync(join(HERE, "verification-decision.json"), "utf8"));
if (decision.status !== "approved") { console.error("not approved; refusing to bind"); process.exit(1); }

const payload = {
  agentId: "claude-code",
  agentName: "Claude Code",
  action: "task_complete",
  description: "team_gov-evolution-evaluation 정기 감사: 평가 설계 산출물 인벤토리 및 6기관 검증 완료",
  taskId: "task_yRDfIvg60k_d6nbN",
  companyId: "org_nco-evolution",
  teamId: "team_gov-evolution-evaluation",
  receiptId: decision.receiptId,
  metadata: {
    runId: decision.runId,
    evidenceDigest: decision.evidenceDigest,
    evidenceDir: "evidence/audit-gov-evolution-evaluation-20260730",
  },
};
writeFileSync(join(HERE, "completion-event-payload.json"), JSON.stringify(payload, null, 2) + "\n");

const res = await fetch("http://localhost:6300/api/activity", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
});
const body = await res.json();
writeFileSync(join(HERE, "completion-event.json"), JSON.stringify({ httpStatus: res.status, body }, null, 2) + "\n");
console.log(`HTTP ${res.status}`, JSON.stringify(body));
process.exit(res.status === 200 && body.ok ? 0 : 1);
