import { circuitBreakerRegistry, type CircuitState } from './circuit-breaker-registry.js';

export interface CircuitBreakerConfig {
  failureThreshold: number;    // consecutive failures to open (default 3)
  resetTimeoutMs: number;      // time before half-open (default 60000)
  halfOpenMaxAttempts: number;  // attempts in half-open (default 1)
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
  halfOpenMaxAttempts: 1,
};

export class CircuitBreaker {
  private agentId: string;
  private config: CircuitBreakerConfig;

  constructor(agentId: string, config?: Partial<CircuitBreakerConfig>) {
    this.agentId = agentId;
    this.config = {
      failureThreshold: normalizePositiveInteger(config?.failureThreshold, DEFAULT_CONFIG.failureThreshold),
      resetTimeoutMs: normalizePositiveInteger(config?.resetTimeoutMs, DEFAULT_CONFIG.resetTimeoutMs),
      halfOpenMaxAttempts: normalizePositiveInteger(config?.halfOpenMaxAttempts, DEFAULT_CONFIG.halfOpenMaxAttempts),
    };
  }

  canExecute(): boolean {
    return circuitBreakerRegistry.canExecute(this.agentId, this.config);
  }

  recordSuccess(): void {
    circuitBreakerRegistry.recordSuccess(this.agentId);
  }

  recordFailure(error?: string): void {
    circuitBreakerRegistry.recordFailure(this.agentId, error, this.config);
  }

  getState(): CircuitState { return circuitBreakerRegistry.getSnapshot(this.agentId).state; }
  getFailures(): number { return circuitBreakerRegistry.getSnapshot(this.agentId).failureCount; }

  reset(): void {
    circuitBreakerRegistry.reset(this.agentId);
  }

  toJSON() {
    const snapshot = circuitBreakerRegistry.getSnapshot(this.agentId);
    return {
      state: snapshot.state,
      failures: snapshot.failureCount,
      lastFailureAt: snapshot.openedAt ?? 0,
      cooldownUntil: snapshot.cooldownUntil,
      reason: snapshot.reason,
      agentId: this.agentId,
    };
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}
