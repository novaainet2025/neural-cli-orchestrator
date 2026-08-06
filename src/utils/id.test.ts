import { describe, it, expect } from 'vitest';
import {
  createId,
  createTaskId,
  createSessionId,
  createArtifactId,
  createMessageId,
  createEventId,
  createSubagentRunId,
} from './id.js';

describe('createId', () => {
  it('접두사가 없으면 16자 nanoid 만 낸다', () => {
    const id = createId();
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it('접두사가 있으면 `<prefix>_<16자>` 형태다', () => {
    const id = createId('task');
    expect(id.startsWith('task_')).toBe(true);
    expect(id.slice('task_'.length)).toHaveLength(16);
  });

  it('**본문에 `_` 가 들어갈 수 있다** — 접두사 파싱은 첫 `_` 로만 잘라야 한다', () => {
    // nanoid 기본 알파벳은 `A-Za-z0-9_-` 라 무작위 본문에 `_` 가 섞인다.
    // `id.split('_')` 로 뒤쪽을 쓰거나 `_` 개수를 세는 파싱은 조용히 깨진다.
    const withUnderscore = Array.from({ length: 400 }, () => createId('task'))
      .filter(id => id.slice('task_'.length).includes('_'));
    expect(withUnderscore.length).toBeGreaterThan(0);
    for (const id of withUnderscore) {
      expect(id.slice(0, id.indexOf('_'))).toBe('task');
      expect(id.slice(id.indexOf('_') + 1)).toHaveLength(16);
    }
  });

  it('충돌하지 않는다 — 1,000개 전부 고유', () => {
    const ids = new Set(Array.from({ length: 1_000 }, () => createId()));
    expect(ids.size).toBe(1_000);
  });

  it('빈 문자열 접두사는 접두사 없음으로 취급한다', () => {
    // `prefix ? ... : ...` 라서 '' 는 falsy — 구분자만 남는 `_xxx` 가 되지 않는다.
    expect(createId('')).toHaveLength(16);
  });
});

describe('도메인별 id 생성기', () => {
  // 이 접두사들은 DB 행·API 응답·로그에서 종류를 식별하는 데 쓰인다.
  // 바뀌면 기존 데이터와 대조가 깨지므로 고정해 둔다.
  it.each([
    ['task', createTaskId],
    ['sess', createSessionId],
    ['art', createArtifactId],
    ['msg', createMessageId],
    ['evt', createEventId],
    ['sbr', createSubagentRunId],
  ] as const)('%s 접두사를 붙인다', (prefix, make) => {
    const id = make();
    expect(id.startsWith(`${prefix}_`)).toBe(true);
    expect(id.slice(prefix.length + 1)).toHaveLength(16);
  });

  it('접두사가 서로 겹치지 않는다', () => {
    const prefixes = [
      createTaskId(), createSessionId(), createArtifactId(),
      createMessageId(), createEventId(), createSubagentRunId(),
    ].map(id => id.split('_')[0]);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
