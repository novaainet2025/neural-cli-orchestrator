#!/usr/bin/env python3
from pathlib import Path

ROOT = Path("/Users/nova-ai/project/nova-ax")

# verification-authority.ts
p = ROOT / "src/core/verification-authority.ts"
text = p.read_text()

old = 'export const COMPANY_SCOPE_TEAM_ID = "company-scope";\n\nexport interface VerificationDirectiveClient {'
new = '''export const COMPANY_SCOPE_TEAM_ID = "company-scope";
/** NCO scheduler uses priority DESC; 10 is the highest operational priority. */
export const NCO_DIRECTIVE_TASK_PRIORITY = 10;
const TOP_PRIORITY_MISSION =
  "Nova-AX receives work reports from every active company and team, runs mandatory audits, "
  + "and treats 6/6 audit pass as the top operational goal; completion and score reflection "
  + "are forbidden before audit pass.";

export interface VerificationDirectiveClient {'''
assert old in text, "anchor1 missing"
text = text.replace(old, new, 1)

old = '''      topPriority: "Nova-AX is the supreme command and audit authority. All company/team reports must be audited and pass 6/6 verification. This is the top operational goal.",
      mission: "Mandatory reporting, mandatory audit, 6/6 pass required. No score or completion without passing.",'''
new = '''      topPriority: {
        mission: TOP_PRIORITY_MISSION,
        mandatoryReporting: true,
        mandatoryAudit: true,
        auditPassTarget: "6/6 unanimous approval",
        noCompletionOrScoreBeforeAuditPass: true,
      },
      mission: "Mandatory reporting, mandatory audit, 6/6 pass required. No score or completion without passing.",'''
assert old in text, "anchor2 missing"
text = text.replace(old, new, 1)

old = '''      directiveDelivery: {
        target: "NCO /api/task",
        boundedBatchDefault: 5,'''
new = '''      directiveDelivery: {
        target: "NCO /api/task",
        ncoTaskPriority: NCO_DIRECTIVE_TASK_PRIORITY,
        dispatchOrder: ["remediation", "audit_required"],
        boundedBatchDefault: 5,'''
assert old in text, "anchor3 missing"
text = text.replace(old, new, 1)

old = '''        row.verification_task_id ? `검증 작업=${row.verification_task_id}, 루프=${row.loop_id}, 반복=${row.current_iteration}` : "",
        "[목표]",
        "모든 회사·팀의 감사 통과는 Nova-AX의 최우선 운영 목표다.",'''
new = '''        row.verification_task_id ? `검증 작업=${row.verification_task_id}, 루프=${row.loop_id}, 반복=${row.current_iteration}` : "",
        "[최우선 운영 목표]",
        "모든 활성 회사·팀의 작업 보고는 의무이며, Nova-AX 감사 통과(6/6 만장일치)가 최우선 운영 목표다.",
        "감사 통과 전 완료·점수 반영은 금지된다.",
        "[목표]",
        "모든 회사·팀의 감사 통과는 Nova-AX의 최우선 운영 목표다.",'''
assert old in text, "anchor4 missing"
text = text.replace(old, new, 1)

old = '''          row.type === "remediation" ? "codex" : "cursor-agent",
          10,
          metadata'''
new = '''          row.type === "remediation" ? "codex" : "cursor-agent",
          NCO_DIRECTIVE_TASK_PRIORITY,
          metadata'''
assert old in text, "anchor5 missing"
text = text.replace(old, new, 1)
p.write_text(text)
print("verification-authority.ts ok")

# index.ts
p = ROOT / "src/index.ts"
text = p.read_text()
old = '''      commsEngine.createAnnouncement(
        "Supreme Verification Commander Directive",
        `[최우선 목표] 모든 회사·팀의 작업 보고 의무 수신 및 6/6 감사 통과는 필수. 미통과 시 완료·점수 반영 불가.\\n\\n${dispatched} new verification directives have been dispatched to NCO teams/organizations.`,
        "Supreme Verification Commander",
        { priority: "high", audience: "all", pinned: true, expiresAt: new Date(Date.now() + 86400000).toISOString() }
      );'''
new = '''      commsEngine.createAnnouncement(
        "Supreme Verification Commander Directive",
        `[최우선 목표] Nova-AX는 모든 활성 회사·팀의 작업 보고를 의무로 받으며, 6/6 감사 통과를 최우선 운영 목표로 삼는다. `
        + `감사 미통과 시 완료 수·검증 점수·리더보드 반영은 절대 금지된다. NCO 작업 완료 문자열만으로는 감사 통과가 되지 않는다.\\n\\n`
        + `${dispatched} new verification directives have been dispatched to NCO teams/organizations.`,
        "Supreme Verification Commander",
        { priority: "urgent", audience: "all", pinned: true, expiresAt: new Date(Date.now() + 86400000).toISOString() }
      );'''
assert old in text, "index anchor missing"
text = text.replace(old, new, 1)
p.write_text(text)
print("index.ts ok")

# verification-authority.test.ts
p = ROOT / "src/core/verification-authority.test.ts"
text = p.read_text()
old = '''    assert.strictEqual(calls[0].priority, 10);
    assert.match(calls[0].prompt, /6\\/6/);
  });'''
new = '''    assert.strictEqual(calls[0].priority, 10);
    assert.match(calls[0].prompt, /최우선 운영 목표/);
    assert.match(calls[0].prompt, /6\\/6/);
  });'''
assert old in text, "test10 anchor missing"
text = text.replace(old, new, 1)

if 'test("15. remediation' not in text:
    old = '''    assert.strictEqual(remediationDirectives[0].attemptCount, 1);
  });
});'''
    new = '''    assert.strictEqual(remediationDirectives[0].attemptCount, 1);
  });

  test("15. remediation 지시는 최우선 priority 10으로 NCO에 전달된다", async () => {
    authority.syncScopes([{
      companyId: "remediation-company",
      teamId: "remediation-team",
      teamName: "Remediation Team",
      active: true,
    }]);
    const sub = createBaseSubmission();
    sub.taskId = "remediation-priority-task";
    sub.companyId = "remediation-company";
    sub.teamId = "remediation-team";
    sub.taskType = "blog";
    sub.artifact.uri = "https://example.com/remediation-priority-task";
    sub.artifact.publishedAt = new Date().toISOString();
    observer.mockObservation = { ...validObservation, visibleCharacters: 500 };

    const rejected = await authority.submit(sub);
    assert.strictEqual(rejected.status, "rejected");
    assert.ok(rejected.remediationLoop);

    const calls: any[] = [];
    const outcome = await authority.dispatchDirectives({
      async createTask(prompt, agent, priority, metadata) {
        calls.push({ prompt, agent, priority, metadata });
        return { taskId: "nco-remediation-task-1" };
      },
    }, { projectDir: "/workspace", limit: 1 });
    assert.strictEqual(outcome.dispatched, 1);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].priority, 10);
    assert.match(calls[0].prompt, /최우선 운영 목표/);
    assert.match(calls[0].prompt, /반시드 교정/);
    const remediationDirective = (authority.getOversight() as any).directives.find(
      (directive: any) => directive.type === "remediation" && directive.taskId === "nco-remediation-task-1"
    );
    assert.ok(remediationDirective);
    assert.strictEqual(remediationDirective.status, "dispatched");
  });
});'''
    assert old in text, "test15 anchor missing"
    text = text.replace(old, new, 1)
p.write_text(text)
print("verification-authority.test.ts ok")

# test-verification-http.ts
p = ROOT / "src/test-verification-http.ts"
text = p.read_text()
old = '''assert.ok(policiesRes.body.topPriority.includes("top operational goal"));
assert.ok(policiesRes.body.mission.includes("Mandatory reporting"));'''
new = '''assert.equal(policiesRes.body.topPriority.mandatoryReporting, true);
assert.equal(policiesRes.body.topPriority.mandatoryAudit, true);
assert.equal(policiesRes.body.topPriority.auditPassTarget, "6/6 unanimous approval");
assert.equal(policiesRes.body.topPriority.noCompletionOrScoreBeforeAuditPass, true);
assert.ok(policiesRes.body.topPriority.mission.includes("top operational goal"));
assert.equal(policiesRes.body.directiveDelivery.ncoTaskPriority, 10);
assert.ok(policiesRes.body.mission.includes("Mandatory reporting"));'''
assert old in text, "http test anchor missing"
text = text.replace(old, new, 1)
p.write_text(text)
print("test-verification-http.ts ok")

# docs
p = ROOT / "docs/10-verification-authority.md"
text = p.read_text()
old = '''Nova-AX는 앞으로 모든 회사·팀의 작업 보고를 받고, 감사를 반드시 진행하며, 감사 통과를 최우선 목표로 설정한다. 감사 통과 전 완료·점수 반영은 절대 금지된다.
회사·팀·에이전트의 자연어 완료 보고'''
new = '''Nova-AX는 앞으로 모든 회사·팀의 작업 보고를 받고, 감사를 반드시 진행하며, 감사 통과를 최우선 목표로 설정한다. 감사 통과 전 완료·점수 반영은 절대 금지된다.
`GET /api/verification/policies`의 `topPriority` 객체가 이 최우선 운영 미션을 노출한다.
`mandatoryReporting`, `mandatoryAudit`, `auditPassTarget: "6/6 unanimous approval"`,
`noCompletionOrScoreBeforeAuditPass`가 모두 강제된다.
회사·팀·에이전트의 자연어 완료 보고'''
assert old in text, "docs anchor1 missing"
text = text.replace(old, new, 1)

old = '''비준수 범위에는 `audit_required`, 반려 실행의 열린 loop에는 `remediation`
지시를 만든다. 지시는 한 번에 기본 5건만 NCO `/api/task`로 전달하고,
안정적인 `workReportId`로 중복을 억제한다. 실제 NCO `taskId` 응답이 있어야
`dispatched`가 되며, 실패 시 최대 1시간의 지수 백오프로 재시도한다.'''
new = '''비준수 범위에는 `audit_required`, 반려 실행의 열린 loop에는 `remediation`
지시를 만든다. 지시는 한 번에 기본 5건만 NCO `/api/task`로 전달하고,
`directiveDelivery.dispatchOrder`는 `["remediation", "audit_required"]`로
교정 지시를 먼저 보낸다. NCO 스케줄러는 priority DESC이므로 모든 감사·교정
지시는 `directiveDelivery.ncoTaskPriority = 10`(최고 운영 우선순위)으로
전달한다. 안정적인 `workReportId`로 중복을 억제한다. 실제 NCO `taskId` 응답이
있어야 `dispatched`가 되며, 실패 시 최대 1시간의 지수 백오프로 재시도한다.
지시가 배치로 전달되면 Comms 엔진에 `priority: "urgent"`, `pinned: true` 공지가
올라가며, 감사 의무·6/6 최우선 목표·미통과 시 완료·점수 반영 금지를 다시
알린다.'''
assert old in text, "docs anchor2 missing"
text = text.replace(old, new, 1)
p.write_text(text)
print("docs ok")
