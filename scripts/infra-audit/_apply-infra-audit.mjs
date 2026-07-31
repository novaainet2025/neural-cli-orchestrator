#!/usr/bin/env node
import { copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = "/Users/nova-ai/project/nova-ax/evidence/org_nova-ax/team_infra-engineer/2026-07-30";

copyFileSync(join(HERE, "collect-infra-evidence.mjs"), `${EVIDENCE}/collect-infra-evidence.mjs`);
copyFileSync(join(HERE, "submit-audit.mjs"), `${EVIDENCE}/submit-audit.mjs`);

const staging = readFileSync(join(HERE, "audit-result-infra-final.json"), "utf8");
writeFileSync(`${EVIDENCE}/audit-result.json`, staging);

const auditResult = JSON.parse(staging);
console.log("WROTE_EVIDENCE", EVIDENCE);
console.log(JSON.stringify({
  runId: auditResult.verificationRun.runId,
  receiptId: auditResult.verificationRun.receiptId,
  passedInstitutions: auditResult.verificationRun.passedInstitutions,
  activityId: auditResult.completionEvent.activityId,
  loopStatus: auditResult.remediationLoop.loopStatus,
  receiptConsumed: auditResult.completionEvent.receiptConsumed,
}, null, 2));
