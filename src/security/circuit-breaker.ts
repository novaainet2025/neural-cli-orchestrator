import { circuitBreakerRegistry, type CircuitState } from './circuit-breaker-registry.js';

export interface CircuitBreakerConfig {
  failureThreshold: number;    // consecutive failures to open (default 5)
  resetTimeoutMs: number;      // time before half-open (default 60000)
  halfOpenMaxAttempts: number;  // attempts in half-open (default 1)
}

export class CircuitBreaker {
  private agentId: string;

  constructor(agentId: string, config?: Partial<CircuitBreakerConfig>) {
    this.agentId = agentId;
    void config;
  }

  canExecute(): boolean {
    return circuitBreakerRegistry.canExecute(this.agentId);
  }

  recordSuccess(): void {
    circuitBreakerRegistry.recordSuccess(this.agentId);
  }

  recordFailure(error?: string): void {
    circuitBreakerRegistry.recordFailure(this.agentId, error);
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
