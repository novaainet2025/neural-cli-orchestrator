import { describe, expect, it, vi } from 'vitest';
import { ProviderAdmissionGate } from './provider-admission-gate.js';

describe('ProviderAdmissionGate', () => {
  it('drains active executions and blocks new admission until reconciliation commits', async () => {
    const gate = new ProviderAdmissionGate();
    const releaseActive = await gate.acquire();
    const endPromise = gate.beginReconciliation();
    await Promise.resolve();
    expect(gate.snapshot()).toEqual({ reconciling: true, active: 1, blockedReason: null });

    const admitted = vi.fn();
    const waitingAdmission = gate.acquire().then(release => {
      admitted();
      return release;
    });
    await Promise.resolve();
    expect(admitted).not.toHaveBeenCalled();

    releaseActive();
    const endReconciliation = await endPromise;
    expect(admitted).not.toHaveBeenCalled();
    endReconciliation();

    const releaseWaiting = await waitingAdmission;
    expect(admitted).toHaveBeenCalledOnce();
    expect(gate.snapshot()).toEqual({ reconciling: false, active: 1, blockedReason: null });
    releaseWaiting();
    expect(gate.snapshot()).toEqual({ reconciling: false, active: 0, blockedReason: null });
  });

  it('fails the swap open to the last-known-good generation after a bounded drain', async () => {
    const gate = new ProviderAdmissionGate();
    const releaseActive = await gate.acquire();

    await expect(gate.beginReconciliation(10)).rejects.toThrow(
      'provider_reconciliation_drain_timeout: 10ms',
    );
    expect(gate.snapshot()).toEqual({ reconciling: false, active: 1, blockedReason: null });

    const releaseNext = await gate.acquire();
    expect(gate.snapshot()).toEqual({ reconciling: false, active: 2, blockedReason: null });
    releaseNext();
    releaseActive();
    expect(gate.snapshot()).toEqual({ reconciling: false, active: 0, blockedReason: null });
  });

  it('aborts waiters and fails closed after an inconsistent reconciliation', async () => {
    const gate = new ProviderAdmissionGate();
    const end = await gate.beginReconciliation();
    const controller = new AbortController();
    const waiting = gate.acquire(controller.signal);
    controller.abort(new Error('task_deadline_exceeded'));
    await expect(waiting).rejects.toThrow('task_deadline_exceeded');

    end('provider_runtime_inconsistent');
    await expect(gate.acquire()).rejects.toThrow(
      'provider_admission_blocked: provider_runtime_inconsistent',
    );

    const recover = await gate.beginReconciliation();
    recover();
    const release = await gate.acquire();
    release();
  });
});
