// Independent re-verification of the marketing-lead audit bundle.
// Every claim in the bundle is re-derived from ground truth (filesystem bytes + nco.db rows).
// Includes negative controls so a passing run cannot be produced by a broken detector.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "/Users/nova-ai/project/nco/node_modules/better-sqlite3/lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, "marketing-lead-audit-bundle.json");
const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const koreanChars = (text) => (text.match(/[가-힣]/g) || []).length;

test("bundle declares the audited scope", () => {
  assert.equal(bundle.scope.companyId, "org_nova-ax");
  assert.equal(bundle.scope.teamId, "team_marketing-lead");
  assert.equal(bundle.status, "final");
  assert.ok(bundle.deliverables.length > 0, "no deliverables cataloged");
});

test("every cataloged deliverable exists and rehashes to the recorded digest", () => {
  for (const item of bundle.deliverables) {
    const stat = statSync(item.path);
    assert.ok(stat.isFile(), `${item.path} is not a file`);
    const bytes = readFileSync(item.path);
    assert.equal(bytes.byteLength, item.byteSize, `${item.path} byte size drift`);
    assert.equal(sha256(bytes), item.sha256, `${item.path} sha256 mismatch`);
    assert.equal(koreanChars(bytes.toString("utf8")), item.koreanCharacters, `${item.path} korean char drift`);
    assert.ok(stat.size > 0, `${item.path} is empty`);
  }
});

test("inventory rollups match the recomputed totals", () => {
  const fileCount = bundle.deliverables.length;
  const totalBytes = bundle.deliverables.reduce((s, d) => s + d.byteSize, 0);
  const totalKorean = bundle.deliverables.reduce((s, d) => s + d.koreanCharacters, 0);
  assert.equal(bundle.artifactInventory.fileCount, fileCount);
  assert.equal(bundle.artifactInventory.totalBytes, totalBytes);
  assert.equal(bundle.artifactInventory.totalKoreanCharacters, totalKorean);
});

test("negative control: a mutated byte stream must not match the recorded digest", () => {
  const sample = bundle.deliverables[0];
  const bytes = readFileSync(sample.path);
  const tampered = Buffer.concat([bytes, Buffer.from("x")]);
  assert.notEqual(sha256(tampered), sample.sha256, "hash detector is inert");
});

test("negative control: an absent path must fail observation", () => {
  assert.throws(() => statSync(join(here, "__this-file-does-not-exist__.md")));
});

test("nco.db work_reports ground truth matches the bundle", () => {
  const db = new Database(bundle.workReportGroundTruth.source, { readonly: true, fileMustExist: true });
  const rows = db.prepare(`
    SELECT id, report_date, report_slot, status, title, body_md
    FROM work_reports WHERE team_id=? ORDER BY report_date DESC, report_slot DESC
  `).all(bundle.workReportGroundTruth.teamId);
  db.close();

  assert.equal(rows.length, bundle.workReportGroundTruth.totalRows, "row count drift");
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const claimed of bundle.workReportGroundTruth.rows) {
    const actual = byId.get(claimed.id);
    assert.ok(actual, `row ${claimed.id} not found in nco.db`);
    assert.equal(actual.status, claimed.status, `${claimed.id} status drift`);
    assert.equal(actual.report_date, claimed.reportDate, `${claimed.id} date drift`);
    const body = String(actual.body_md || "");
    assert.equal(Buffer.byteLength(body, "utf8"), claimed.bodyBytes, `${claimed.id} body size drift`);
    assert.equal(sha256(Buffer.from(body, "utf8")), claimed.bodySha256, `${claimed.id} body hash drift`);
  }
});

test("no phantom submission: every 'submitted' row carries a non-empty body", () => {
  const submitted = bundle.workReportGroundTruth.rows.filter((r) => r.status === "submitted");
  assert.equal(submitted.length, bundle.workReportGroundTruth.submittedNonEmptyRows);
  for (const row of submitted) {
    assert.ok(row.bodyBytes > 0, `${row.id} claims submitted with an empty body`);
    assert.ok(row.koreanCharacters > 0, `${row.id} submitted body has no Korean content`);
  }
});

test("filesystem persistence cross-check is reproducible", () => {
  const runnerDates = new Set(
    bundle.deliverables
      .filter((d) => d.type === "team-runner-report")
      .map((d) => d.path.match(/(\d{4}-\d{2}-\d{2})\.md$/)?.[1])
      .filter(Boolean)
  );
  const dates = [...new Set(bundle.workReportGroundTruth.rows.map((r) => r.reportDate))].sort();
  const missing = dates.filter((d) => !runnerDates.has(d));
  assert.equal(dates.length, bundle.persistenceCrossCheck.distinctReportDates);
  assert.deepEqual(missing, bundle.persistenceCrossCheck.datesWithoutRunnerFile);
  assert.equal(dates.length - missing.length, bundle.persistenceCrossCheck.datesWithRunnerFile);
});

test("audit improves on the prior cycle's evidence base", () => {
  assert.ok(
    bundle.artifactInventory.fileCount > bundle.scope.priorCatalogedDeliverables,
    "no expansion over the prior audit's cataloged deliverables"
  );
  assert.ok(
    bundle.workReportGroundTruth.submittedNonEmptyRows > bundle.scope.priorDbGroundedRows,
    "no DB-grounded evidence added over the prior audit"
  );
});
