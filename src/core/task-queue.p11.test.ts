import { describe, it, expect } from 'vitest';
import {
  isEvolutionLearningRecoverableFailure,
  isTransientFailure,
} from './task-queue.js';

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
