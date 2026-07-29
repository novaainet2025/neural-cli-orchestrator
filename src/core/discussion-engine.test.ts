import { describe, expect, it } from 'vitest';
import {
  DISCUSSION_EVENT_CONTENT_LIMIT,
  DISCUSSION_MIN_RESPONSE_LENGTH,
  buildDiscussionEventContent,
  formatDiscussionProposalContent,
  requireDiscussionOutput,
  requireSubstantiveDiscussionOutput,
  selectDiscussionConclusion,
  selectDiscussionSynthesisProvider,
} from './discussion-engine.js';

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

  it('rejects short discussion preambles that are not substantive responses', () => {
    expect(() =>
      requireSubstantiveDiscussionOutput('opencode', {
        success: true,
        output: 'nova-cli의 package.json을 확인합니다.',
      }, 'proposal'),
    ).toThrow(`non-substantive proposal response`);
    expect(() =>
      requireSubstantiveDiscussionOutput('opencode', {
        success: true,
        output: 'Let me first examine the actual project context to evaluate these proposals.',
      }, 'evaluation'),
    ).toThrow('non-substantive evaluation response');
  });

  it('accepts completed responses at each discussion-specific minimum', () => {
    for (const [messageType, minimumLength] of Object.entries(DISCUSSION_MIN_RESPONSE_LENGTH)) {
      expect(
        requireSubstantiveDiscussionOutput(
          'agy',
          { success: true, output: 'x'.repeat(minimumLength) },
          messageType as keyof typeof DISCUSSION_MIN_RESPONSE_LENGTH,
        ),
      ).toHaveLength(minimumLength);
    }
  });

  it('bounds websocket content while retaining the original length and truncation flag', () => {
    const output = 'x'.repeat(DISCUSSION_EVENT_CONTENT_LIMIT + 123);
    expect(buildDiscussionEventContent(output)).toEqual({
      content: 'x'.repeat(DISCUSSION_EVENT_CONTENT_LIMIT),
      contentLength: DISCUSSION_EVENT_CONTENT_LIMIT + 123,
      contentTruncated: true,
    });
  });

  it('keeps both the head and conclusion tail when a proposal exceeds the prompt budget', () => {
    const proposal = `HEAD-${'m'.repeat(1_000)}-TAIL`;
    const formatted = formatDiscussionProposalContent(proposal, 300);

    expect(formatted).toContain('HEAD-');
    expect(formatted).toContain('-TAIL');
    expect(formatted).toContain('원문은 DB에 보존');
    expect(formatted.length).toBeLessThanOrEqual(300);
  });

  it('selects synthesis only from providers that returned a valid R1 proposal', () => {
    expect(selectDiscussionSynthesisProvider(['agy', 'nvidia'])).toBe('agy');
    expect(selectDiscussionSynthesisProvider(['opencode', 'codex'])).toBe('codex');
    expect(selectDiscussionSynthesisProvider([])).toBeUndefined();
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

  it('fails closed when valid proposals < 2', () => {
    expect(() => selectDiscussionConclusion([
      { round: 1, responses: { codex: 'valid proposal' }, consensusRate: 0 },
    ], ['codex', 'cursor-agent'])).toThrow('discussion_insufficient_valid_proposals:1/2');
  });

  it('accepts a synthesis from a responsive non-claude provider', () => {
    const result = selectDiscussionConclusion([
      {
        round: 1,
        responses: { agy: 'proposal A', nvidia: 'proposal B' },
        consensusRate: 0,
      },
      {
        round: 2,
        responses: { agy: 'evaluation' },
        evaluations: { agy: { nvidia: 8 } },
        consensusRate: 1,
      },
      {
        round: 3,
        responses: { agy: 'responsive-provider synthesis' },
        consensusRate: 1,
      },
    ], ['agy', 'nvidia']);

    expect(result).toEqual({
      adoptedAgent: 'agy',
      adoptedProposal: 'responsive-provider synthesis',
    });
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
