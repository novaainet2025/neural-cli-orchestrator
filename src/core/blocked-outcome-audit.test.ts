import { describe, it, expect } from 'vitest';
import { parseBlockedStageOutcome } from './stage-outcome.js';
import {
  applyBlockedStageOutcome,
  isCompanyRunBlocked,
  type CompanyRun,
  type RunStage,
} from './company-orchestrator.js';
import { classifyDeclaredPrerequisiteBlock } from '../server/gateway.js';

/**
 * 중복에러방지팀 감사 회귀 — team_content-build cycle 2.
 *
 * 목적: `STAGE_OUTCOME: BLOCKED` 계약이 (a) 정당한 차단만 허용하고, (b) 근거 없는
 * 자기신고 차단과 일반 실패는 기존 실패·재시도 경로에 남기는지를 **실행으로** 확인한다.
 * 픽스처 A/B는 db/nco.db 실제 행(task_eMva63ao2fjDYEaX, task_jX5LC9uaq8hTO4kP)의
 * response 원문 발췌이며, 픽스처 C는 같은 48h 표본의 실제 error 문자열이다.
 */

// ── 실측 코퍼스 (db/nco.db tasks.response / tasks.error 원문) ──────────────
const REAL_BLOCKED_EMVA = [
  'error: BLOCKED — 승인된 근거팩이 없어 제작을 진행할 수 없습니다.',
  '',
  '[Evidence Tier 1] 파일 내용·명령 출력 직접 검증.',
  '',
  '차단 근거:',
  '',
  '- 7개 근거팩 모두 `approval_status: "INCOMPLETE"`',
  '- OAuth 확인 실패:',
  '  `OAuth refresh request failed: [Errno 8] nodename nor servname provided, or not known`',
].join('\n');

const REAL_BLOCKED_JX5L = [
  'error: BLOCKED — 승인된 근거팩이 없어 제작팀 작업을 안전하게 진행할 수 없습니다.',
  '',
  '[Evidence Tier 1] 현재 파일 내용과 명령 출력을 직접 검증했습니다.',
  '',
  '- 근거팩 7개 모두 `approval_status: INCOMPLETE`',
  '- 테스트: `Ran 38 tests` / `OK`',
].join('\n');

const REAL_PREREQUISITE_PROMPT =
  '[팀 하위작업: 고품질 콘텐츠 제작팀]\n' +
  '승인된 근거팩만 입력으로 사용해 아직 없는 대표 주제 6개의 1,200단어 이상 원고를 만든다.';

const REAL_GENERAL_FAILURES = [
  'discussion_insufficient_valid_proposals:0/2',
  'discussion_insufficient_valid_proposals:1/2',
  'failure-pattern: agent reported error',
];

// ── 계약 준수 픽스처 ──────────────────────────────────────────────────────
const CONTRACT_FIELDS = {
  fingerprint: 'evidence-packs:approval_status=incomplete',
  evidence: 'evidence-packs.yaml 7개 항목 approval_status=INCOMPLETE 직접 확인',
};

function contractResponse(overrides: Partial<Record<string, string | null>> = {}): string {
  const lines: Record<string, string | null> = {
    prefix: 'error: 승인된 근거팩이 없어 안전하게 중단합니다.',
    STAGE_OUTCOME: 'BLOCKED',
    BLOCKER_FINGERPRINT: CONTRACT_FIELDS.fingerprint,
    BLOCKER_EVIDENCE: CONTRACT_FIELDS.evidence,
    EVIDENCE_TIER: '1',
    ...overrides,
  };
  const out: string[] = [];
  if (lines.prefix !== null) out.push(lines.prefix as string);
  for (const field of ['STAGE_OUTCOME', 'BLOCKER_FINGERPRINT', 'BLOCKER_EVIDENCE', 'EVIDENCE_TIER']) {
    if (lines[field] !== null) out.push(`${field}: ${lines[field]}`);
  }
  return out.join('\n');
}

function makeStage(overrides: Partial<RunStage> = {}): RunStage {
  return {
    teamSlug: 'content-build',
    teamId: 'team_content-build',
    executor: 'codex',
    status: 'running',
    ...overrides,
  } as RunStage;
}

function makeRun(stages: RunStage[]): CompanyRun {
  return {
    id: 'run_audit_fixture',
    companySlug: 'sns-blog',
    mode: 'pipeline',
    status: 'running',
    stages,
    iteration: 1,
    maxIterations: 3,
  } as unknown as CompanyRun;
}

// ── 판정 1: 허용(ALLOW) — 계약을 갖춘 정당한 차단만 blocked가 된다 ──────────
describe('감사 판정 1 — 정당한 BLOCKED만 허용', () => {
  it('4필드 + Tier 1 근거를 갖추면 blocked로 인정한다', () => {
    expect(parseBlockedStageOutcome(contractResponse())).toMatchObject({
      kind: 'blocked',
      fingerprint: CONTRACT_FIELDS.fingerprint,
      evidenceTier: 1,
    });
  });

  it('blocked 인정 시 하류는 skipped, run은 partial이며 실패로 계상되지 않는다', () => {
    const blocked = makeStage({ status: 'running' });
    const downstream = makeStage({ teamSlug: 'content-quality', status: 'pending' });
    const run = makeRun([blocked, downstream]);

    expect(applyBlockedStageOutcome(run, blocked, contractResponse())).toBeDefined();
    expect(blocked.status).toBe('blocked');
    expect(downstream.status).toBe('skipped');
    expect(run.status).toBe('partial');
    expect(run.summary?.failed).toBe(0);
    expect(isCompanyRunBlocked(run)).toBe(true);
  });

  it('status: 프로토콜 접두사도 error: 와 동등하게 허용한다', () => {
    expect(parseBlockedStageOutcome(contractResponse({ prefix: 'status: 선행조건 미충족' })))
      .toBeDefined();
  });
});

// ── 판정 2: 차단(DENY) — 근거 없는 자기신고 BLOCKED는 일반 실패로 남는다 ────
describe('감사 판정 2 — 근거 없는 BLOCKED는 실패·재시도 유지', () => {
  const denyCases: Array<[string, string]> = [
    ['맨몸 자연어 BLOCKED', 'error: BLOCKED — 승인 여부를 확인하지 못했습니다.'],
    ['협업 프로토콜 접두사 없음', contractResponse({ prefix: null })],
    ['FINGERPRINT 누락', contractResponse({ BLOCKER_FINGERPRINT: null })],
    ['EVIDENCE 누락', contractResponse({ BLOCKER_EVIDENCE: null })],
    ['EVIDENCE_TIER 누락', contractResponse({ EVIDENCE_TIER: null })],
    ['EVIDENCE_TIER=2 (간접 근거)', contractResponse({ EVIDENCE_TIER: '2' })],
    ['EVIDENCE_TIER=3 (상태 문자열)', contractResponse({ EVIDENCE_TIER: '3' })],
    ['근거 placeholder: unverified', contractResponse({ BLOCKER_EVIDENCE: 'unverified' })],
    ['근거 placeholder: 미검증', contractResponse({ BLOCKER_EVIDENCE: '미검증' })],
    ['근거 placeholder: none', contractResponse({ BLOCKER_EVIDENCE: 'none' })],
    ['fingerprint 8자 미만', contractResponse({ BLOCKER_FINGERPRINT: 'ev:x' })],
    ['STAGE_OUTCOME 값이 BLOCKED가 아님', contractResponse({ STAGE_OUTCOME: 'FAILED' })],
  ];

  it.each(denyCases)('%s → 구조화 차단으로 인정하지 않는다', (_label, response) => {
    expect(parseBlockedStageOutcome(response)).toBeUndefined();
  });

  it('거부된 자기신고는 stage/run 상태를 바꾸지 않아 재시도 경로가 보존된다', () => {
    const stage = makeStage({ status: 'failed' });
    const run = makeRun([stage]);

    expect(applyBlockedStageOutcome(run, stage, 'error: BLOCKED — 근거 미확인')).toBeUndefined();
    expect(stage.status).toBe('failed');
    expect(run.status).toBe('running');
    expect(isCompanyRunBlocked(run)).toBe(false);
  });
});

// ── 판정 3: 일반 실패는 어떤 경우에도 blocked로 승격되지 않는다 ─────────────
describe('감사 판정 3 — 일반 실패 미승격', () => {
  it.each(REAL_GENERAL_FAILURES)('실측 error "%s"는 blocked가 아니다', (error) => {
    expect(parseBlockedStageOutcome(error)).toBeUndefined();
  });

  it('실패 문구에 BLOCKED 단어가 섞여도 4필드가 없으면 실패로 남는다', () => {
    expect(parseBlockedStageOutcome(
      'error: build BLOCKED by tsc: 12 errors\nEVIDENCE_TIER: 1',
    )).toBeUndefined();
  });
});

// ── 판정 4: 실측 이력 2건 — 소급 재분류가 일어나지 않음(설계 확인) ──────────
describe('감사 판정 4 — 실측 이력의 소급 재분류 없음', () => {
  it.each([
    ['task_eMva63ao2fjDYEaX', REAL_BLOCKED_EMVA],
    ['task_jX5LC9uaq8hTO4kP', REAL_BLOCKED_JX5L],
  ])('%s 원문은 계약 필드가 없어 여전히 실패로 유지된다', (_id, response) => {
    expect(parseBlockedStageOutcome(response)).toBeUndefined();
    expect(classifyDeclaredPrerequisiteBlock(response, { prompt: REAL_PREREQUISITE_PROMPT }))
      .toBeUndefined();
  });

  it('같은 프롬프트라도 계약을 갖춘 응답이면 게이트웨이가 차단으로 종결한다', () => {
    expect(classifyDeclaredPrerequisiteBlock(contractResponse(), {
      prompt: REAL_PREREQUISITE_PROMPT,
    })).toBe('blocked-prerequisite: declared prerequisite unavailable');
  });

  it('프롬프트가 선행조건을 선언하지 않으면 계약을 갖춰도 게이트웨이는 차단하지 않는다', () => {
    expect(classifyDeclaredPrerequisiteBlock(contractResponse(), {
      prompt: '원고 6개를 작성하라.',
    })).toBeUndefined();
  });
});

// ── 판정 5: fingerprint 중복 차단 조건 ────────────────────────────────────
describe('감사 판정 5 — blocker fingerprint 중복 조건', () => {
  it('동일 fingerprint는 run 내 1회만 기록된다', () => {
    const first = makeStage({ status: 'running' });
    const second = makeStage({ teamSlug: 'content-quality', status: 'running' });
    const run = makeRun([first, second]);

    applyBlockedStageOutcome(run, first, contractResponse());
    applyBlockedStageOutcome(run, second, contractResponse());
    expect(run.blockerFingerprints).toEqual([CONTRACT_FIELDS.fingerprint]);
  });

  it('원인이 다르면 별개 fingerprint로 누적되어 과잉 중복차단이 발생하지 않는다', () => {
    const first = makeStage({ status: 'running' });
    const second = makeStage({ teamSlug: 'content-quality', status: 'running' });
    const run = makeRun([first, second]);

    applyBlockedStageOutcome(run, first, contractResponse());
    applyBlockedStageOutcome(run, second, contractResponse({
      BLOCKER_FINGERPRINT: 'blogger-oauth:refresh_dns_failure',
    }));
    expect(run.blockerFingerprints).toEqual([
      CONTRACT_FIELDS.fingerprint,
      'blogger-oauth:refresh_dns_failure',
    ]);
  });

  it('fingerprint는 대소문자·공백 정규화되어 표기 차이로 중복 누적되지 않는다', () => {
    const stage = makeStage({ status: 'running' });
    const run = makeRun([stage]);
    applyBlockedStageOutcome(run, stage, contractResponse({
      BLOCKER_FINGERPRINT: '  Evidence-Packs:APPROVAL_STATUS=Incomplete  ',
    }));
    expect(run.blockerFingerprints).toEqual(['evidence-packs:approval_status=incomplete']);
  });

  it('중복 차단은 run 범위에 한정되어 새 run의 재시도를 억제하지 않는다', () => {
    const stageA = makeStage({ status: 'running' });
    const runA = makeRun([stageA]);
    applyBlockedStageOutcome(runA, stageA, contractResponse());

    const stageB = makeStage({ status: 'pending' });
    const runB = makeRun([stageB]);
    expect(isCompanyRunBlocked(runB)).toBe(false);
    expect(runB.blockerFingerprints ?? []).toEqual([]);
  });
});
