import { describe, expect, it } from 'vitest';
import { isRetryableFailoverFailure, selectFailoverCandidate } from './task-failover.js';

describe('isRetryableFailoverFailure', () => {
  it('returns true for timeout and known empty-completion patterns', () => {
    expect(isRetryableFailoverFailure({ status: 'timed_out' })).toBe(true);
    expect(isRetryableFailoverFailure({ error: "empty completion from provider 'ollama' after 2 iteration(s)" })).toBe(true);
    expect(isRetryableFailoverFailure({ response: '[codex: no final response — process aborted (timeout)]' })).toBe(true);
    expect(isRetryableFailoverFailure({ error: 'timeout waiting for provider output' })).toBe(true);
    expect(isRetryableFailoverFailure({ status: 'failed', error: 'The operation was aborted due to timeout' })).toBe(true);
    expect(isRetryableFailoverFailure({ status: 'failed', error: 'verifier failed: exit 1' })).toBe(false);
  });
});

describe('selectFailoverCandidate', () => {
  it('skips attempted and unavailable agents', () => {
    const candidate = selectFailoverCandidate({
      chain: ['opencode', 'agy'],
      attemptedAgents: ['codex', 'opencode'],
      isAvailable: (agentId) => agentId === 'agy',
    });

    expect(candidate).toBe('agy');
  });
});
