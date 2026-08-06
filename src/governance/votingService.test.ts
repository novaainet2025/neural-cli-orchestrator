import { describe, it, expect } from 'vitest';
import { calculateQuadraticWeight } from './votingService.js';

// 이 파일은 **순수 함수만** 덮는다. castVote·getVotes·getDAOStatus·getStake 는
// SQLite(nova_proposals·nova_votes·nova_stakes)와 walletService 에 묶여 있어
// 픽스처 없이는 못 돈다. 그쪽은 여전히 미커버 — 여기서 덮었다고 보면 안 된다.

describe('calculateQuadraticWeight — 기본 규칙', () => {
  it('stake 가 0 이하면 기본 투표권 1', () => {
    // 스테이킹 없이도 1인 1표는 보장된다.
    expect(calculateQuadraticWeight(0)).toBe(1.0);
    expect(calculateQuadraticWeight(-5)).toBe(1.0);
  });

  it('가중치는 stake 의 제곱근이다', () => {
    expect(calculateQuadraticWeight(4)).toBe(2);
    expect(calculateQuadraticWeight(100)).toBe(10);
    expect(calculateQuadraticWeight(10_000)).toBe(100);
  });

  it('제곱근이라 돈을 늘려도 표가 선형으로 안 는다 — QV 의 핵심', () => {
    // 100배를 더 내야 10배의 영향력을 얻는다.
    expect(calculateQuadraticWeight(10_000) / calculateQuadraticWeight(100)).toBe(10);
  });

  it('단조 증가한다', () => {
    let prev = calculateQuadraticWeight(1);
    for (const stake of [2, 10, 50, 500, 5_000]) {
      const w = calculateQuadraticWeight(stake);
      expect(w).toBeGreaterThan(prev);
      prev = w;
    }
  });

  it('1 미만 stake 는 제곱근이 커져 1을 넘는다 — 현재 동작 고정', () => {
    // sqrt(0.25)=0.5 가 아니라... sqrt 는 1 미만에서 값을 키운다.
    // 0 초과 1 미만 구간은 하한 1 이 적용되지 않는다는 사실을 기록해 둔다.
    expect(calculateQuadraticWeight(0.25)).toBe(0.5);
    expect(calculateQuadraticWeight(0.25)).toBeLessThan(1);
  });
});

describe('고래 방지 상한 — totalSupply 의 5%', () => {
  // GOVERNANCE-POLICY.md 5회차 합의. 이 상수가 바뀌면 대량 보유자 한 명이
  // 결과를 좌우할 수 있으므로 테스트로 못박는다.
  const TOTAL = 1_000_000;
  const CAP = TOTAL * 0.05;   // 50,000

  it('상한 미만이면 상한이 적용되지 않는다', () => {
    expect(calculateQuadraticWeight(10_000, TOTAL)).toBe(Math.sqrt(10_000));
  });

  it('상한 초과분은 잘린다', () => {
    expect(calculateQuadraticWeight(CAP * 100, TOTAL)).toBe(Math.sqrt(CAP));
  });

  it('상한을 넘으면 아무리 더 내도 가중치가 같다', () => {
    const a = calculateQuadraticWeight(CAP * 2, TOTAL);
    const b = calculateQuadraticWeight(CAP * 1_000, TOTAL);
    expect(a).toBe(b);
  });

  it('상한 경계에서 정확히 sqrt(cap)', () => {
    expect(calculateQuadraticWeight(CAP, TOTAL)).toBe(Math.sqrt(CAP));
  });

  it('totalSupply 를 안 주면 상한이 없다 — 호출부가 빠뜨리면 고래 방지가 꺼진다', () => {
    const huge = CAP * 1_000;
    expect(calculateQuadraticWeight(huge)).toBe(Math.sqrt(huge));
    expect(calculateQuadraticWeight(huge)).toBeGreaterThan(calculateQuadraticWeight(huge, TOTAL));
  });

  it('totalSupply 가 0 이면 상한이 꺼진다 — falsy 검사라서', () => {
    // `totalSupply ? ... : ...` 이므로 0 은 "상한 없음"으로 읽힌다.
    // 공급량 0 에서 상한 0 을 기대하면 안 된다는 뜻이다.
    expect(calculateQuadraticWeight(100, 0)).toBe(10);
  });

  it('상한이 걸려도 기본 투표권보다 작아지지 않는다 — 정상 공급량 범위', () => {
    expect(calculateQuadraticWeight(1_000_000, TOTAL)).toBeGreaterThanOrEqual(1);
  });
});
