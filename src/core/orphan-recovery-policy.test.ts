import { describe, expect, it } from 'vitest';
import { decideOrphanRecovery } from './orphan-recovery-policy.js';

describe('orphan recovery policy', () => {
  it('requeues a never-started queued task without consuming poison budget', () => {
    expect(decideOrphanRecovery({
      status: 'queued',
      assignedTo: 'hermes',
      recoveryCount: 99,
      maxRecoveryCount: 2,
    })).toEqual({ action: 'requeue', incrementRecoveryCount: false });
  });

  it('increments recovery budget for a task interrupted during execution', () => {
    expect(decideOrphanRecovery({
      status: 'running',
      assignedTo: 'codex',
      recoveryCount: 1,
      maxRecoveryCount: 2,
    })).toEqual({ action: 'requeue', incrementRecoveryCount: true });
  });

  it('dead-letters a repeatedly interrupted active task', () => {
    expect(decideOrphanRecovery({
      status: 'streaming',
      assignedTo: 'codex',
      recoveryCount: 2,
      maxRecoveryCount: 2,
    })).toEqual({ action: 'dead_letter', reason: 'poison' });
  });

  it('dead-letters a task that cannot be routed', () => {
    expect(decideOrphanRecovery({
      status: 'queued',
      assignedTo: null,
      recoveryCount: 0,
      maxRecoveryCount: 2,
    })).toEqual({ action: 'dead_letter', reason: 'no_agent' });
  });
});
