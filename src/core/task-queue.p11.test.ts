import { describe, it, expect } from 'vitest';
import { isTransientFailure } from './task-queue.js';

// P11: transient(프로바이더 무응답/idle/abort)만 재시도 대상. 정상완료·취소·rate-limit 제외.
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
  it('rate-limit → false (기존 backoff 경로가 처리)', () => {
    expect(isTransientFailure({ success: false, error: 'rate limit exceeded' } as any)).toBe(false);
  });
});
