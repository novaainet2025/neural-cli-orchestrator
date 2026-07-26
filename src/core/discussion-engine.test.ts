import { describe, expect, it } from 'vitest';
import { requireDiscussionOutput, selectDiscussionConclusion } from './discussion-engine.js';

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

describe('discussion conclusion selection', () => {
  it('uses the commander synthesis instead of falling back to the first participant', () => {
    const result = selectDiscussionConclusion([
      {
        round: 1,
        responses: {
          higgsfield: '118904a8-2d77-4753-85c2-7c8752cd9280',
          agy: 'evidence-backed proposal',
        },
        consensusRate: 0,
      },
      {
        round: 2,
        responses: { agy: 'agy should win' },
        evaluations: { agy: { higgsfield: 1, agy: 9 } },
        consensusRate: 1,
      },
      {
        round: 3,
        responses: { 'claude-code': 'final verified synthesis' },
        consensusRate: 1,
      },
    ], ['higgsfield', 'agy', 'claude-code']);

    expect(result).toEqual({
      adoptedAgent: 'claude-code',
      adoptedProposal: 'final verified synthesis',
    });
  });

  it('fails closed when every R1 provider failed to return a proposal', () => {
    expect(() => selectDiscussionConclusion([
      { round: 1, responses: {}, consensusRate: 0 },
    ], ['codex', 'cursor-agent'])).toThrow('discussion_no_valid_proposals');
  });

  it('uses the evaluated R1 winner when synthesis is unavailable', () => {
    const result = selectDiscussionConclusion([
      {
        round: 1,
        responses: { codex: 'proposal A', opencode: 'proposal B' },
        consensusRate: 0,
      },
      {
        round: 2,
        responses: { cursor: 'evaluation' },
        evaluations: { cursor: { codex: 6, opencode: 9 } },
        consensusRate: 1,
      },
    ], ['codex', 'opencode']);

    expect(result).toEqual({ adoptedAgent: 'opencode', adoptedProposal: 'proposal B' });
  });
});
