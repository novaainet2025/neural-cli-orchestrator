// Independent, machine-only evidence collector for org_nova-ax / team_hr-director.
// Reads ground truth from the filesystem and from nco.db. No LLM claims, no work logs.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "/Users/nova-ai/project/nco/node_modules/better-sqlite3/lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const NCO = "/Users/nova-ai/project/nco";
const TEAM_ID = "team_hr-director";
const COMPANY_ID = "org_nova-ax";
const DIRECTIVE_ID = "vdir_fbcc1e20-b7e8-43e0-b53c-0f301281b7d6";
const TASK_ID = "task_6U9HdSXrBErDX2CZ";
const observedAt = new Date().toISOString();
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const koreanChars = (text) => (text.match(/[가-힣]/g) || []).length;

function collectFromDir(kind, dir, match) {
  const items = [];
  if (!existsSync(dir)) return items;
  for (const name of readdirSync(dir).sort()) {
    if (!match(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (!stat.isFile()) continue;
    const bytes = readFileSync(path);
    items.push({
      type: kind,
      path,
      byteSize: stat.size,
      sha256: sha256(bytes),
      modifiedAt: stat.mtime.toISOString(),
      koreanCharacters: koreanChars(bytes.toString("utf8")),
      evidenceTier: "T1",
    });
  }
  return items;
}

const sources = [
  {
    kind: "team-runner-report",
    dir: join(NCO, "data/team-runner"),
    match: (f) => /^team_hr-director-\d{4}-\d{2}-\d{2}\.md$/.test(f),
  },
  {
    kind: "team-runner-pointer",
    dir: join(NCO, "data/team-runner"),
    match: (f) => f === "team_hr-director.last",
  },
  {
    kind: "dated-role-report",
    dir: join(NCO, "REPORTS"),
    match: (f) => /hr-director.*\.md$/.test(f),
  },
  {
    kind: "improvement-note",
    dir: join(NCO, "improvement_notes"),
    match: (f) => /hr-director/i.test(f),
  },
  {
    kind: "lifecycle-evidence",
    dir: join(NCO, "docs/team-lifecycle-evidence/team_hr-director"),
    match: () => true,
  },
];

const deliverables = [];
for (const source of sources) {
  deliverables.push(...collectFromDir(source.kind, source.dir, source.match));
}
deliverables.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const ncoDb = new Database(join(NCO, "db/nco.db"), { readonly: true, fileMustExist: true });
const rows = ncoDb
  .prepare(
    `
  SELECT id, report_date, report_slot, status, title, body_md, created_at, submitted_at
  FROM work_reports WHERE team_id=? ORDER BY report_date DESC, report_slot DESC
`
  )
  .all(TEAM_ID);

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

const runnerFileDates = new Set(
  deliverables
    .filter((d) => d.type === "team-runner-report")
    .map((d) => d.path.match(/(\d{4}-\d{2}-\d{2})\.md$/)?.[1])
    .filter(Boolean)
);
const distinctReportDates = [...new Set(workReports.map((r) => r.reportDate))].sort();
const datesWithRunnerFile = distinctReportDates.filter((d) => runnerFileDates.has(d));
const datesWithoutRunnerFile = distinctReportDates.filter((d) => !runnerFileDates.has(d));

const totalBytes = deliverables.reduce((sum, d) => sum + d.byteSize, 0);
const totalKorean = deliverables.reduce((sum, d) => sum + d.koreanCharacters, 0);

const bundle = {
  schema: "nova-ax.hr-director-audit.v1",
  status: "final",
  generatedAt: observedAt,
  observer: {
    id: "hr-director-evidence-collector",
    independentFromTaskActor: true,
    machineProduced: true,
    method: "node:fs stat/read + sha256 over file bytes; better-sqlite3 readonly over db/nco.db",
  },
  scope: {
    companyId: COMPANY_ID,
    teamId: TEAM_ID,
    teamName: "팀 생애주기 인사팀",
    directiveId: DIRECTIVE_ID,
    taskId: TASK_ID,
    auditCycle: 1,
    priorRunId: null,
    priorCatalogedDeliverables: 0,
    priorDbGroundedRows: 0,
  },
  artifactInventory: {
    fileCount: deliverables.length,
    totalBytes,
    totalKoreanCharacters: totalKorean,
    byType: Object.fromEntries(
      [...new Set(deliverables.map((d) => d.type))].map((t) => [
        t,
        deliverables.filter((d) => d.type === t).length,
      ])
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
    coverageRatio:
      distinctReportDates.length === 0 ? 0 : datesWithRunnerFile.length / distinctReportDates.length,
  },
};

const bundlePath = join(here, "hr-director-audit-bundle.json");
writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      bundlePath,
      fileCount: deliverables.length,
      totalBytes,
      totalKorean,
      workReportRows: workReports.length,
      submittedNonEmptyRows: submittedNonEmpty.length,
      distinctReportDates: distinctReportDates.length,
      datesWithoutRunnerFile,
    },
    null,
    2
  )
);
