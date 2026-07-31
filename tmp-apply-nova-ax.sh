#!/bin/sh
set -e
VA=/Users/nova-ai/project/nova-ax/src/core/verification-authority.ts
python3 << 'PY'
from pathlib import Path

base = Path("/Users/nova-ai/project/nova-ax")

va = base / "src/core/verification-authority.ts"
text = va.read_text()
if "NCO_DIRECTIVE_PRIORITY" not in text:
    text = text.replace(
        "export const COMPANY_SCOPE_TEAM_ID = \"company-scope\";\n",
        "export const COMPANY_SCOPE_TEAM_ID = \"company-scope\";\n"
        "/** NCO /api/task priority for audit_required and remediation directives. */\n"
        "export const NCO_DIRECTIVE_PRIORITY = 10;\n",
        1,
    )
text = text.replace(
    "        ncoPriority: 10,\n",
    "        ncoPriority: NCO_DIRECTIVE_PRIORITY,\n",
    1,
)
text = text.replace(
    "      directiveDelivery: {\n"
    "        target: \"NCO /api/task\",\n"
    "        boundedBatchDefault: 5,\n",
    "      directiveDelivery: {\n"
    "        target: \"NCO /api/task\",\n"
    "        ncoPriority: NCO_DIRECTIVE_PRIORITY,\n"
    "        directiveOrder: [\"remediation\", \"audit_required\"],\n"
    "        boundedBatchDefault: 5,\n",
    1,
)
text = text.replace(
    "        \"모든 회사·팀의 감사 통과는 Nova-AX의 최우선 운영 목표다.\",\n",
    "        \"최우선 목표: 모든 회사·팀의 작업 보고 의무 수신 및 6/6 감사 통과.\",\n",
    1,
)
text = text.replace(
    "          row.type === \"remediation\" ? \"codex\" : \"cursor-agent\",\n"
    "          10,\n",
    "          row.type === \"remediation\" ? \"codex\" : \"cursor-agent\",\n"
    "          NCO_DIRECTIVE_PRIORITY,\n",
    1,
)
va.write_text(text)

idx = base / "src/index.ts"
text = idx.read_text()
if "NCO_DIRECTIVE_PRIORITY" not in text:
    text = text.replace(
        "  COMPANY_SCOPE_TEAM_ID,\n"
        "  SupremeVerificationAuthority,\n",
        "  COMPANY_SCOPE_TEAM_ID,\n"
        "  NCO_DIRECTIVE_PRIORITY,\n"
        "  SupremeVerificationAuthority,\n",
        1,
    )
policy_block = """const verificationPolicies = verificationAuthority.getPolicies();
const verificationTopPriority = verificationPolicies.topPriority as {
  mission: string;
  ncoPriority: number;
};
commsEngine.createAnnouncement(
  "Supreme Verification Commander Policy",
  `[최우선 목표] ${verificationTopPriority.mission}\\n\\n`
  + `NCO directive priority=${NCO_DIRECTIVE_PRIORITY}. `
  + "통과 전 완료·점수 반영 금지. 모든 활성 회사·팀 작업 보고 의무 수신 및 6/6 감사 통과가 최우선이다.",
  "Supreme Verification Commander",
  {
    priority: "urgent",
    audience: "all",
    pinned: true,
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  }
);
"""
if "Supreme Verification Commander Policy" not in text:
    text = text.replace(
        "  console.warn(\"[WARN] Verification scope sync failed:\", (e as Error).message);\n"
        "}\n"
        "verificationScopeTimer = setInterval",
        "  console.warn(\"[WARN] Verification scope sync failed:\", (e as Error).message);\n"
        "}\n"
        + policy_block +
        "verificationScopeTimer = setInterval",
        1,
    )
idx.write_text(text)

test = base / "src/core/verification-authority.test.ts"
text = test.read_text()
if "NCO_DIRECTIVE_PRIORITY" not in text:
    text = text.replace(
        "  COMPANY_SCOPE_TEAM_ID,\n"
        "  SupremeVerificationAuthority,\n",
        "  COMPANY_SCOPE_TEAM_ID,\n"
        "  NCO_DIRECTIVE_PRIORITY,\n"
        "  SupremeVerificationAuthority,\n",
        1,
    )
text = text.replace(
    "      ncoPriority: 10,\n",
    "      ncoPriority: NCO_DIRECTIVE_PRIORITY,\n",
    1,
)
if "test(\"16." not in text:
    test16 = '''
    const directiveDelivery = policies.directiveDelivery as {
      ncoPriority: number;
      directiveOrder: string[];
    };
    assert.strictEqual(directiveDelivery.ncoPriority, NCO_DIRECTIVE_PRIORITY);
    assert.deepStrictEqual(directiveDelivery.directiveOrder, ["remediation", "audit_required"]);
  });

  test("16. remediation은 audit_required보다 먼저 dispatch되고 둘 모두 priority=10", async () => {
    authority.syncScopes([
      {
        companyId: "order-company",
        teamId: "order-team",
        teamName: "Order Team",
        active: true,
      },
    ]);
    const submission = createBaseSubmission();
    submission.companyId = "order-company";
    submission.teamId = "order-team";
    submission.taskId = "order-remediation-task";
    submission.taskType = "blog";
    submission.artifact.uri = "https://example.com/order-remediation-task";
    submission.artifact.publishedAt = new Date().toISOString();
    observer.mockObservation = { ...validObservation, visibleCharacters: 500 };

    const rejected = await authority.submit(submission);
    assert.strictEqual(rejected.status, "rejected");
    assert.ok(rejected.remediationLoop?.loopId);

    const queued = (authority.getOversight() as any).directives.filter(
      (directive: any) => directive.status === "queued"
    );
    assert.ok(queued.some((directive: any) => directive.type === "remediation"));
    assert.ok(queued.some((directive: any) => directive.type === "audit_required"));

    const calls: Array<{ type: string; priority: number; prompt: string }> = [];
    const outcome = await authority.dispatchDirectives({
      async createTask(prompt, agent, priority, metadata) {
        const directive = (authority.getOversight() as any).directives.find(
          (item: any) => item.id === (metadata as any)?.verificationDirectiveId
        );
        calls.push({
          type: directive?.type || "unknown",
          priority,
          prompt,
        });
        return { taskId: `nco-task-${calls.length}` };
      },
    }, { projectDir: "/workspace", limit: 2 });
    assert.strictEqual(outcome.selected, 2);
    assert.strictEqual(outcome.dispatched, 2);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].type, "remediation");
    assert.strictEqual(calls[1].type, "audit_required");
    assert.strictEqual(calls[0].priority, NCO_DIRECTIVE_PRIORITY);
    assert.strictEqual(calls[1].priority, NCO_DIRECTIVE_PRIORITY);
    assert.match(calls[0].prompt, /최우선 목표/);
    assert.match(calls[1].prompt, /최우선 목표/);
  });
});
'''
    text = text.replace(
        "    });\n  });\n});",
        test16,
        1,
    )
test.write_text(text)

http = base / "src/test-verification-http.ts"
text = http.read_text()
if "directiveDelivery.ncoPriority" not in text:
    text = text.replace(
        "assert.equal(policiesRes.body.topPriority.noCompletionOrScoreBeforePass, true);\n",
        "assert.equal(policiesRes.body.topPriority.noCompletionOrScoreBeforePass, true);\n"
        "assert.equal(policiesRes.body.directiveDelivery.ncoPriority, 10);\n"
        "assert.deepEqual(policiesRes.body.directiveDelivery.directiveOrder, [\"remediation\", \"audit_required\"]);\n",
        1,
    )
http.write_text(text)

doc = base / "docs/10-verification-authority.md"
text = doc.read_text()
if "directiveOrder" not in text:
    text = text.replace(
        "`audit_required`와 `remediation` NCO 작업은 모두 `priority=10`으로 강제 발행되며\n"
        "해당 목표가 프롬프트에 명시된다.",
        "`audit_required`와 `remediation` NCO 작업은 모두 `priority=10`(`NCO_DIRECTIVE_PRIORITY`)으로 강제 발행되며\n"
        "프롬프트에 `최우선 목표`가 명시된다. dispatch 순서는 `remediation` → `audit_required`다.\n"
        "`GET /api/verification/policies`의 `directiveDelivery`는 `ncoPriority=10`과\n"
        "`directiveOrder: [\"remediation\", \"audit_required\"]`를 노출한다.",
        1,
    )
if "Supreme Verification Commander Policy" not in text:
    text = text.replace(
        "감사 지시 전달은 `AX_VERIFICATION_DISPATCH_BATCH`(기본 5),",
        "시작 시 CommsEngine에 `urgent`+`pinned` 정책 공지(`Supreme Verification Commander Policy`)가 발행되고, directive dispatch 시에도\n"
        "동일한 최우선 공지가 추가된다. 감사 지시 전달은 `AX_VERIFICATION_DISPATCH_BATCH`(기본 5),",
        1,
    )
doc.write_text(text)
print("applied")
PY
