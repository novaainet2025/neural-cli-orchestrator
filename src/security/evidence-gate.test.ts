import { describe, expect, it } from 'vitest';
import {
  assertPhaseComplete,
  EvidenceGateError,
  parseEvidence,
  requireEvidence,
} from './evidence-gate.js';

describe('requireEvidence', () => {
  it('allows completion when every required kind is present and non-blank', () => {
    const evidence = { review: 'ok', tests: '5/5 pass', build: 'tsc 0 errors' };
    const result = requireEvidence(evidence, ['review', 'tests', 'build']);
    expect(result).toEqual({ allowed: true, missing: [] });
  });

  it('blocks and lists kinds that are absent or blank/whitespace', () => {
    const evidence = { review: 'ok', tests: '   ', build: '' };
    const result = requireEvidence(evidence, ['review', 'tests', 'build']);
    expect(result.allowed).toBe(false);
    // `tests` blank, `build` empty => both missing, deterministic order.
    expect(result.missing).toEqual(['tests', 'build']);
  });

  it('accepts evidence supplied as a JSON string', () => {
    const json = JSON.stringify({ review: 'ok', tests: 'green' });
    expect(requireEvidence(json, ['review', 'tests'])).toEqual({
      allowed: true,
      missing: [],
    });
  });

  it('treats malformed JSON as empty evidence => blocks everything', () => {
    const result = requireEvidence('{not valid json', ['review']);
    expect(result).toEqual({ allowed: false, missing: ['review'] });
  });

  it('treats null / undefined / non-object JSON as empty evidence', () => {
    expect(requireEvidence(null, ['review']).allowed).toBe(false);
    expect(requireEvidence(undefined, ['review']).allowed).toBe(false);
    expect(requireEvidence('[1,2,3]', ['review']).allowed).toBe(false);
    expect(requireEvidence('42', ['review']).allowed).toBe(false);
  });

  it('normalizes required kinds: trims, de-dupes, and ignores blanks', () => {
    const evidence = { review: 'ok' };
    const result = requireEvidence(evidence, [' review ', 'review', '', '   ']);
    expect(result).toEqual({ allowed: true, missing: [] });
  });

  it('allows when there are no required kinds', () => {
    expect(requireEvidence({}, [])).toEqual({ allowed: true, missing: [] });
  });
});

describe('assertPhaseComplete', () => {
  it('does not throw when all required evidence is present', () => {
    expect(() =>
      assertPhaseComplete('task-1', { review: 'ok', tests: 'green' }, ['review', 'tests']),
    ).not.toThrow();
  });

  it('throws EvidenceGateError carrying taskId and missing kinds', () => {
    let caught: unknown;
    try {
      assertPhaseComplete('task-42', { review: 'ok' }, ['review', 'tests', 'build']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EvidenceGateError);
    const error = caught as EvidenceGateError;
    expect(error.taskId).toBe('task-42');
    expect(error.missing).toEqual(['tests', 'build']);
    expect(error.message).toContain('task-42');
    expect(error.message).toContain('tests');
    expect(error.message).toContain('build');
  });

  it('blocks phase completion when evidence JSON is malformed', () => {
    expect(() => assertPhaseComplete('task-7', '{broken', ['build'])).toThrow(
      EvidenceGateError,
    );
  });
});

describe('parseEvidence', () => {
  it('returns the object for valid inputs and {} for invalid ones', () => {
    expect(parseEvidence({ a: '1' })).toEqual({ a: '1' });
    expect(parseEvidence('{"a":"1"}')).toEqual({ a: '1' });
    expect(parseEvidence('nope')).toEqual({});
    expect(parseEvidence(null)).toEqual({});
    expect(parseEvidence('  ')).toEqual({});
  });
});
