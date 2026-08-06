import { describe, it, expect } from 'vitest';
import { classifyTaskFailureForCircuit } from './task-failure-circuit.js';

describe('classifyTaskFailureForCircuit', () => {
  describe('프로바이더급 실패는 서킷에 반영한다', () => {
    // 실측(gentop 2026-08-07): hermes 가 이 오류를 뱉는데 서킷이 closed 로 남아
    // 349건이 계속 배정됐고 완료는 0건이었다.
    it('Gemini 429 RESOURCE_EXHAUSTED', () => {
      const signal = classifyTaskFailureForCircuit({
        error: '[429 Too Many Requests] RESOURCE_EXHAUSTED: Quota exceeded for quota metric',
      });
      expect(signal).not.toBeNull();
      expect(['quota', 'rate-limit']).toContain(signal!.reason);
    });

    it.each([
      'quota exceeded',
      'Rate limit exhausted after 3 retries',
      '429 Too Many Requests',
    ])('%s', (error) => {
      expect(classifyTaskFailureForCircuit({ error })).not.toBeNull();
    });
  });

  describe('exit 0 으로 오류 본문만 오는 경우도 잡는다', () => {
    // `silent-failure: provider error body (exit 0)` 계열. error 는 비고 output 에만
    // 오류가 실린다 — error 만 보면 통째로 놓친다.
    it('output 쪽에 있어도 찾는다', () => {
      const signal = classifyTaskFailureForCircuit({
        error: null,
        output: 'Error: 429 RESOURCE_EXHAUSTED — quota exceeded for this project',
      });
      expect(signal).not.toBeNull();
    });
  });

  describe('태스크 고유 실패는 반영하지 않는다 — 멀쩡한 프로바이더를 죽이면 안 된다', () => {
    it.each([
      ['일반 오류', 'Error: something went wrong in the task'],
      ['타입 오류', 'tsc: 3 errors found'],
      ['검증 실패', 'verifier failed: exit 1'],
      ['리스 만료', 'lease_expired_twice'],
      ['빈 응답', "empty completion from provider 'ollama' after 4 iteration(s)"],
    ])('%s', (_label, error) => {
      expect(classifyTaskFailureForCircuit({ error })).toBeNull();
    });

    it('generic 분류는 제외한다 — 프로브가 판단할 몫이다', () => {
      // 태스크 하나가 알 수 없는 이유로 죽은 것과 프로바이더 고장을 구분할 수 없다.
      expect(classifyTaskFailureForCircuit({ error: 'unexpected failure' })).toBeNull();
    });
  });

  describe('빈 입력', () => {
    it.each([
      {},
      { error: null, output: null },
      { error: '', output: '' },
      { error: '   ' },
    ])('던지지 않고 null 을 낸다: %j', (failure) => {
      expect(classifyTaskFailureForCircuit(failure)).toBeNull();
    });
  });

  it('error 를 output 보다 먼저 본다', () => {
    const signal = classifyTaskFailureForCircuit({
      error: 'quota exceeded',
      output: 'unrelated text',
    });
    expect(signal!.matchedText.toLowerCase()).toContain('quota');
  });
});
