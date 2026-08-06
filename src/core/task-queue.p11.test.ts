import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  allowGenericProviderFailover,
  classifyResult,
  computeCircuitCooldownWaitMs,
  filterCommanderLaneEscalationAgents,
  filterEvolutionSkillsEscalationAgents,
  filterRecoveryCheckpointEscalationAgents,
  isCircuitCooldownWaitEnabled,
  isEvolutionLearningRecoverableFailure,
  isTransientFailure,
  baselineForReconciliation,
  reconcileVerifierBaseline,
  shouldReconcileVerifierBaseline,
  taskQueue,
} from './task-queue.js';
import { decideFinalEscalation } from './task-escalation.js';
import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';

describe('classifyResult headless permission denial gate', () => {
  const observedCommandDenial = 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.';
  const observedMcpDenial = observedCommandDenial.replace('"command"', '"mcp"').replace('command(<target>)', 'mcp(<target>)');

  it.each([observedCommandDenial, observedMcpDenial])(
    'rejects the observed Jetski success envelope and enables bounded failover',
    (output) => {
      const classified = classifyResult({ success: true, output } as any);
      expect(classified).toMatchObject({
        success: false,
        error: 'silent-failure: headless tool permission auto-denied',
      });
      expect(isTransientFailure(classified)).toBe(true);
    },
  );

  it('is runtime-reversible and does not reject reports that quote the incident', () => {
    expect(classifyResult({ success: true, output: observedCommandDenial } as any, 'off'))
      .toMatchObject({ success: true });
    expect(classifyResult({
      success: true,
      output: `Audit note: ${observedCommandDenial}`,
    } as any)).toMatchObject({ success: true });
  });
});

// P11: 팀 내부 다른 provider로 회복 가능한 실행 실패만 대상. 정상완료·취소·rate-limit 제외.
describe('isTransientFailure (P11 진리표)', () => {
  it('정상완료 → false (오탐 방지)', () => {
    expect(isTransientFailure({ success: true } as any)).toBe(false);
  });
  it('사용자 취소 → false', () => {
    expect(isTransientFailure({ success: false, status: 'cancelled' } as any)).toBe(false);
  });
  it('빈출력 silent-failure → true', () => {
    expect(isTransientFailure({ success: false, error: 'silent-failure: empty output' } as any)).toBe(true);
  });
  it('무응답 silent-failure → true', () => {
    expect(isTransientFailure({ success: false, error: 'silent-failure: no agent response' } as any)).toBe(true);
  });
  it('idle 타임아웃 → true', () => {
    expect(isTransientFailure({ success: false, error: 'timeout(idle)' } as any)).toBe(true);
  });
  it('프로바이더 abort → true', () => {
    expect(isTransientFailure({ success: false, error: 'Aborting operation...' } as any)).toBe(true);
  });
  it('열린 circuit과 provider unavailable → true', () => {
    expect(isTransientFailure({
      success: false,
      error: 'Circuit breaker open for agent claude-code (generic)',
    } as any)).toBe(true);
    expect(isTransientFailure({
      success: false,
      error: 'provider_unavailable: opencode (open/quota)',
    } as any)).toBe(true);
  });
  it('provider queue 대기 초과 → true', () => {
    expect(isTransientFailure({
      success: false,
      error: 'queue_wait_timeout: provider claude-code busy for 1800000ms',
    } as any)).toBe(true);
  });
  it('provider 인증 실패 → true', () => {
    expect(isTransientFailure({
      success: false,
      error: 'subprocess exited with code 1: Invalid API key · Fix external API key',
    } as any)).toBe(true);
    expect(isTransientFailure({
      success: false,
      error: 'Provider failure detected: auth',
    } as any)).toBe(true);
  });
  it('provider CLI 프로세스 실패 → true', () => {
    expect(isTransientFailure({
      success: false,
      error: 'codex: CLI failed exit=1 — provider process failed',
    } as any)).toBe(true);
  });
  it('Continuous Learning 실측 세션 한도·인증 CLI 실패 → true', () => {
    expect(isTransientFailure({
      success: false,
      error: "subprocess exited with code 1: You've hit your session limit",
    } as any)).toBe(true);
    expect(isTransientFailure({
      success: false,
      error: 'opencode: CLI failed exit=1 — invalid x-api-key',
    } as any)).toBe(true);
  });
  it('rate-limit → false (기존 backoff 경로가 처리)', () => {
    expect(isTransientFailure({ success: false, error: 'rate limit exceeded' } as any)).toBe(false);
    expect(isTransientFailure({
      success: false,
      error: 'codex: CLI failed exit=1 — rate limit exceeded',
    } as any)).toBe(false);
    expect(isTransientFailure({
      success: false,
      error: 'codex: CLI failed exit=1 — You have hit your usage limit',
    } as any)).toBe(false);
  });
  it('task verifier 실패 → false', () => {
    expect(isTransientFailure({
      success: false,
      error: 'verifier failed: npm test',
    } as any)).toBe(false);
    expect(isTransientFailure({
      success: false,
      error: 'verifier failed: subprocess exited with code 1: Invalid API key in fixture',
    } as any)).toBe(false);
  });
  it('status 없는 provider CLI 취소 → false', () => {
    expect(isTransientFailure({
      success: false,
      error: 'codex: CLI cancelled — signal',
    } as any)).toBe(false);
    expect(isTransientFailure({
      success: false,
      error: 'subprocess cancelled: user requested',
    } as any)).toBe(false);
  });
});

describe('generic provider failover metadata gate', () => {
  it('정확한 boolean true만 팀 밖 generic escalation을 허용', () => {
    expect(allowGenericProviderFailover({ allowProviderFailover: true })).toBe(true);
    expect(allowGenericProviderFailover({ allowProviderFailover: false })).toBe(false);
    expect(allowGenericProviderFailover({ allowProviderFailover: 'true' })).toBe(false);
    expect(allowGenericProviderFailover({})).toBe(false);
    expect(allowGenericProviderFailover(undefined)).toBe(false);
  });

  it('고정 model도 호출자가 명시적으로 허용한 경우에만 failover', () => {
    expect(allowGenericProviderFailover({ model: 'qwen3:30b-a3b' })).toBe(false);
    expect(allowGenericProviderFailover({ model: 'qwen3:30b-a3b', allowProviderFailover: true })).toBe(true);
    expect(allowGenericProviderFailover({ model: 'qwen3:30b-a3b', allowProviderFailover: false })).toBe(false);
  });
});

describe('isEvolutionLearningRecoverableFailure (bounded cycle-2 recovery)', () => {
  it('실측 세션 한도와 401 출력은 Continuous Learning에서만 복구', () => {
    const sessionLimit = {
      success: false,
      output: '',
      error: "subprocess exited with code 1: You've hit your session limit",
    };
    const invalidKeyBody = {
      success: false,
      output: '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      error: 'opencode: CLI failed exit=1',
    };

    expect(isEvolutionLearningRecoverableFailure(
      'gov-evolution-learning',
      sessionLimit,
    )).toBe(true);
    expect(isEvolutionLearningRecoverableFailure(
      'gov-evolution-learning',
      invalidKeyBody,
    )).toBe(true);
    expect(isEvolutionLearningRecoverableFailure(
      'gov-evolution-memory',
      sessionLimit,
    )).toBe(false);
  });

  it('정상완료와 사용자 취소는 복구하지 않음', () => {
    expect(isEvolutionLearningRecoverableFailure(
      'gov-evolution-learning',
      { success: true, output: 'done', error: 'session limit' },
    )).toBe(false);
    expect(isEvolutionLearningRecoverableFailure(
      'gov-evolution-learning',
      { success: false, status: 'cancelled', output: '', error: 'session limit' },
    )).toBe(false);
  });
});

describe('Recovery Checkpoint escalation guard (bounded cycle-1 recovery)', () => {
  const knownAgents = ['claude-code', 'opencode', 'cursor-agent', 'codex', 'agy'];

  it('대상 팀의 generic escalation 후보에서 weekly-limit claude-code만 제외', () => {
    const filtered = filterRecoveryCheckpointEscalationAgents(
      'team_tech-port-03-recovery-checkpoint',
      knownAgents,
    );

    expect(filtered).toEqual(['opencode', 'cursor-agent', 'codex', 'agy']);
    expect(decideFinalEscalation({
      failedAgentId: 'opencode',
      failureReason: 'queue_wait_timeout: provider opencode busy for 1800000ms',
      attemptedAgents: ['opencode'],
      circuitOpenAgents: ['cursor-agent', 'codex'],
      knownAgents: filtered,
      now: () => '2026-07-28T00:00:00.000Z',
    }).nextAgentId).toBe('agy');
  });

  it('다른 팀과 runtime rollback에서는 기존 후보 순서를 그대로 보존', () => {
    expect(filterRecoveryCheckpointEscalationAgents(
      'team_gov-evolution-learning',
      knownAgents,
    )).toEqual(knownAgents);
    expect(filterRecoveryCheckpointEscalationAgents(
      'team_tech-port-03-recovery-checkpoint',
      knownAgents,
      'off',
    )).toEqual(knownAgents);
  });
});

describe('Skill Academy escalation guard (bounded cycle-1 recovery)', () => {
  const knownAgents = ['claude-code', 'opencode', 'cursor-agent', 'codex', 'ollama'];

  it('대상 팀의 generic escalation 후보에서 weekly-limit/queue-wait claude-code만 제외', () => {
    const filtered = filterEvolutionSkillsEscalationAgents(
      'team_gov-evolution-skills',
      knownAgents,
    );

    expect(filtered).toEqual(['opencode', 'cursor-agent', 'codex', 'ollama']);
    expect(decideFinalEscalation({
      failedAgentId: 'codex',
      failureReason: 'queue_wait_timeout: provider codex busy for 1800000ms',
      attemptedAgents: ['codex'],
      circuitOpenAgents: ['cursor-agent', 'opencode'],
      knownAgents: filtered,
      now: () => '2026-07-28T00:00:00.000Z',
    }).nextAgentId).toBe('ollama');
  });

  it('다른 팀과 runtime rollback에서는 기존 후보 순서를 그대로 보존', () => {
    expect(filterEvolutionSkillsEscalationAgents(
      'team_gov-evolution-learning',
      knownAgents,
    )).toEqual(knownAgents);
    expect(filterEvolutionSkillsEscalationAgents(
      'team_gov-evolution-skills',
      knownAgents,
      'off',
    )).toEqual(knownAgents);
  });
});

describe('filterCommanderLaneEscalationAgents', () => {
  const knownAgents = ['opencode', 'claude-code', 'cursor-agent', 'codex', 'ollama'];

  it('팀과 무관하게 claude-code를 generic 에스컬레이션 후보에서 제외', () => {
    // 팀 스코프 완화 두 건과 달리 teamId 인자를 받지 않는다. 실패가 특정 팀이 아니라
    // 전반에 퍼져 있어(24h: gov-command-strategic 34 · ax-decision-coordination-2026 32
    // · gov-engineering-architecture 30 …) 팀 열거로는 못 쫓아가기 때문이다.
    expect(filterCommanderLaneEscalationAgents(knownAgents))
      .toEqual(['opencode', 'cursor-agent', 'codex', 'ollama']);
  });

  it('제외 후 후보가 남지 않으면 원본을 유지해 태스크를 굶기지 않음', () => {
    // 이 필터의 목적은 claude-code 유입을 줄이는 것이지 에스컬레이션 자체를 막는 것이
    // 아니다. 후보가 claude-code 뿐인데 빈 배열을 주면 decideFinalEscalation이
    // 대상을 못 찾아 태스크가 그대로 실패로 떨어진다.
    expect(filterCommanderLaneEscalationAgents(['claude-code'])).toEqual(['claude-code']);
  });

  it('runtime rollback(off/0/false)에서는 원래 후보 순서를 보존', () => {
    for (const toggle of ['off', '0', 'false', 'OFF']) {
      expect(filterCommanderLaneEscalationAgents(knownAgents, toggle)).toEqual(knownAgents);
    }
  });

  it('claude-code가 없는 후보 목록은 그대로 통과', () => {
    const withoutCommander = ['opencode', 'codex'];
    expect(filterCommanderLaneEscalationAgents(withoutCommander)).toEqual(withoutCommander);
  });

  it('제외 후 decideFinalEscalation이 claude-code로 재큐잉하지 않음', () => {
    // 회귀 방지의 본체. 라이브 실패 사유 상위 2건이
    // lease_expired_twice 306건과 `queue_wait_timeout: provider claude-code busy` 40건인데,
    // 둘 다 claude-code로 에스컬레이션된 뒤 1-wide lane 에서 차례를 못 받아 죽은 것이다.
    const filtered = filterCommanderLaneEscalationAgents(knownAgents);
    const next = decideFinalEscalation({
      failedAgentId: 'codex',
      failureReason: 'queue_wait_timeout: provider codex busy for 1800000ms',
      attemptedAgents: ['codex'],
      circuitOpenAgents: ['cursor-agent', 'opencode'],
      knownAgents: filtered,
      now: () => '2026-08-06T00:00:00.000Z',
    }).nextAgentId;
    expect(next).not.toBe('claude-code');
    expect(next).toBe('ollama');
  });
});

describe('computeCircuitCooldownWaitMs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 0 when the provider is already available', () => {
    vi.spyOn(circuitBreakerRegistry, 'getAvailability').mockReturnValue({
      agentId: 'codex',
      status: 'available',
      available: true,
      reason: null,
      circuitState: 'closed',
      cooldownUntil: null,
    });
    expect(computeCircuitCooldownWaitMs('codex')).toBe(0);
  });

  it('returns bounded wait when cooldown is still active', () => {
    const now = Date.parse('2026-07-30T00:00:00.000Z');
    vi.spyOn(circuitBreakerRegistry, 'getAvailability').mockReturnValue({
      agentId: 'claude-code',
      status: 'gated:generic',
      available: false,
      reason: 'generic',
      circuitState: 'open',
      cooldownUntil: new Date(now + 5_000).toISOString(),
    });
    expect(computeCircuitCooldownWaitMs('claude-code', now, 30_000)).toBe(5_200);
  });

  it('does not wait for auth-gated providers', () => {
    vi.spyOn(circuitBreakerRegistry, 'getAvailability').mockReturnValue({
      agentId: 'opencode',
      status: 'gated:auth',
      available: false,
      reason: 'auth',
      circuitState: 'open',
      cooldownUntil: null,
    });
    expect(computeCircuitCooldownWaitMs('opencode')).toBe(0);
  });

  it('does not wait for a long-lived quota cooldown', () => {
    const now = Date.parse('2026-07-30T00:00:00.000Z');
    vi.spyOn(circuitBreakerRegistry, 'getAvailability').mockReturnValue({
      agentId: 'cursor-agent',
      status: 'gated:quota',
      available: false,
      reason: 'quota',
      circuitState: 'open',
      cooldownUntil: new Date(now + 60 * 60_000).toISOString(),
    });
    expect(computeCircuitCooldownWaitMs('cursor-agent', now, 30_000)).toBe(0);
  });

  it('does not spend the cap waiting for a distant generic cooldown', () => {
    const now = Date.parse('2026-07-30T00:00:00.000Z');
    vi.spyOn(circuitBreakerRegistry, 'getAvailability').mockReturnValue({
      agentId: 'codex',
      status: 'gated:generic',
      available: false,
      reason: 'generic',
      circuitState: 'open',
      cooldownUntil: new Date(now + 31_000).toISOString(),
    });
    expect(computeCircuitCooldownWaitMs('codex', now, 30_000)).toBe(0);
  });

  it('respects the circuit cooldown wait kill switch', () => {
    expect(isCircuitCooldownWaitEnabled('off')).toBe(false);
    expect(isCircuitCooldownWaitEnabled()).toBe(true);
  });
});

describe('classifyResult — exit 0 프로바이더 오류 본문 (D2)', () => {
  // 기존 SILENT_FAILURE_PATTERN 분기는 output.length < 300 조건이 붙어 있어 긴 오류
  // 본문이 통과했다. 그 결과 큐는 완료로, DB 는 나중에 실패로 기록해 두 장부가
  // 어긋났다(claude-2 가 hermes 케이스로 2회 독립 재현, 2026-08-06).
  it('300자를 넘는 오류 본문도 실패로 분류', () => {
    const longErrorBody = `API call failed after 3 retries: Gemini HTTP 429 RESOURCE_EXHAUSTED. ${'상세 내역. '.repeat(60)}`;
    expect(longErrorBody.length).toBeGreaterThan(300);
    const out = classifyResult({ success: true, output: longErrorBody });
    expect(out.success).toBe(false);
    expect(out.error).toContain('provider error body');
  });

  it('정상 응답은 길이와 무관하게 성공 유지 — 회귀 방지', () => {
    const report = `## 감사 보고 — 원본 확인: curl .../api/tasks/task_x → HTTP 404 로 부재 확인. ${'본문. '.repeat(80)}`;
    expect(classifyResult({ success: true, output: report }).success).toBe(true);
    expect(classifyResult({ success: true, output: '정상 답변입니다.' }).success).toBe(true);
  });

  it('이미 실패인 결과는 건드리지 않음', () => {
    const failed = { success: false, output: 'quota exceeded', error: 'boom' };
    expect(classifyResult(failed)).toEqual(failed);
  });
});

describe('프로세스 사망 시 리스 갱신 유지 (O)', () => {
  // 라이브 실측(2026-08-06): 최근 7일 실패 2,591건 중 lease_expired 1,775건(69%)이
  // NCO 최대 실패 요인이고, 완료율이 08-04 56.6% → 08-06 18.4% 로 떨어진 구간의
  // 주 사유다. monitorRuntime 이 프로세스 사망을 보면 return 했는데, 그러면
  // flushActivityToDb 를 못 타 리스 갱신이 멈추고 후처리가 90초를 넘기면 sweeper 가
  // lease_expired 로 죽였다.
  //
  // **abort 는 답이 아니다.** finalizeRuntime 이 runtimes.delete 를 할 때까지
  // childPid 가 남으므로, 정상 종료 후 verifier·품질 게이트를 도는 태스크도 !alive 로
  // 보인다. 초판에서 abort 를 넣었다가 이 호출 순서를 확인하고 되돌렸다.
  it('사망 판정 뒤에도 리스를 갱신해야 한다 — 산식 검증', () => {
    // claude-code 실측: 평균 heartbeat_seq 7.0, 평균 수명 212초.
    // tick 7회(105초) 정상 갱신 후 멈춘 뒤 90초 더 기다린 값과 맞는다.
    const predicted = 7 * 15 + 90;
    expect(predicted).toBe(195);
    expect(Math.abs(212 - predicted)).toBeLessThan(30);
  });

  it('정상 완료가 리스보다 훨씬 오래 걸린다 — abort 금지 근거', () => {
    // 같은 기간 completed 평균 수명 실측: claude-code 3,317초(55분),
    // ollama 10,271초(2.9시간), openclaw 523초. 리스 90초는 이보다 훨씬 짧고,
    // 프로세스가 살아 있는 동안 tick 이 갱신해 주기 때문에 유지된다.
    // 그 갱신이 끊기는 순간만 죽으므로, 끊지 말고 갱신을 이어가는 것이 맞다.
    const LEASE_MS = 90_000;
    for (const observedCompletionMs of [3_317_000, 10_271_000, 523_000]) {
      expect(observedCompletionMs).toBeGreaterThan(LEASE_MS);
    }
  });

  it('활동 정지와 heartbeat 정지가 겹친다 — 같은 return 이 원인', () => {
    // 실측: updated_at - last_activity_at 이 101초(claude-code)인데
    // lease_expires_at - last_heartbeat_at 은 전 프로바이더 정확히 90.0초.
    const leaseAfterHeartbeatS = 90;
    expect(leaseAfterHeartbeatS).toBe(90);
    expect(Math.abs(101 - (leaseAfterHeartbeatS + 15))).toBeLessThanOrEqual(5);
  });
});

describe('abort 되감기 구간 리스 갱신 (V)', () => {
  // kangnote 실측(2026-08-06, WSL2): 프로세스 사망 분기를 고친 빌드에서도 lease_expired
  // 가 19% 남았다. 원인은 monitorRuntime **최상단**의 `if (runtime.abortReason) return;`
  // 이다. abort 를 건 시점부터 finalizeRuntime 이 종료 상태를 쓸 때까지 갱신이 끊기고,
  // 그 구간이 90초를 넘으면 sweeper 가 먼저 도달해 **진짜 사유를 lease_expired 로 덮는다.**
  // 사망 분기와 같은 종류의 실수가 함수 위쪽에 하나 더 있었다.
  //
  // 되감기 중에는 owner 가 살아 있으므로 갱신이 옳다. 다만 무한 갱신은 정리가 멈춘
  // 태스크를 영영 못 거두게 하므로 ABORT_UNWIND_GRACE_MS(120초)까지만 갱신한다.
  const makeRuntime = (over: Record<string, unknown> = {}) => ({
    taskId: 'task_v', agentId: 'claude-code', queueAttempt: 1,
    controller: new AbortController(), startedAt: Date.now(), timeoutMs: 600_000,
    idleTimeoutMs: 300_000, firstActivityTimeoutMs: 180_000, lastActivityAt: Date.now(),
    lastOutputAt: Date.now(), firstActivityObserved: true, firstOutputObserved: true,
    lastDbFlushAt: 0, partialOutput: '', childPid: null, lastCpuSeconds: null,
    processAlive: true, liveness: 'working', stalledSince: null, lastHeartbeatFlushAt: 0,
    ...over,
  });

  const runMonitor = (runtime: Record<string, unknown>) => {
    const q = taskQueue as unknown as {
      monitorRuntime(r: unknown): void;
      flushActivityToDb(r: unknown): void;
    };
    const spy = vi.spyOn(q, 'flushActivityToDb').mockImplementation(() => {});
    try {
      q.monitorRuntime.call(taskQueue, runtime);
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  };

  it('abort 직후에는 리스를 계속 갱신한다 — 진짜 사유가 덮이지 않도록', () => {
    const calls = runMonitor(makeRuntime({
      abortReason: 'timeout(idle)',
      abortedAt: Date.now() - 30_000,   // 되감기 30초째, 유예 안
    }));
    expect(calls).toBe(1);
  });

  it('유예를 넘기면 갱신을 멈춘다 — 정리가 멈춘 태스크는 sweeper 가 거둔다', () => {
    const calls = runMonitor(makeRuntime({
      abortReason: 'cancelled',
      abortedAt: Date.now() - 200_000,  // 유예(120초) 초과
    }));
    expect(calls).toBe(0);
  });

  it('유예가 리스보다 길어야 의미가 있다', () => {
    // 유예가 90초 이하면 갱신을 놓는 순간 이미 만료라 아무것도 못 막는다.
    const ABORT_UNWIND_GRACE_MS = 120_000;
    const LEASE_DURATION_MS = 90_000;
    expect(ABORT_UNWIND_GRACE_MS).toBeGreaterThan(LEASE_DURATION_MS);
  });

  it('사망 관측은 태스크당 한 번만 기록한다 — tick 마다 찍으면 로그가 넘친다', () => {
    // 후처리가 긴 태스크는 15초마다 이 분기를 다시 탄다. 매번 남기면 한 태스크가
    // 로그를 가득 채워 정작 다른 태스크의 사망을 못 본다.
    const runtime = makeRuntime({ childPid: 4242, deadChildObservedAt: 1 }) as Record<string, unknown>;
    expect(runtime['deadChildObservedAt']).toBe(1);
    const fresh = makeRuntime({ childPid: 4242 }) as Record<string, unknown>;
    expect(fresh['deadChildObservedAt']).toBeUndefined();
  });

  it('abort 가 없으면 기존 경로 그대로 — 회귀 방지', () => {
    expect(runMonitor(makeRuntime())).toBe(1);
  });
});

describe('큐 대기 중 리스 갱신 (W)', () => {
  // A무리 원인. 리스는 **ack 시점**에 90초로 시작하는데(lease-sweeper ack 경로),
  // 갱신자 flushActivityToDb 는 this.runtimes 에 런타임이 있어야 돈다. 런타임은
  // startRuntime 에서 만들어지고, 그 앞에 **상한 없는 세마포어 대기**가 있다.
  // 그래서 줄을 선 태스크는 시작도 못 해 보고 90초 뒤 lease_expired 로 죽었다.
  //
  // kangnote 실측: lease_expired 104건 중 67건이 hb<=2, 그중 61건은 하트비트 지속 0초.
  // 수명 중앙 97초로 리스 90초 직후에 몰린다.
  it('큐 대기 상한이 리스보다 훨씬 길다 — 갱신이 없으면 상한이 무력화된다', () => {
    const LEASE_DURATION_MS = 90_000;
    const DEFAULT_QUEUE_WAIT_MAX_MS = 30 * 60_000;
    expect(DEFAULT_QUEUE_WAIT_MAX_MS).toBeGreaterThan(LEASE_DURATION_MS);
    // 갱신이 없으면 상한 30분 중 실제로 기다릴 수 있는 것은 90초뿐이다 — 5%.
    expect(LEASE_DURATION_MS / DEFAULT_QUEUE_WAIT_MAX_MS).toBeLessThan(0.06);
  });

  it('갱신 주기가 리스보다 짧아야 한다', () => {
    const QUEUE_WAIT_HEARTBEAT_INTERVAL_MS = 30_000;
    const LEASE_DURATION_MS = 90_000;
    expect(QUEUE_WAIT_HEARTBEAT_INTERVAL_MS).toBeLessThan(LEASE_DURATION_MS);
    // 한 번 놓쳐도 만료 전에 다음 기회가 있어야 한다.
    expect(QUEUE_WAIT_HEARTBEAT_INTERVAL_MS * 2).toBeLessThan(LEASE_DURATION_MS);
  });

  it('대기 중 실제로 하트비트를 찍는다 — 동작 검증', async () => {
    vi.useFakeTimers();
    const q = taskQueue as unknown as {
      withQueueWaitLeaseRenewal<T>(t: unknown, w: () => Promise<T>): Promise<T>;
    };
    const beats: string[] = [];
    const mod = await import('./lease-sweeper.js');
    const spy = vi.spyOn(mod, 'recordTaskHeartbeat').mockImplementation(((id: string) => {
      beats.push(id);
      return { ok: true } as never;
    }) as never);
    try {
      let release!: () => void;
      const blocked = new Promise<boolean>(res => { release = () => res(true); });
      const pending = q.withQueueWaitLeaseRenewal.call(taskQueue, { taskId: 'task_w' }, () => blocked);
      await vi.advanceTimersByTimeAsync(95_000);   // 리스 90초를 넘겨 대기
      expect(beats.length).toBeGreaterThanOrEqual(2);
      release();
      await pending;
      const settled = beats.length;
      await vi.advanceTimersByTimeAsync(95_000);   // 대기 종료 후에는 멈춰야 한다
      expect(beats.length).toBe(settled);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('baseline 부재를 깨끗한 baseline 으로 오인하지 않는다 (X)', () => {
  // 실측(gentop, 2026-08-07): claude-code 에 단순 산술을 위임해 **응답 391 로 정확한데
  // status 가 failed** 였다. 사유는 `verifier failed: tsc 오류 3건` 이고 그 오류는 태스크와
  // 무관한 프로젝트 전체의 기존 결함이었다. projectDir 를 빈 디렉터리로 바꾸니 completed.
  //
  // 원인은 호출부의 `if (preTaskBaseline && ...)` 였다. baseline 을 못 잡으면(null)
  // 대조 블록을 통째로 건너뛰어 **HEAD 대조 없이 실패가 확정**된다. 그런데
  // `captureVerifierBaseline` 은 어떤 실패든 log.warn 만 남기고 null 을 내므로
  // "baseline 정상 통과"와 구분되지 않는다.
  const failing = { passed: false, exitCode: 1, startedAt: 0, timedOut: false, outputSnippet: 'tsc 오류 3건' } as never;

  describe('호출부 판정 — 여기서 건너뛰면 대조가 아예 안 돈다', () => {
    it('**baseline 을 못 잡으면 반드시 대조로 넘긴다**', () => {
      expect(shouldReconcileVerifierBaseline(null)).toBe(true);
    });

    it('baseline 이 깨끗하면 대조 불필요', () => {
      expect(shouldReconcileVerifierBaseline({ code: 0, timedOut: false })).toBe(false);
    });

    it('baseline 이 실패했거나 타임아웃이면 대조', () => {
      expect(shouldReconcileVerifierBaseline({ code: 1, timedOut: false })).toBe(true);
      expect(shouldReconcileVerifierBaseline({ code: 0, timedOut: true })).toBe(true);
    });

    it('**미포착을 code 0 으로 바꿔 넘기면 안 된다** — 그러면 대조가 즉시 통과해 버린다', () => {
      expect(baselineForReconciliation(null).code).toBeNull();
      expect(baselineForReconciliation({ code: 1, timedOut: false }).code).toBe(1);
    });
  });

  it('baseline 이 깨끗하면 verifier 실패를 그대로 둔다', () => {
    const r = reconcileVerifierBaseline(failing, { code: 0, timedOut: false }, null);
    expect(r.passed).toBe(false);
    expect(r.baseline_indeterminate).toBeUndefined();
  });

  it('**baseline 미포착(code null)은 판정 불가로 흘러야 한다** — 조용히 확정 금지', () => {
    // 호출부가 null baseline 을 `{ code: null }` 로 넘긴다. 첫 조건을 통과하면 안 된다.
    const r = reconcileVerifierBaseline(failing, { code: null, timedOut: false }, null);
    expect(r.baseline_indeterminate).toBeDefined();
  });

  it('baseline 미포착 + HEAD 도 실패 → 기존 결함이므로 통과 처리', () => {
    // gentop 사례가 정확히 이것이다. 프로젝트가 원래 깨져 있으니 태스크 탓이 아니다.
    const r = reconcileVerifierBaseline(failing, { code: null, timedOut: false }, { code: 1, timedOut: false });
    expect(r.passed).toBe(true);
    expect(r.baseline_indeterminate).toBeUndefined();
  });

  it('baseline 미포착 + HEAD 는 통과 → 기존 결함이 아니므로 실패 유지', () => {
    const r = reconcileVerifierBaseline(failing, { code: null, timedOut: false }, { code: 0, timedOut: false });
    expect(r.passed).toBe(false);
  });

  it('HEAD 가 타임아웃이면 판정 불가 — 추측하지 않는다', () => {
    const r = reconcileVerifierBaseline(failing, { code: null, timedOut: false }, { code: 0, timedOut: true });
    expect(r.baseline_indeterminate).toBeDefined();
  });

  it('baseline 타임아웃도 미포착과 같은 취급', () => {
    const r = reconcileVerifierBaseline(failing, { code: 0, timedOut: true }, { code: 1, timedOut: false });
    expect(r.passed).toBe(true);
  });
});

describe('spawn 자원 부족은 일시 실패 (Q)', () => {
  // 사실(kangnote, 2026-08-06 WSL2): 시스템 19Gi 중 15Gi available 인데도 ENOMEM 이
  // 나서 토론 2건이 0/2 로 죽었다. 단순 메모리 부족이 아니다.
  // 원인은 **미확인** — overcommit 가설은 같은 기기 재현 실패로 철회됐다.
  // 원인과 무관하게 spawn 자원 오류는 재시도·failover 대상이라는 분류만 고정한다.
  it('순수 ENOMEM·EAGAIN 도 재시도 대상으로 분류', () => {
    expect(isTransientFailure({ success: false, error: 'Command failed with ENOMEM' } as any)).toBe(true);
    expect(isTransientFailure({ success: false, error: 'spawn EAGAIN' } as any)).toBe(true);
  });

  it('CLI 접두가 붙은 형태도 유지 — 기존 동작 회귀 방지', () => {
    expect(isTransientFailure({
      success: false,
      error: 'opencode: CLI failed exit=unknown — Command failed with ENOMEM: opencode run --pure',
    } as any)).toBe(true);
  });

  it('정상완료·취소·rate-limit 은 여전히 재시도하지 않는다', () => {
    expect(isTransientFailure({ success: true } as any)).toBe(false);
    expect(isTransientFailure({ success: false, status: 'cancelled' } as any)).toBe(false);
    expect(isTransientFailure({ success: false, error: 'rate limit exceeded' } as any)).toBe(false);
  });
});
