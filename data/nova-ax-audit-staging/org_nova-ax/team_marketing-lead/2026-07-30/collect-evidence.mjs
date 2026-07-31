// Independent, machine-only evidence collector for org_nova-ax / team_marketing-lead.
// Reads ground truth from the filesystem and from nco.db. No LLM claims, no work logs.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "/Users/nova-ai/project/nco/node_modules/better-sqlite3/lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const NCO = "/Users/nova-ai/project/nco";
const TEAM_ID = "team_marketing-lead";
const COMPANY_ID = "org_nova-ax";
const observedAt = new Date().toISOString();
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const koreanChars = (text) => (text.match(/[가-힣]/g) || []).length;

// ---------- 1. filesystem deliverables ----------
const sources = [
  { kind: "team-runner-report", dir: join(NCO, "data/team-runner"), match: (f) => /^team_marketing-lead-\d{4}-\d{2}-\d{2}\.md$/.test(f) },
  { kind: "team-runner-pointer", dir: join(NCO, "data/team-runner"), match: (f) => f === "team_marketing-lead.last" },
  { kind: "role-report", dir: join(NCO, "REPORTS/marketing-lead"), match: (f) => f.endsWith(".md") },
  { kind: "dated-role-report", dir: join(NCO, "REPORTS"), match: (f) => /marketing-lead.*\.md$/.test(f) },
  { kind: "role-doc", dir: join(NCO, "docs"), match: (f) => /marketing-lead.*\.md$/.test(f) },
  { kind: "team-doc", dir: join(NCO, "teams/marketing-lead"), match: (f) => f.endsWith(".md") },
];

const deliverables = [];
for (const source of sources) {
  if (!existsSync(source.dir)) continue;
  for (const name of readdirSync(source.dir).sort()) {
    if (!source.match(name)) continue;
    const path = join(source.dir, name);
    const stat = statSync(path);
    if (!stat.isFile()) continue;
    const bytes = readFileSync(path);
    deliverables.push({
      type: source.kind,
      path,
      byteSize: stat.size,
      sha256: sha256(bytes),
      modifiedAt: stat.mtime.toISOString(),
      koreanCharacters: koreanChars(bytes.toString("utf8")),
      evidenceTier: "T1",
    });
  }
}
deliverables.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

// ---------- 2. nco.db work_reports ground truth ----------
const ncoDb = new Database(join(NCO, "db/nco.db"), { readonly: true, fileMustExist: true });
const rows = ncoDb.prepare(`
  SELECT id, report_date, report_slot, status, title, body_md, created_at, submitted_at
  FROM work_reports WHERE team_id=? ORDER BY report_date DESC, report_slot DESC
`).all(TEAM_ID);

const workReports = rows.map((row) => {
  const body = String(row.body_md || "");
  return {
    id: row.id,
    reportDate: row.report_date,
    slot: row.report_slot,
    status: row.status,
    titleLength: String(row.title || "").length,
    bodyBytes: Buffer.byteLength(body, "utf8"),
    bodySha256: sha256(Buffer.from(body, "utf8")),
    koreanCharacters: koreanChars(body),
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
  };
});
const submittedNonEmpty = workReports.filter((r) => r.status === "submitted" && r.bodyBytes > 0);
ncoDb.close();

// ---------- 3. cross-check: DB row -> filesystem persistence ----------
const runnerFileDates = new Set(
  deliverables
    .filter((d) => d.type === "team-runner-report")
    .map((d) => d.path.match(/(\d{4}-\d{2}-\d{2})\.md$/)?.[1])
    .filter(Boolean)
);
const distinctReportDates = [...new Set(workReports.map((r) => r.reportDate))].sort();
const datesWithRunnerFile = distinctReportDates.filter((d) => runnerFileDates.has(d));
const datesWithoutRunnerFile = distinctReportDates.filter((d) => !runnerFileDates.has(d));

// ---------- 4. inventory rollup ----------
const totalBytes = deliverables.reduce((sum, d) => sum + d.byteSize, 0);
const totalKorean = deliverables.reduce((sum, d) => sum + d.koreanCharacters, 0);

const bundle = {
  schema: "nova-ax.marketing-lead-audit.v2",
  status: "final",
  generatedAt: observedAt,
  observer: {
    id: "marketing-lead-evidence-collector",
    independentFromTaskActor: true,
    machineProduced: true,
    method: "node:fs stat/read + sha256 over file bytes; better-sqlite3 readonly over db/nco.db",
  },
  scope: {
    companyId: COMPANY_ID,
    teamId: TEAM_ID,
    teamName: "마케팅 운영팀",
    auditCycle: 2,
    priorRunId: "vrun_375dc3d5-19e2-43ad-8097-54669b03aadc",
    priorCatalogedDeliverables: 2,
    priorDbGroundedRows: 0,
  },
  artifactInventory: {
    fileCount: deliverables.length,
    totalBytes,
    totalKoreanCharacters: totalKorean,
    byType: Object.fromEntries(
      [...new Set(deliverables.map((d) => d.type))].map((t) => [t, deliverables.filter((d) => d.type === t).length])
    ),
  },
  deliverables,
  workReportGroundTruth: {
    source: join(NCO, "db/nco.db"),
    table: "work_reports",
    teamId: TEAM_ID,
    totalRows: workReports.length,
    submittedNonEmptyRows: submittedNonEmpty.length,
    distinctReportDates: distinctReportDates.length,
    rows: workReports,
  },
  persistenceCrossCheck: {
    rule: "each work_reports report_date must have a matching team-runner markdown file",
    distinctReportDates: distinctReportDates.length,
    datesWithRunnerFile: datesWithRunnerFile.length,
    datesWithoutRunnerFile,
    coverageRatio: distinctReportDates.length === 0 ? 0 : datesWithRunnerFile.length / distinctReportDates.length,
  },
};

const bundlePath = join(here, "marketing-lead-audit-bundle.json");
writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
console.log(JSON.stringify({
  bundlePath,
  fileCount: deliverables.length,
  totalBytes,
  totalKorean,
  workReportRows: workReports.length,
  submittedNonEmptyRows: submittedNonEmpty.length,
  distinctReportDates: distinctReportDates.length,
  datesWithoutRunnerFile,
}, null, 2));
