/**
 * Process-wide provider generation barrier.
 *
 * Every actual model execution acquires a lease. A registry reconciliation
 * closes admission first, drains existing executions, swaps every runtime
 * consumer, then reopens admission. Keeping this primitive dependency-free
 * avoids circular imports between AgentManager and the runtime coordinator.
 */
export class ProviderAdmissionGate {
  private reconciling = false;
  private active = 0;
  private blockedReason: string | null = null;
  private readonly stableWaiters = new Set<() => void>();
  private readonly drainWaiters = new Set<() => void>();

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.blockedReason) {
      throw new Error(`provider_admission_blocked: ${this.blockedReason}`);
    }
    while (this.reconciling) {
      await new Promise<void>((resolve, reject) => {
        const resume = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(signal?.reason instanceof Error ? signal.reason : new Error('provider_admission_aborted'));
        };
        const cleanup = () => {
          this.stableWaiters.delete(resume);
          signal?.removeEventListener('abort', abort);
        };
        this.stableWaiters.add(resume);
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
      if (this.blockedReason) {
        throw new Error(`provider_admission_blocked: ${this.blockedReason}`);
      }
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('provider_admission_aborted');
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      if (this.active === 0) {
        for (const resolve of this.drainWaiters) resolve();
        this.drainWaiters.clear();
      }
    };
  }

  async beginReconciliation(maxDrainMs = 30_000): Promise<(blockReason?: string) => void> {
    while (this.reconciling) {
      await new Promise<void>(resolve => this.stableWaiters.add(resolve));
    }
    this.reconciling = true;
    if (this.active > 0) {
      let drainResolved: (() => void) | undefined;
      let timer: NodeJS.Timeout | undefined;
      const drained = new Promise<void>(resolve => {
        drainResolved = resolve;
        this.drainWaiters.add(resolve);
      });
      const timeoutMs = Number.isFinite(maxDrainMs) ? Math.max(1, Math.trunc(maxDrainMs)) : 30_000;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`provider_reconciliation_drain_timeout: ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      try {
        await Promise.race([drained, timedOut]);
      } catch (error) {
        if (drainResolved) this.drainWaiters.delete(drainResolved);
        this.reconciling = false;
        for (const resolve of this.stableWaiters) resolve();
        this.stableWaiters.clear();
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    let ended = false;
    return (blockReason?: string) => {
      if (ended) return;
      ended = true;
      this.reconciling = false;
      this.blockedReason = blockReason?.trim() || null;
      for (const resolve of this.stableWaiters) resolve();
      this.stableWaiters.clear();
    };
  }

  snapshot(): { reconciling: boolean; active: number; blockedReason: string | null } {
    return {
      reconciling: this.reconciling,
      active: this.active,
      blockedReason: this.blockedReason,
    };
  }
}

export const providerAdmissionGate = new ProviderAdmissionGate();
