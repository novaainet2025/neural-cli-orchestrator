import { describe, expect, it } from 'vitest';
import { extractThinking, hasToolCalls, parseToolCalls } from './tool-parser.js';

describe('natural-language tool parsing', () => {
  it('does not turn Korean verification report headings into runTest calls', () => {
    const report = [
      'done: 구현과 집중 테스트를 완료했습니다.',
      '',
      '검증 영수증:',
      '- Test Files 2 passed',
      '- Tests 31 passed',
      '',
      '검증 결과: 통과',
    ].join('\n');

    expect(parseToolCalls(report)).toEqual([]);
    expect(hasToolCalls(report)).toBe(false);
    expect(extractThinking(report)).toContain('검증 영수증:');
  });

  it.each([
    ['검증', undefined],
    ['검증 실행', undefined],
    ['검증 실행 src/agent/tool-parser.test.ts', 'src/agent/tool-parser.test.ts'],
    ['테스트 실행 src/agent/tool-parser.test.ts', 'src/agent/tool-parser.test.ts'],
    ['runTest src/agent/tool-parser.test.ts', 'src/agent/tool-parser.test.ts'],
  ])('keeps explicit test commands working: %s', (text, expectedPath) => {
    expect(parseToolCalls(text)).toEqual([
      {
        tool: 'runTest',
        args: expectedPath ? { path: expectedPath } : {},
      },
    ]);
    expect(hasToolCalls(text)).toBe(true);
  });
});
