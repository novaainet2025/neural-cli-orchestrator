import crypto from "node:crypto";
import fs from "node:fs";
import Database from "better-sqlite3";

const startedAt = process.hrtime.bigint();
const taskId = "task_V7rVWJY46l9IbZ6w";
const reportPath = "data/audit-task_V7rVWJY46l9IbZ6w/report.md";
const db = new Database("db/nco.db", { readonly: true });
const task = db.prepare("SELECT prompt, response FROM tasks WHERE id=?").get(taskId);
const report = fs.readFileSync(reportPath, "utf8");

const expectedEvidence = [
  "전체 19건, 완료 19건, 실패성 0건, 진행 중 0건",
  "완료율 100.0%",
  "제출 12건, 누락(missed) 2건",
  "codex / code | 15 | 46.7% | 46.27 | 46,602.67",
  "hermes / code | 5 | 0.0% | 0 | 518.60",
  "총 실행 35회",
];
const checks = {
  markdownTitle: report.startsWith("# 2026-07-31 오전 업무보고"),
  coreWorkSection: report.includes("## 1. 오늘 수행한 핵심 업무"),
  issuesAndActions:
    report.includes("## 2. 진행 중 이슈") && report.includes("## 4. 다음 액션"),
  suppliedValuesPreserved: expectedEvidence.every((value) => report.includes(value)),
  unavailableDataDisclosed:
    report.includes("확인 불가 항목") && report.includes("미확인 항목"),
  ncoGroundTruthPresent:
    task?.prompt?.includes("전체=19, 완료=19, 실패성=0, 진행=0, 완료율=100.0%") === true
    && task?.response?.includes("전체 19건, 완료 19건, 실패성 0건, 진행 중 0건") === true,
};
const durationMs = Math.max(
  1,
  Math.ceil(Number(process.hrtime.bigint() - startedAt) / 1_000_000),
);
const result = {
  passed: Object.values(checks).every(Boolean),
  assertionsPassed: Object.values(checks).filter(Boolean).length,
  assertionsTotal: Object.keys(checks).length,
  durationMs,
  artifactBytes: Buffer.byteLength(report),
  artifactSha256: crypto.createHash("sha256").update(report).digest("hex"),
  checks,
};

db.close();
console.log(JSON.stringify(result));
if (!result.passed) process.exitCode = 1;
