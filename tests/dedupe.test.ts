import { describe, it, expect } from 'vitest';
import { deduplicate, deduplicateByKey } from '../src/utils/dedupe.js';

describe('deduplicate utility', () => {
  it('숫자 배열에서 중복을 제거해야 함', () => {
    expect(deduplicate([1, 2, 2, 3, 4, 4, 5])).toEqual([1, 2, 3, 4, 5]);
  });

  it('문자열 배열에서 중복을 제거해야 함', () => {
    expect(deduplicate(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('빈 배열에 대해 빈 배열을 반환해야 함', () => {
    expect(deduplicate([])).toEqual([]);
  });
});

describe('deduplicateByKey utility', () => {
  it('ID 키를 기준으로 객체 중복을 제거해야 함', () => {
    const users = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
      { id: 1, name: 'Alice duplicated' },
      { id: 3, name: 'Charlie' },
    ];
    const result = deduplicateByKey(users, (u) => u.id);
    expect(result).toHaveLength(3);
    expect(result).toEqual([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
      { id: 3, name: 'Charlie' },
    ]);
  });
});
