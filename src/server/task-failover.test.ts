import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  isProviderUnavailableFailureText,
  isRetryableFailoverFailure,
  selectFailoverCandidate,
} from './task-failover.js';

describe('isRetryableFailoverFailure', () => {
  it('returns true when the assigned provider circuit opens before execution', () => {
    expect(isRetryableFailoverFailure({
      status: 'failed',
      error: 'Circuit breaker open for agent claude-code (generic)',
    })).toBe(true);
    expect(isProviderUnavailableFailureText(
      'Circuit breaker open for agent claude-code (generic)',
    )).toBe(true);
    expect(isProviderUnavailableFailureText(
      'provider_unavailable: claude-code (open/quota)',
    )).toBe(true);
  });

  it('returns true for timeout and known empty-completion patterns', () => {
    expect(isRetryableFailoverFailure({ status: 'timed_out' })).toBe(true);
    expect(isRetryableFailoverFailure({ error: "empty completion from provider 'ollama' after 2 iteration(s)" })).toBe(true);
    expect(isRetryableFailoverFailure({ response: '[codex: no final response — process aborted (timeout)]' })).toBe(true);
    expect(isRetryableFailoverFailure({ error: 'timeout waiting for provider output' })).toBe(true);
    expect(isRetryableFailoverFailure({ status: 'failed', error: 'The operation was aborted due to timeout' })).toBe(true);
    expect(isRetryableFailoverFailure({ status: 'failed', error: 'verifier failed: exit 1' })).toBe(true);
  });

  it('classifies observed failures and retries everything except explicit policy stops', () => {
    expect(classifyFailure({ status: 'failed', error: 'Circuit breaker open for agent codex' })).toBe('provider_unavailable');
    expect(classifyFailure({ status: 'failed', error: 'provider_unavailable: codex (open/quota)' })).toBe('provider_unavailable');
    expect(classifyFailure({ status: 'failed', error: 'weekly usage limit reached' })).toBe('provider_limit');
    expect(classifyFailure({ status: 'failed', error: 'verifier failed: exit 1' })).toBe('verifier');
    expect(classifyFailure({ status: 'failed', error: 'silent-failure: empty output' })).toBe('silent_output');
    expect(classifyFailure({ status: 'lease_expired' })).toBe('orphan');
    expect(classifyFailure({ status: 'failed', error: 'unexpected provider response' })).toBe('transient');
    expect(classifyFailure({ status: 'error', error: 'Unexpected segfault in worker' })).toBe('transient');
    expect(classifyFailure({ error: 'unclassified provider transport failure' })).toBe('transient');
    expect(classifyFailure({ status: 'cancelled' })).toBe('policy');
    expect(classifyFailure({ status: 'failed', error: 'quality_rejected: FORMAT_MISMATCH' })).toBe('policy');
    expect(isRetryableFailoverFailure({ status: 'failed', error: 'unexpected provider response' })).toBe(true);
    expect(isRetryableFailoverFailure({ status: 'error', error: 'Unexpected segfault in worker' })).toBe(true);
    expect(isRetryableFailoverFailure({ status: 'cancelled' })).toBe(false);
    expect(isRetryableFailoverFailure({ status: 'completed', response: 'done: ok' })).toBe(false);
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
