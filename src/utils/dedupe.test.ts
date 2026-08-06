import { describe, it, expect } from 'vitest';
import { deduplicate, deduplicateByKey } from './dedupe.js';
import { removeDuplicates, uniq } from './arrayUtils.js';
import { dedupe } from './unique.js';

describe('deduplicate', () => {
  it('중복을 제거하고 첫 등장 순서를 유지한다', () => {
    expect(deduplicate([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
  });

  it('빈 배열은 빈 배열', () => {
    expect(deduplicate([])).toEqual([]);
  });

  it('입력을 변형하지 않는다', () => {
    const input = [1, 1, 2];
    const out = deduplicate(input);
    expect(input).toEqual([1, 1, 2]);
    expect(out).not.toBe(input);
  });

  it('Set 동일성을 쓴다 — 객체는 참조로 구분된다', () => {
    const shared = { id: 1 };
    expect(deduplicate([shared, shared, { id: 1 }])).toHaveLength(2);
  });

  it('NaN 은 하나로 접힌다 — SameValueZero', () => {
    // Set 은 SameValueZero 라 NaN 을 같은 값으로 본다. `===` 기반 구현과 다르므로 고정한다.
    expect(deduplicate([NaN, NaN])).toEqual([NaN]);
  });

  it('+0 과 -0 도 하나로 접힌다', () => {
    expect(deduplicate([0, -0])).toHaveLength(1);
  });
});

describe('deduplicateByKey', () => {
  it('키가 같으면 첫 항목만 남긴다', () => {
    const rows = [
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
      { id: 'a', v: 3 },
    ];
    expect(deduplicateByKey(rows, r => r.id)).toEqual([
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
    ]);
  });

  it('나중 항목이 아니라 **앞선** 항목이 이긴다', () => {
    const out = deduplicateByKey([{ k: 1, tag: 'first' }, { k: 1, tag: 'second' }], r => r.k);
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe('first');
  });

  it('빈 배열은 빈 배열', () => {
    expect(deduplicateByKey([], (r: unknown) => r)).toEqual([]);
  });

  it('undefined 키도 하나의 키로 취급한다', () => {
    const rows = [{ id: undefined }, { id: undefined }, { id: 'x' }];
    expect(deduplicateByKey(rows, r => r.id)).toHaveLength(2);
  });
});

describe('별칭 재수출 (arrayUtils · unique)', () => {
  // 세 이름이 같은 구현을 가리킨다. 하나가 갈라지면 호출부가 조용히 달라지므로 묶어 둔다.
  it('removeDuplicates · uniq · dedupe 는 deduplicate 와 동일하다', () => {
    expect(removeDuplicates).toBe(deduplicate);
    expect(uniq).toBe(deduplicate);
    expect(dedupe).toBe(deduplicate);
  });
});
