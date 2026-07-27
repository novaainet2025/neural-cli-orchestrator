import { describe, expect, it } from 'vitest';
import {
  detectDuplicateFailureBursts,
  evaluateLearningStageGate,
  normalizeErrorSignature,
  parseInjectedTaskMetrics,
  type FailureRow,
} from './learning-stage-gate.js';

// 2026-07-27 실측 프롬프트(task_3eejRUftHpUXmdOH / task_IjCXiEO-3LT65aIS /
// task_TF-0pwR0YBvnvs0b 세 태스크가 공유한 SHA-1 de1a9425… 프롬프트)에서 발췌.
const REAL_PROMPT = [
  '[업무보고 작성] 2026-07-27 오후 보고서를 작성하라.',
  '[실데이터]',
  '[tasks] 최근 7일: 전체=4, 완료=4, 실패성=0, 진행=0, 완료율=100.0%',
  '[work_reports] 최근 7일: submitted=2',
  '요구사항:',
].join('\n');

describe('parseInjectedTaskMetrics', () => {
  it('실측 프롬프트의 [tasks] 줄을 파싱한다', () => {
    expect(parseInjectedTaskMetrics(REAL_PROMPT)).toEqual({
      total: 4,
      completed: 4,
      failed: 0,
      active: 0,
    });
  });

  it('[tasks] 줄이 없으면 null', () => {
    expect(parseInjectedTaskMetrics('[업무보고 작성]\n[실데이터]\n데이터 없음')).toBeNull();
  });
});

describe('evaluateLearningStageGate', () => {
  it('실측 재현: 06:53:25 시점 DB(전체=6, 완료=4, 실패성=2)와 대조하면 stale + undercount를 잡는다', () => {
    const result = evaluateLearningStageGate({
      prompt: REAL_PROMPT,
      live: { total: 6, completed: 4, failed: 2, active: 0 },
    });
    expect(result.allowed).toBe(false);
    expect(result.violations.map(v => v.code)).toEqual([
      'STALE_DATA_CONTEXT',
      'FAILURE_UNDERCOUNT',
    ]);
    expect(result.injected).toEqual({ total: 4, completed: 4, failed: 0, active: 0 });
    expect(result.violations[1].detail).toContain('실패성=0');
  });

  it('스냅샷이 현재 DB와 일치하면 통과한다', () => {
    const result = evaluateLearningStageGate({
      prompt: REAL_PROMPT,
      live: { total: 4, completed: 4, failed: 0, active: 0 },
    });
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('실패를 과다 계상한 스냅샷은 stale이지만 undercount는 아니다', () => {
    const result = evaluateLearningStageGate({
      prompt: '[tasks] 최근 7일: 전체=6, 완료=3, 실패성=3, 진행=0, 완료율=50.0%',
      live: { total: 6, completed: 4, failed: 2, active: 0 },
    });
    expect(result.violations.map(v => v.code)).toEqual(['STALE_DATA_CONTEXT']);
  });

  it('failover 복제본의 프롬프트 해시 재등장을 CLONED_PROMPT_SNAPSHOT으로 잡는다', () => {
    const result = evaluateLearningStageGate({
      prompt: REAL_PROMPT,
      live: { total: 4, completed: 4, failed: 0, active: 0 },
      promptHash: 'de1a9425ec0dd0b900ad2466c7634f0fe57562b9',
      seenPromptHashes: ['de1a9425ec0dd0b900ad2466c7634f0fe57562b9'],
    });
    expect(result.allowed).toBe(false);
    expect(result.violations.map(v => v.code)).toEqual(['CLONED_PROMPT_SNAPSHOT']);
  });

  it('live를 주지 않으면 대조 검사를 건너뛰고 통과시킨다(fail-flag, 비차단)', () => {
    const result = evaluateLearningStageGate({ prompt: REAL_PROMPT });
    expect(result.allowed).toBe(true);
  });

  it('[tasks] 줄 자체가 없으면 MISSING_TASK_METRICS로 즉시 종료한다', () => {
    const result = evaluateLearningStageGate({
      prompt: '[업무보고 작성]\n[실데이터]\n데이터 없음',
      live: { total: 6, completed: 4, failed: 2, active: 0 },
    });
    expect(result.allowed).toBe(false);
    expect(result.violations.map(v => v.code)).toEqual(['MISSING_TASK_METRICS']);
    expect(result.injected).toBeNull();
  });

  it('표본이 0건이면 [tasks] 줄 부재는 정상이다 (실측 task_53abN7hMCQcH5SrT 오탐 방지)', () => {
    const result = evaluateLearningStageGate({
      prompt: '[업무보고 작성]\n[실데이터]\n[work_reports] 최근 7일: submitted=2',
      live: { total: 0, completed: 0, failed: 0, active: 0 },
    });
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.injected).toBeNull();
  });
});

describe('normalizeErrorSignature', () => {
  it('괄호 상세와 숫자를 지워 같은 계열을 묶는다', () => {
    expect(normalizeErrorSignature('provider_unavailable: claude-code (open/generic)'))
      .toBe(normalizeErrorSignature('provider_unavailable: claude-code (open/quota)'));
    expect(normalizeErrorSignature('queue_wait_timeout: provider codex busy for 1800000ms'))
      .toBe('queue_wait_timeout: provider codex busy for nms');
  });

  it('null은 빈 문자열', () => {
    expect(normalizeErrorSignature(null)).toBe('');
  });
});

describe('detectDuplicateFailureBursts', () => {
  // 2026-07-27 06:53:25 실측 4건 — 4개 팀에 각각 1건씩 계상됐다.
  const REAL_ROWS: FailureRow[] = [
    { taskId: 'task_SgIYb63gYzON8zWQ', teamId: 'team_tech-port-02-safety-license', agentId: 'claude-code', completedAt: '2026-07-27 06:53:25', error: 'provider_unavailable: claude-code (open/generic)' },
    { taskId: 'task_TDsq55NUhMScwcCQ', teamId: 'team_gov-assurance-audit', agentId: 'claude-code', completedAt: '2026-07-27 06:53:25', error: 'provider_unavailable: claude-code (open/generic)' },
    { taskId: 'task_IjCXiEO-3LT65aIS', teamId: 'team_gov-evolution-learning', agentId: 'claude-code', completedAt: '2026-07-27 06:53:25', error: 'provider_unavailable: claude-code (open/generic)' },
    { taskId: 'task_CmAsfvFiSfqBnsHY', teamId: 'team_gov-command-collaboration', agentId: 'claude-code', completedAt: '2026-07-27 06:53:25', error: 'provider_unavailable: claude-code (open/generic)' },
  ];

  it('실측 4건을 단일 버스트로 묶고 영향 팀 수를 센다', () => {
    const bursts = detectDuplicateFailureBursts(REAL_ROWS);
    expect(bursts).toHaveLength(1);
    expect(bursts[0].agentId).toBe('claude-code');
    expect(bursts[0].second).toBe('2026-07-27 06:53:25');
    expect(bursts[0].distinctTeams).toBe(4);
    expect(bursts[0].taskIds).toEqual([
      'task_CmAsfvFiSfqBnsHY',
      'task_IjCXiEO-3LT65aIS',
      'task_SgIYb63gYzON8zWQ',
      'task_TDsq55NUhMScwcCQ',
    ]);
  });

  it('한 팀에서만 반복된 실패는 버스트로 보지 않는다(팀 품질 실패일 수 있음)', () => {
    const sameTeam = REAL_ROWS.map(row => ({ ...row, teamId: 'team_gov-evolution-learning' }));
    expect(detectDuplicateFailureBursts(sameTeam)).toEqual([]);
  });

  it('시각이 초 단위로 다르면 별개 그룹이다', () => {
    const spread = REAL_ROWS.map((row, i) => ({
      ...row,
      completedAt: `2026-07-27 06:53:${String(20 + i).padStart(2, '0')}`,
    }));
    expect(detectDuplicateFailureBursts(spread)).toEqual([]);
  });

  it('ISO 타임스탬프와 공백 구분 타임스탬프를 같은 초로 묶는다', () => {
    const mixed: FailureRow[] = [
      { ...REAL_ROWS[0], completedAt: '2026-07-27T06:53:25.412Z' },
      REAL_ROWS[1],
    ];
    const bursts = detectDuplicateFailureBursts(mixed);
    expect(bursts).toHaveLength(1);
    expect(bursts[0].distinctTeams).toBe(2);
  });

  it('completedAt/agentId가 없는 행은 무시한다', () => {
    const partial: FailureRow[] = [
      { ...REAL_ROWS[0], completedAt: null },
      { ...REAL_ROWS[1], agentId: null },
    ];
    expect(detectDuplicateFailureBursts(partial)).toEqual([]);
  });
});
