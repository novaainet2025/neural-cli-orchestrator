import { describe, it, expect } from 'vitest';
import { findMax } from './findMax.js';

describe('findMax', () => {
  it('빈 배열은 undefined', () => {
    expect(findMax([])).toBeUndefined();
  });

  it('단일 원소는 그 값', () => {
    expect(findMax([42])).toBe(42);
  });

  it('최댓값을 찾는다 — 위치 무관', () => {
    expect(findMax([1, 9, 3])).toBe(9);
    expect(findMax([9, 1, 3])).toBe(9);
    expect(findMax([1, 3, 9])).toBe(9);
  });

  it('전부 음수여도 최댓값을 낸다 — 0 초기화 버그 방지', () => {
    expect(findMax([-5, -1, -9])).toBe(-1);
  });

  it('중복 최댓값도 그 값', () => {
    expect(findMax([2, 7, 7])).toBe(7);
  });

  it('NaN 이 있으면 NaN 으로 오염된다 — 현재 동작 고정', () => {
    // Math.max 는 NaN 을 전파한다. 방어 로직이 없다는 사실을 기록해 둔다.
    expect(findMax([1, NaN, 3])).toBeNaN();
  });

  it('Infinity 를 다룬다', () => {
    expect(findMax([1, Infinity])).toBe(Infinity);
    expect(findMax([-Infinity, -1])).toBe(-1);
  });

  it('입력을 변형하지 않는다', () => {
    const input = [3, 1, 2];
    findMax(input);
    expect(input).toEqual([3, 1, 2]);
  });
});
