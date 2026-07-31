import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  allowGenericProviderFailover,
  computeCircuitCooldownWaitMs,
  filterEvolutionSkillsEscalationAgents,
  filterRecoveryCheckpointEscalationAgents,
  isCircuitCooldownWaitEnabled,
  isEvolutionLearningRecoverableFailure,
  isTransientFailure,
} from './task-queue.js';
import { decideFinalEscalation } from './task-escalation.js';
import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';

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
  it('명시적 false는 팀 밖 generic escalation을 차단', () => {
    expect(allowGenericProviderFailover({ allowProviderFailover: false })).toBe(false);
  });

  it('true 및 필드가 없는 기존 태스크는 기존 동작을 유지', () => {
    expect(allowGenericProviderFailover({ allowProviderFailover: true })).toBe(true);
    expect(allowGenericProviderFailover({})).toBe(true);
    expect(allowGenericProviderFailover(undefined)).toBe(true);
  });

  it('model이 비어있지 않으면 allowProviderFailover 여부와 무관하게 false', () => {
    expect(allowGenericProviderFailover({ model: 'qwen3:30b-a3b' })).toBe(false);
    expect(allowGenericProviderFailover({ model: 'qwen3:30b-a3b', allowProviderFailover: true })).toBe(false);
    expect(allowGenericProviderFailover({ model: 'qwen3:30b-a3b', allowProviderFailover: false })).toBe(false);
  });

  it('model이 빈 문자열이면 기존 동작 유지', () => {
    expect(allowGenericProviderFailover({ model: '' })).toBe(true);
    expect(allowGenericProviderFailover({ model: '', allowProviderFailover: false })).toBe(false);
  });

  it('model이 undefined이면 기존 동작 유지', () => {
    expect(allowGenericProviderFailover({ allowProviderFailover: true })).toBe(true);
    expect(allowGenericProviderFailover({})).toBe(true);
    expect(allowGenericProviderFailover(undefined)).toBe(true);
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

  it('respects the circuit cooldown wait kill switch', () => {
    expect(isCircuitCooldownWaitEnabled('off')).toBe(false);
    expect(isCircuitCooldownWaitEnabled()).toBe(true);
  });
});
