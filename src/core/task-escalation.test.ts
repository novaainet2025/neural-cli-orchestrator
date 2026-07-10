import { describe, expect, it } from 'vitest';
import { decideFinalEscalation, getAttemptedAgents } from './task-escalation.js';

describe('task escalation helpers', () => {
  it('includes the initial agent in attemptedAgents', () => {
    expect(getAttemptedAgents(undefined, 'codex')).toEqual(['codex']);
    expect(getAttemptedAgents({ attemptedAgents: ['opencode'] }, 'codex')).toEqual(['opencode', 'codex']);
  });

  it('builds escalation metadata when the policy escalates', () => {
    const result = decideFinalEscalation({
      failedAgentId: 'codex',
      failureReason: 'Rate limit exhausted',
      attemptedAgents: ['codex'],
      circuitOpenAgents: [],
      metadata: undefined,
      now: () => '2026-07-09T00:00:00.000Z',
    });

    expect(result.action).toBe('escalate');
    expect(result.nextAgentId).toBeTruthy();
    expect(result.metadataPatch?.attemptedAgents).toContain(result.nextAgentId);
    expect(result.metadataPatch?.escalationHistory).toEqual([
      {
        fromAgent: 'codex',
        toAgent: result.nextAgentId!,
        reason: 'Rate limit exhausted',
        attemptedAgents: result.metadataPatch!.attemptedAgents,
        createdAt: '2026-07-09T00:00:00.000Z',
      },
    ]);
  });

  it('gives up when every candidate is already attempted', () => {
    const result = decideFinalEscalation({
      failedAgentId: 'codex',
      failureReason: 'Rate limit exhausted',
      attemptedAgents: ['codex', 'opencode', 'cursor-agent', 'claude-code'],
      circuitOpenAgents: [],
      metadata: undefined,
    });

    expect(result).toEqual({
      action: 'give-up',
      reason: 'Maximum number of attempted agents reached',
    });
  });
});
