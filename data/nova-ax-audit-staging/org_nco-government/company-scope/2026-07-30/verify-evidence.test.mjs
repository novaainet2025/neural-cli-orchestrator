import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../../../../..");
const artifactPath = join(here, "company-scope-audit-bundle.json");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const bundle = JSON.parse(await readFile(artifactPath, "utf8"));

test("감사 대상과 원본 지시가 동일 범위에 결박된다", () => {
  assert.equal(bundle.scope.companyId, "org_nco-government");
  assert.equal(bundle.scope.teamId, "company-scope");
  assert.equal(bundle.auditBinding.taskId, bundle.auditBinding.directive.taskId);
  assert.equal(bundle.auditBinding.directive.companyId, bundle.scope.companyId);
  assert.equal(bundle.auditBinding.directive.teamId, bundle.scope.teamId);
  assert.equal(
    bundle.auditBinding.sourceTask.verificationDirectiveId,
    bundle.auditBinding.directive.id
  );
});

test("원본 미완 상태를 성공으로 변조하지 않는다", () => {
  assert.equal(bundle.assertions.successClaimed, false);
  assert.equal(bundle.assertions.sourceTaskStatus, bundle.auditBinding.sourceTask.status);
  assert.equal(bundle.assertions.directiveStatus, bundle.auditBinding.directive.status);
});

test("회사 범위와 실제 산출물 표본이 비어 있지 않다", () => {
  assert.ok(bundle.sourceFacts.activeScopes.length >= 1);
  assert.ok(bundle.artifactInventory.fileCount >= 1);
  assert.equal(bundle.artifactInventory.fileCount, bundle.artifactInventory.files.length);
  assert.ok(bundle.artifactInventory.totalBytes >= 1);
});

test("모든 산출물 경로·바이트·SHA-256이 현재 파일과 일치한다", async () => {
  let totalBytes = 0;
  for (const observation of bundle.artifactInventory.files) {
    assert.match(observation.path, /^REPORTS\//);
    assert.match(observation.sha256, /^[a-f0-9]{64}$/);
    const bytes = await readFile(join(projectRoot, observation.path));
    assert.equal(bytes.byteLength, observation.byteSize);
    assert.equal(sha256(bytes), observation.sha256);
    totalBytes += bytes.byteLength;
  }
  assert.equal(totalBytes, bundle.artifactInventory.totalBytes);
});

test("기존 검증 판정과 열린 회사 범위 루프 목록이 구조적으로 유효하다", () => {
  for (const run of bundle.sourceFacts.verificationRuns) {
    assert.match(run.runId, /^vrun_/);
    assert.ok(["approved", "rejected"].includes(run.status));
    assert.ok(run.passedInstitutions >= 0 && run.passedInstitutions <= 6);
    assert.match(run.evidenceDigest, /^[a-f0-9]{64}$/);
  }
  for (const loop of bundle.sourceFacts.openCompanyScopeLoops) {
    assert.equal(loop.teamId, "company-scope");
    assert.ok(["action_required", "resubmitted"].includes(loop.status));
  }
});
