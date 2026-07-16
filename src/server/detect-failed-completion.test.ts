import { describe, expect, it } from 'vitest';
import { detectFailedCompletion } from './gateway.js';

/**
 * detectFailedCompletion 회귀 테스트 (2026-07-16).
 * 실데이터 근거: 2일간 failure-pattern 마킹 7건 중 4건이 'done:'로 시작하는 오탐이었다
 * (보안·에러핸들링 태스크의 정상 응답에 401/403/'usage limit'/'error:' 어휘가 필연 등장).
 * 아래 케이스는 그 실데이터 형태를 반영한다.
 */
describe('detectFailedCompletion', () => {
  it('done: 성공 프로토콜은 본문에 에러 어휘가 있어도 실패로 보지 않는다 (오탐 방지)', () => {
    expect(detectFailedCompletion(
      "done: [Evidence Tier 1] 401/403 unauthorized 처리와 usage limit 가드를 구현했습니다. error: 케이스 전부 커버.",
    )).toBe(false);
    expect(detectFailedCompletion(
      'done: `src/doctor.ts` 연결 진단을 원인별로 세분화. timeout/refused/exceeded 각각 분기.',
    )).toBe(false);
  });

  it('error: 실패 프로토콜과 원시 에러는 실패로 판정한다 (진짜 실패 유지)', () => {
    expect(detectFailedCompletion('error: 전체 Vitest 검증 기준을 충족하지 못했습니다.')).toBe(true);
    expect(detectFailedCompletion('error: Unsupported shell metacharacter in command')).toBe(true);
    expect(detectFailedCompletion('Error: connection refused')).toBe(true);
  });

  it('소스코드/상태 브리프 에코 라인은 실패 신호로 보지 않는다 (에코-FP 방어)', () => {
    expect(detectFailedCompletion(
      "변경 요약\nconst QUOTA_RE = /usage limit|quota exceeded/i;\n적용 완료",
    )).toBe(false);
  });

  it('빈 응답은 실패가 아니다', () => {
    expect(detectFailedCompletion('')).toBe(false);
    expect(detectFailedCompletion(null)).toBe(false);
  });
});
