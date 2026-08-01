import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISCUSSION_EVENT_CONTENT_LIMIT,
  DISCUSSION_MIN_RESPONSE_LENGTH,
  DISCUSSION_QUORUM_GRACE_CEILING_MS,
  DISCUSSION_RETRY_TIMEOUT_CEILING_MS,
  DISCUSSION_TIMEOUT_CEILING_MS,
  DISCUSSION_TIMEOUT_FLOOR_MS,
  authorizeSingleProposalFallback,
  buildDiscussionEventContent,
  buildDiscussionSynthesisPrompt,
  discussionEngine,
  formatDiscussionProposalContent,
  requireDiscussionOutput,
  requireSubstantiveDiscussionOutput,
  resolveDiscussionQuorumGraceMs,
  resolveDiscussionProposalQuorum,
  resolveDiscussionRetryTimeoutMs,
  resolveDiscussionTimeoutMs,
  selectDiscussionConclusion,
  selectDiscussionReplacementProviders,
  selectDiscussionSynthesisProvider,
} from './discussion-engine.js';
import { agentManager } from '../agent/agent-manager.js';
import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';
import { getDb } from '../storage/database.js';

describe('discussion stage timeout resolution', () => {
  const overridden = [
    'NCO_DISCUSSION_PROPOSAL_TIMEOUT_MS',
    'NCO_DISCUSSION_EVALUATION_TIMEOUT_MS',
    'NCO_DISCUSSION_RETRY_TIMEOUT_MS',
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

  it('bounds R1 retry separately from the full initial proposal budget', () => {
    expect(resolveDiscussionRetryTimeoutMs()).toBe(120_000);
    process.env.NCO_DISCUSSION_RETRY_TIMEOUT_MS = String(60 * 60 * 1000);
    expect(resolveDiscussionRetryTimeoutMs()).toBe(DISCUSSION_RETRY_TIMEOUT_CEILING_MS);
    process.env.NCO_DISCUSSION_RETRY_TIMEOUT_MS = '1000';
    expect(resolveDiscussionRetryTimeoutMs()).toBe(DISCUSSION_TIMEOUT_FLOOR_MS);
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

  it('keeps original output constraints in the final synthesis prompt', () => {
    const prompt = buildDiscussionSynthesisPrompt(
      '한국어로 답하고 마지막에 NCO_REQUIRED_MARKER를 포함하라.',
      '[codex] proposal',
      '[hermes] evaluation',
    );

    expect(prompt).toContain('한국어로 답하고 마지막에 NCO_REQUIRED_MARKER를 포함하라.');
    expect(prompt).toContain('[codex] proposal');
    expect(prompt).toContain('[hermes] evaluation');
    expect(prompt).toContain('every explicit language, format, marker, and acceptance constraint');
  });

  it('selects synthesis only from providers that returned a valid R1 proposal', () => {
    expect(selectDiscussionSynthesisProvider(['agy', 'hermes'])).toBe('agy');
    expect(selectDiscussionSynthesisProvider(['opencode', 'codex'])).toBe('codex');
    expect(selectDiscussionSynthesisProvider([])).toBeUndefined();
  });

  it('adds one bounded spare replacement so a single timeout cannot defeat quorum', () => {
    expect(selectDiscussionReplacementProviders(
      ['opencode', 'claude-code', 'codex'],
      ['codex'],
      ['opencode', 'ollama', 'codex', 'cursor-agent', 'hermes'],
    )).toEqual(['ollama', 'hermes']);
  });

  it('caps replacement overprovisioning at one provider when two proposals are missing', () => {
    expect(selectDiscussionReplacementProviders(
      ['opencode', 'claude-code', 'codex'],
      [],
      ['opencode', 'ollama', 'codex', 'agy', 'cursor-agent', 'hermes'],
    )).toEqual(['ollama', 'agy', 'hermes']);
  });

  it('does not select replacements after proposal quorum is satisfied', () => {
    expect(selectDiscussionReplacementProviders(
      ['opencode', 'codex'],
      ['opencode', 'codex'],
      ['ollama', 'cursor-agent'],
    )).toEqual([]);
  });
});

describe('discussion cancellation', () => {
  it('aborts active providers and keeps the persisted discussion cancelled', async () => {
    const db = getDb();
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const taskId = `task-cancel-${suffix}`;
    const sessionId = `discussion-cancel-${suffix}`;
    const seenSignals: AbortSignal[] = [];
    const execute = vi.spyOn(agentManager, 'executeTask')
      .mockImplementation(async (_providerId: string, _prompt: string, options?: any) => {
        const signal = options?.signal as AbortSignal;
        seenSignals.push(signal);
        return await new Promise((resolve, reject) => {
          const rejectAbort = () => reject(signal.reason ?? new Error('aborted'));
          if (signal.aborted) rejectAbort();
          else signal.addEventListener('abort', rejectAbort, { once: true });
        });
      });

    const running = discussionEngine.startDiscussion({
      sessionId,
      taskId,
      topic: 'cancel this discussion while providers are active',
      mode: 'discussion',
      providers: ['codex', 'agy'],
      maxRounds: 1,
      projectDir: '/tmp',
    });

    try {
      for (let attempt = 0; attempt < 50 && execute.mock.calls.length < 2; attempt++) {
        await new Promise(resolveWait => setTimeout(resolveWait, 0));
      }
      expect(execute).toHaveBeenCalledTimes(2);
      expect(discussionEngine.cancelTaskDiscussions(taskId)).toBe(1);
      await expect(running).rejects.toThrow('discussion_cancelled');
      expect(seenSignals).toHaveLength(2);
      expect(seenSignals.every(signal => signal.aborted)).toBe(true);
      expect(db.prepare('SELECT status, report FROM discussions WHERE id=?').get(sessionId))
        .toEqual({ status: 'cancelled', report: 'cancelled_by_user' });
      expect(discussionEngine.cancelTaskDiscussions(taskId)).toBe(0);
    } finally {
      vi.restoreAllMocks();
      db.prepare('DELETE FROM discussion_messages WHERE discussion_id=?').run(sessionId);
      db.prepare('DELETE FROM discussions WHERE id=?').run(sessionId);
    }
  });
});

describe('hive response quorum', () => {
  it('fails closed before synthesis when fewer than two providers return substantive output', async () => {
    const db = getDb();
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const sessionId = `hive-quorum-${suffix}`;
    const execute = vi.spyOn(agentManager, 'executeTask')
      .mockImplementation(async (providerId: string) => providerId === 'codex'
        ? ({ success: true, output: 'x'.repeat(DISCUSSION_MIN_RESPONSE_LENGTH.proposal) } as any)
        : ({ success: true, output: 'too short' } as any));

    try {
      await expect(discussionEngine.startDiscussion({
        sessionId,
        topic: 'collect two independent hive responses',
        mode: 'hive',
        providers: ['codex', 'agy'],
        projectDir: '/tmp',
      })).rejects.toThrow('hive_insufficient_valid_responses:1/2');
      expect(execute).toHaveBeenCalledTimes(2);
      expect(db.prepare('SELECT status, report FROM discussions WHERE id=?').get(sessionId))
        .toEqual({ status: 'failed', report: 'hive_insufficient_valid_responses:1/2' });
    } finally {
      vi.restoreAllMocks();
      db.prepare('DELETE FROM discussion_messages WHERE discussion_id=?').run(sessionId);
      db.prepare('DELETE FROM discussions WHERE id=?').run(sessionId);
    }
  });
});

describe('discussion conclusion selection', () => {
  it('uses a valid R1 proposal when a caller explicitly runs one round', () => {
    const result = selectDiscussionConclusion([
      {
        round: 1,
        responses: { ollama: 'proposal A', codex: 'proposal B' },
        consensusRate: 0,
      },
    ], ['ollama', 'codex']);

    expect(result).toEqual({ adoptedAgent: 'ollama', adoptedProposal: 'proposal A' });
  });

  it('uses the commander synthesis instead of falling back to the first participant', () => {
    const result = selectDiscussionConclusion([
      {
        round: 1,
        responses: {
          'media-job-runner': '118904a8-2d77-4753-85c2-7c8752cd9280',
          agy: 'evidence-backed proposal',
        },
        consensusRate: 0,
      },
      {
        round: 2,
        responses: { agy: 'agy should win' },
        evaluations: { agy: { 'media-job-runner': 1, agy: 9 } },
        consensusRate: 1,
      },
      {
        round: 3,
        responses: { 'claude-code': 'final verified synthesis' },
        consensusRate: 1,
      },
    ], ['media-job-runner', 'agy', 'claude-code']);

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

  it('accepts one proposal only when bounded fallback degradation is explicit', () => {
    const result = selectDiscussionConclusion([
      { round: 1, responses: { codex: 'sole valid proposal' }, consensusRate: 0 },
    ], ['codex', 'cursor-agent'], true);

    expect(result).toEqual({
      adoptedAgent: 'codex',
      adoptedProposal: 'sole valid proposal',
    });
  });

  it('keeps zero valid proposals fail-closed even when degradation is explicit', () => {
    expect(() => selectDiscussionConclusion([
      { round: 1, responses: {}, consensusRate: 0 },
    ], ['codex', 'cursor-agent'], true)).toThrow(
      'discussion_insufficient_valid_proposals:0/2',
    );
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

describe('discussion proposal quorum decision', () => {
  it('authorizes degraded quorum only for a persisted UI company run', () => {
    expect(authorizeSingleProposalFallback(true, 'ui-inspection')).toBe(true);
    expect(authorizeSingleProposalFallback(true, 'research')).toBe(false);
    expect(authorizeSingleProposalFallback(true, undefined)).toBe(false);
    expect(authorizeSingleProposalFallback(false, 'ui-inspection')).toBe(false);
  });

  it('keeps the default 2-proposal quorum', () => {
    expect(resolveDiscussionProposalQuorum(1)).toMatchObject({
      accepted: false,
      degraded: false,
      required: 2,
      achieved: 1,
    });
    expect(resolveDiscussionProposalQuorum(2)).toMatchObject({
      accepted: true,
      degraded: false,
      required: 2,
      achieved: 2,
    });
  });

  it('degrades only from 1/2 after the caller explicitly exhausted bounded fallback', () => {
    expect(resolveDiscussionProposalQuorum(1, true)).toEqual({
      accepted: true,
      degraded: true,
      required: 2,
      achieved: 1,
      reason: 'bounded_retry_and_replacement_exhausted',
    });
    expect(resolveDiscussionProposalQuorum(0, true)).toMatchObject({
      accepted: false,
      degraded: false,
      achieved: 0,
    });
  });
});

describe('bounded single-proposal fallback sequence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runExhaustedFallback(orgSlug: string) {
    const db = getDb();
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const companyRunId = `corun-quorum-${suffix}`;
    const sessionId = `discussion-quorum-${suffix}`;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO company_runs (
        id, org_id, org_slug, goal, mode, status, dry_run,
        project_dir, run_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pipeline', 'running', 0, '/tmp', '{}', ?, ?)
    `).run(companyRunId, `org_${orgSlug}`, orgSlug, 'bounded quorum test', now, now);

    const execute = vi.spyOn(agentManager, 'executeTask')
      .mockImplementation(async (providerId: string) => {
        if (providerId === 'agy') {
          return { success: true, output: 'sole valid proposal' } as any;
        }
        throw new Error(`${providerId} unavailable`);
      });
    vi.spyOn(agentManager, 'listEnabledIds')
      .mockReturnValue(['agy', 'hermes', 'opencode', 'ollama']);
    vi.spyOn(circuitBreakerRegistry, 'getAvailability')
      .mockReturnValue({ available: true } as any);

    try {
      const report = await discussionEngine.startDiscussion({
        sessionId,
        topic: 'exercise the bounded fallback sequence',
        mode: 'discussion',
        providers: ['agy', 'hermes'],
        maxRounds: 1,
        companyRunId,
        projectDir: '/tmp',
        allowSingleProposalAfterBoundedFallback: true,
      });
      return { report, execute, sessionId };
    } catch (error) {
      return { error, execute, sessionId };
    } finally {
      // Assertions read the persisted discussion before the caller removes it.
      vi.restoreAllMocks();
    }
  }

  function cleanupSequence(sessionId: string) {
    const db = getDb();
    const row = db.prepare('SELECT company_run_id FROM discussions WHERE id=?')
      .get(sessionId) as { company_run_id?: string } | undefined;
    db.prepare('DELETE FROM discussion_messages WHERE discussion_id=?').run(sessionId);
    db.prepare('DELETE FROM discussions WHERE id=?').run(sessionId);
    if (row?.company_run_id) {
      db.prepare('DELETE FROM company_runs WHERE id=?').run(row.company_run_id);
    }
  }

  it('persists degraded evidence only after UI retry and replacement waves are exhausted', async () => {
    const outcome = await runExhaustedFallback('ui-inspection');
    try {
      expect(outcome.error).toBeUndefined();
      expect(outcome.report?.proposalQuorum).toMatchObject({
        required: 2,
        achieved: 1,
        degraded: true,
        reason: 'bounded_retry_and_replacement_exhausted',
        initialProviders: ['agy', 'hermes'],
        retriedProviders: ['hermes'],
        attemptWaves: 3,
        providerCalls: 5,
      });
      expect(new Set(outcome.report?.proposalQuorum?.replacementProviders)).toEqual(
        new Set(['opencode', 'ollama']),
      );
      expect(outcome.execute.mock.calls.filter(([provider]) => provider === 'hermes')).toHaveLength(2);

      const persisted = getDb().prepare(
        'SELECT status, result_json FROM discussions WHERE id=?',
      ).get(outcome.sessionId) as { status: string; result_json: string };
      expect(persisted.status).toBe('completed');
      expect(JSON.parse(persisted.result_json).proposalQuorum).toMatchObject({
        achieved: 1,
        degraded: true,
        attemptWaves: 3,
      });
    } finally {
      cleanupSequence(outcome.sessionId);
    }
  });

  it('keeps an otherwise identical non-UI company run fail-closed', async () => {
    const outcome = await runExhaustedFallback('research');
    try {
      expect(outcome.report).toBeUndefined();
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toBe(
        'discussion_insufficient_valid_proposals:1/2',
      );

      const persisted = getDb().prepare(
        'SELECT status, result_json FROM discussions WHERE id=?',
      ).get(outcome.sessionId) as { status: string; result_json: string };
      expect(persisted.status).toBe('failed');
      expect(JSON.parse(persisted.result_json)).toMatchObject({
        error: 'discussion_insufficient_valid_proposals:1/2',
        proposalQuorum: {
          achieved: 1,
          degraded: false,
        },
      });
    } finally {
      cleanupSequence(outcome.sessionId);
    }
  });
});
