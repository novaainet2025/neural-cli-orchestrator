import { describe, expect, it } from 'vitest';
import { requireDiscussionOutput } from './discussion-engine.js';

describe('discussion provider output validation', () => {
  it('accepts a successful non-empty response and trims transport whitespace', () => {
    expect(
      requireDiscussionOutput('codex', { success: true, output: '  usable response\n' }),
    ).toBe('usable response');
  });

  it('rejects empty output even when the executor marks it successful', () => {
    expect(() =>
      requireDiscussionOutput('openrouter', { success: true, output: '  \n' }),
    ).toThrow('openrouter: empty response');
  });

  it('surfaces the executor failure instead of publishing completion', () => {
    expect(() =>
      requireDiscussionOutput('agy', { success: false, output: '', error: 'rate limit exceeded' }),
    ).toThrow('agy: rate limit exceeded');
  });
});
