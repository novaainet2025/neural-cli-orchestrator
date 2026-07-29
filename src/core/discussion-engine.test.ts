import { afterEach, describe, expect, it } from 'vitest';
import {
  DISCUSSION_EVENT_CONTENT_LIMIT,
  DISCUSSION_MIN_RESPONSE_LENGTH,
  DISCUSSION_QUORUM_GRACE_CEILING_MS,
  DISCUSSION_TIMEOUT_CEILING_MS,
  DISCUSSION_TIMEOUT_FLOOR_MS,
  buildDiscussionEventContent,
  formatDiscussionProposalContent,
  requireDiscussionOutput,
  requireSubstantiveDiscussionOutput,
  resolveDiscussionQuorumGraceMs,
  resolveDiscussionTimeoutMs,
  selectDiscussionConclusion,
  selectDiscussionSynthesisProvider,
} from './discussion-engine.js';

describe('discussion stage timeout resolution', () => {
  const overridden = [
    'NCO_DISCUSSION_PROPOSAL_TIMEOUT_MS',
    'NCO_DISCUSSION_EVALUATION_TIMEOUT_MS',
  ];
  afterEach(() => {
    for (const key of overridden) delete process.env[key];
  });

  // 하한이 실측 소요보다 짧으면 참가자가 모델 오류 없이 취소된다(2026-07-29 근본원인).
  it('defaults every stage above the observed round durations', () => {
    expect(resolveDiscussionTimeoutMs('proposal')).toBeGreaterThanOrEqual(420_000);
    expect(resolveDiscussionTimeoutMs('evaluation')).toBeGreaterThanOrEqual(300_000);
    expect(resolveDiscussionTimeoutMs('synthesis')).toBeGreaterThanOrEqual(300_000);
    expect(resolveDiscussionTimeoutMs('hive')).toBeGreaterThanOrEqual(300_000);
  });

  // 상한을 없애면 hang이 자원을 무한정 잡는다 — 오버라이드도 반드시 클램프되어야 한다.
  it('clamps an unbounded override down to the ceiling', () => {
    process.env.NCO_DISCUSSION_PROPOSAL_TIMEOUT_MS = String(24 * 60 * 60 * 1000);
    expect(resolveDiscussionTimeoutMs('proposal')).toBe(DISCUSSION_TIMEOUT_CEILING_MS);
  });

  it('clamps a too-aggressive override up to the floor', () => {
    process.env.NCO_DISCUSSION_EVALUATION_TIMEOUT_MS = '1000';
    expect(resolveDiscussionTimeoutMs('evaluation')).toBe(DISCUSSION_TIMEOUT_FLOOR_MS);
  });

  it('ignores non-numeric overrides instead of producing NaN', () => {
    process.env.NCO_DISCUSSION_PROPOSAL_TIMEOUT_MS = 'not-a-number';
    expect(resolveDiscussionTimeoutMs('proposal')).toBe(420_000);
  });
});

describe('discussion quorum grace window', () => {
  afterEach(() => {
    delete process.env.NCO_DISCUSSION_QUORUM_GRACE_MS;
  });

  // 유예를 두는 이유: 정족수 도달 즉시 끊으면 직후 도착할 제안까지 버린다.
  it('defaults to a non-zero grace so a near-simultaneous proposal is not discarded', () => {
    expect(resolveDiscussionQuorumGraceMs()).toBeGreaterThan(0);
  });

  // 유예가 상한을 넘으면 조기 진행의 의미가 사라진다.
  it('clamps an oversized grace down to the ceiling', () => {
    process.env.NCO_DISCUSSION_QUORUM_GRACE_MS = String(60 * 60 * 1000);
    expect(resolveDiscussionQuorumGraceMs()).toBe(DISCUSSION_QUORUM_GRACE_CEILING_MS);
  });

  // 0 은 "즉시 진행"이라는 유효한 설정이므로 기본값으로 되돌리면 안 된다.
  it('honours an explicit zero grace as immediate progression', () => {
    process.env.NCO_DISCUSSION_QUORUM_GRACE_MS = '0';
    expect(resolveDiscussionQuorumGraceMs()).toBe(0);
  });

  it('rejects negative and non-numeric values by falling back to the default', () => {
    process.env.NCO_DISCUSSION_QUORUM_GRACE_MS = '-5000';
    const fallback = resolveDiscussionQuorumGraceMs();
    process.env.NCO_DISCUSSION_QUORUM_GRACE_MS = 'nope';
    expect(resolveDiscussionQuorumGraceMs()).toBe(fallback);
    expect(fallback).toBeGreaterThan(0);
  });
});

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
    expect(selectDiscussionSynthesisProvider(['agy', 'hermes'])).toBe('agy');
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
        responses: { agy: 'proposal A', hermes: 'proposal B' },
        consensusRate: 0,
      },
      {
        round: 2,
        responses: { agy: 'evaluation' },
        evaluations: { agy: { hermes: 8 } },
        consensusRate: 1,
      },
      {
        round: 3,
        responses: { agy: 'responsive-provider synthesis' },
        consensusRate: 1,
      },
    ], ['agy', 'hermes']);

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
