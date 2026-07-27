import { afterEach, describe, expect, it } from 'vitest';
import {
  mergeMemoryContextEntries,
  resolveTeamMemoryScope,
  type MemoryContextEntry,
} from './task-memory-scope.js';

describe('resolveTeamMemoryScope', () => {
  afterEach(() => {
    delete process.env.NCO_TEAM_MEMORY_SCOPE;
  });

  it('creates a stable shared namespace for a valid team id', () => {
    expect(resolveTeamMemoryScope('team_gov-evolution-learning'))
      .toBe('team:team_gov-evolution-learning');
  });

  it('supports an immediate environment rollback', () => {
    process.env.NCO_TEAM_MEMORY_SCOPE = 'off';
    expect(resolveTeamMemoryScope('team_gov-evolution-learning')).toBeNull();
  });

  it('does not create a filesystem-backed scope from unsafe or missing ids', () => {
    expect(resolveTeamMemoryScope(null)).toBeNull();
    expect(resolveTeamMemoryScope('../team')).toBeNull();
    expect(resolveTeamMemoryScope('team/name')).toBeNull();
  });
});

describe('mergeMemoryContextEntries', () => {
  const entry = (
    id: string,
    content: string,
    score: number,
  ): MemoryContextEntry => ({ id, content, score, semantic: false });

  it('deduplicates personal and team memory content and keeps the stronger hit', () => {
    const personal = [
      entry('personal-duplicate', 'same lesson', 0.4),
      entry('personal-only', 'personal lesson', 0.7),
    ];
    const team = [
      entry('team-duplicate', 'same   lesson', 0.9),
      entry('team-only', 'team lesson', 0.8),
    ];

    expect(mergeMemoryContextEntries([personal, team], 5).map(item => item.id))
      .toEqual(['team-duplicate', 'team-only', 'personal-only']);
  });

  it('sorts by score and enforces the combined context limit', () => {
    expect(mergeMemoryContextEntries([
      [entry('low', 'low', 0.1)],
      [entry('high', 'high', 0.9), entry('mid', 'mid', 0.5)],
    ], 2).map(item => item.id)).toEqual(['high', 'mid']);
  });
});
