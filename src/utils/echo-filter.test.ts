import { describe, expect, it } from 'vitest';
import { ECHO_LINE_RE, stripEchoLines } from './echo-filter.js';

describe('echo-filter', () => {
  it('flags source-code echo lines (오탐 5호 재현 케이스)', () => {
    // 실제 오탐을 유발했던 에코 라인들 (pm2 로그 T1 발췌)
    expect(ECHO_LINE_RE.test(
      "const SILENT_FAILURE_PATTERN = /usage limit|rate limit exceeded|quota exceeded/i;",
    )).toBe(true);
    expect(ECHO_LINE_RE.test('- copilot   sr=79% gate=probe(monthly quota exceeded)')).toBe(true);
    expect(ECHO_LINE_RE.test('src/agent/orchestrated-loop.ts:376:      const _quotaSelfRe = /you/')).toBe(true);
  });

  it('does not flag genuine provider error lines', () => {
    expect(ECHO_LINE_RE.test("You've hit your usage limit. Upgrade to continue.")).toBe(false);
    expect(ECHO_LINE_RE.test('You have exceeded your monthly quota (Request ID: X)')).toBe(false);
    expect(ECHO_LINE_RE.test('ERROR: request timed out')).toBe(false);
  });

  it('stripEchoLines removes only echo lines, preserving real signals', () => {
    const mixed = [
      'const PATTERN = /quota exceeded/i;', // 에코 (제거)
      'You have exceeded your monthly quota', // 진짜 신호 (보존)
      'gate=probe(quota)', // 에코 (제거)
    ].join('\n');
    const out = stripEchoLines(mixed);
    expect(out).toBe('You have exceeded your monthly quota');
  });
});
