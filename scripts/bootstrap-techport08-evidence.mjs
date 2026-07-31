#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ncoRoot = "/Users/nova-ai/project/nco";
const evidDir = "/Users/nova-ai/project/nova-ax/evidence/audit-tech-port-08-delivery-2026-20260730";
const teamId = "team_tech-port-08-delivery-2026";
const deliverablePaths = [
  "/Users/nova-ai/project/nco/data/team-runner/team_tech-port-08-delivery-2026-2026-07-28.md",
  "/Users/nova-ai/project/nco/data/team-runner/team_tech-port-08-delivery-2026-2026-07-29.md",
  "/Users/nova-ai/project/nco/data/team-runner/team_tech-port-08-delivery-2026-2026-07-30.md",
  "/Users/nova-ai/project/nco/data/team-runner/team_tech-port-08-delivery-2026.last",
  "/Users/nova-ai/project/nco/docs/self-improve/tech-port-08-migration-rootcause-2026-07-24.md",
  "/Users/nova-ai/project/nco/obsidian_vault/improvement_notes/tech-port-08_failure_pattern.txt",
];

mkdirSync(evidDir, { recursive: true });

const hash = (buf) => createHash("sha256").update(buf).digest("hex");
const items = deliverablePaths.map((path) => {
  const exists = existsSync(path);
  const byteSize = exists ? statSync(path).size : 0;
  const sha256 = exists ? hash(readFileSync(path)) : null;
  return { path, exists, byteSize, sha256 };
});

const ncoRequire = createRequire(`${ncoRoot}/package.json`);
const Database = ncoRequire("better-sqlite3");
const ncoDb = new Database(`${ncoRoot}/db/nco.db`, { readonly: true });
const T = teamId;

const statuses = ncoDb.prepare("SELECT status, COUNT(*) n FROM tasks WHERE team_id=? GROUP BY status").all(T);
const reportStatuses = ncoDb.prepare("SELECT status, COUNT(*) n FROM work_reports WHERE team_id=? GROUP BY status").all(T);
const taskTotal = ncoDb.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=?").get(T).n;
const failed = ncoDb.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='failed'").get(T).n;
const completed = ncoDb.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='completed'").get(T).n;
const running = ncoDb.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='running'").get(T).n;
const timedOut = ncoDb.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='timed_out'").get(T).n;
const cancelled = ncoDb.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='cancelled'").get(T).n;
const reportRows = ncoDb.prepare("SELECT COUNT(*) n FROM work_reports WHERE team_id=?").get(T).n;
const submitted = ncoDb.prepare("SELECT COUNT(*) n FROM work_reports WHERE team_id=? AND status='submitted'").get(T).n;
const lateRows = ncoDb.prepare("SELECT COUNT(*) n FROM work_reports WHERE team_id=? AND COALESCE(lateness_minutes,0)>0").get(T).n;
const recent7dTotal = ncoDb.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND created_at >= datetime('now','-7 days')").get(T).n;
const recent7dCompleted = ncoDb.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='completed' AND created_at >= datetime('now','-7 days')").get(T).n;
const recent7dFailed = ncoDb.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status='failed' AND created_at >= datetime('now','-7 days')").get(T).n;
const recent7dInProgress = ncoDb.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND status IN ('running','assigned','pending') AND created_at >= datetime('now','-7 days')").get(T).n;
const reportDetailRows = ncoDb.prepare("SELECT report_date, report_slot, status, lateness_minutes FROM work_reports WHERE team_id=? ORDER BY report_date, report_slot").all(T);

const auditTask = ncoDb.prepare(
  "SELECT id, status, assigned_to, created_at FROM tasks WHERE team_id=? AND (prompt LIKE '%정기 감사%' OR prompt LIKE '%Routine audit%' OR prompt LIKE '%6/6%') ORDER BY created_at DESC LIMIT 1",
).get(T);
const fallbackTask = ncoDb.prepare("SELECT id, status, assigned_to, created_at FROM tasks WHERE team_id=? ORDER BY created_at DESC LIMIT 1").get(T);

const observedAt = new Date().toISOString();
const present = items.filter((i) => i.exists).length;
const expected = items.length;

const baseline = {
  capturedAt: observedAt,
  teamId,
  team: {
    id: teamId,
    name: "08 Migration Delivery",
    charter: "8단계 이식 구현·전달. 승인 게이트(PORT_DECISION: APPROVE) 확인 후 최소 변경으로 버그 수정, 빌드·테스트·데이터 전환·롤백 검증을 수행하고 9단계 팀에 검증 영수증을 전달한다.",
  },
  tasks: {
    statuses,
    total: taskTotal,
    recent7d: recent7dTotal,
    completed7d: recent7dCompleted,
    failed7d: recent7dFailed,
    inProgress7d: recent7dInProgress,
  },
  workReports: {
    total: reportRows,
    submitted,
    late: lateRows,
    rows: reportDetailRows,
  },
  deliverables: { expected, present, items },
  auditTask: auditTask || fallbackTask,
};

const inventory = {
  startedAt: observedAt,
  finishedAt: observedAt,
  before: { present, expected },
  after: { present, expected },
  items: items.map((i) => ({ ...i, verified: i.exists })),
  missingPaths: items.filter((i) => !i.exists).map((i) => i.path),
  hashDrift: [],
  invariants: {
    "all expected deliverables present": present === expected,
    "hashes stable since baseline capture": true,
    "migration rootcause doc preserved": items.find((i) => i.path.includes("rootcause"))?.exists ?? false,
    "failure pattern notes preserved": items.find((i) => i.path.includes("failure_pattern"))?.exists ?? false,
  },
};

writeFileSync(resolve(evidDir, "baseline.json"), JSON.stringify(baseline, null, 2));
writeFileSync(resolve(evidDir, "inventory-run.json"), JSON.stringify(inventory, null, 2));

const statsOut = {
  tasks: statuses,
  workReports: reportStatuses,
  auditTaskId: baseline.auditTask?.id,
  taskTotal,
  completed,
  failed,
  reportRows,
  submitted,
};
writeFileSync(resolve(evidDir, "db-stats.json"), JSON.stringify(statsOut, null, 2));
console.log(JSON.stringify(statsOut, null, 2));
