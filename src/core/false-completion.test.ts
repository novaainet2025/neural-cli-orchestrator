import { describe, expect, it } from 'vitest';
import { buildFalseCompletionExclusion, isFalseCompletion } from './false-completion.js';

describe('false completion classification', () => {
  it('flags completed tasks with promptGate score 0 and no enrichment', () => {
    expect(isFalseCompletion({
      promptGate: {
        score: 0,
        missing: ['컨텍스트', '목표', '제약', '출력형식', '검증기준'],
      },
    }, 'completed')).toBe(true);
  });

  it('does not flag enriched completions that started from score 0', () => {
    expect(isFalseCompletion({
      promptGate: {
        score: 0,
        enriched: true,
        missing: ['컨텍스트', '목표', '제약', '출력형식', '검증기준'],
      },
    }, 'completed')).toBe(false);
  });

  it('does not flag non-completed tasks', () => {
    expect(isFalseCompletion({
      promptGate: { score: 0 },
    }, 'failed')).toBe(false);
  });

  it('builds scorer exclusion SQL by default', () => {
    expect(buildFalseCompletionExclusion()).toContain('promptGate.score');
    expect(buildFalseCompletionExclusion('off')).toBe('');
  });
});
