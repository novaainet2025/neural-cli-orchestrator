import { createLogger } from '../utils/logger.js';

const log = createLogger('circuit-breaker');

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  failureThreshold: number;    // consecutive failures to open (default 5)
  resetTimeoutMs: number;      // time before half-open (default 60000)
  halfOpenMaxAttempts: number;  // attempts in half-open (default 1)
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
  halfOpenMaxAttempts: 1,
};

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailureAt = 0;
  private halfOpenAttempts = 0;
  private config: CircuitBreakerConfig;
  private agentId: string;

  constructor(agentId: string, config?: Partial<CircuitBreakerConfig>) {
    this.agentId = agentId;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  canExecute(): boolean {
    switch (this.state) {
      case 'closed':
        return true;

      case 'open': {
        const elapsed = Date.now() - this.lastFailureAt;
        if (elapsed >= this.config.resetTimeoutMs) {
          this.state = 'half-open';
          this.halfOpenAttempts = 0;
          log.info({ agentId: this.agentId }, 'Circuit half-open (retry allowed)');
          return true;
        }
        return false;
      }

      case 'half-open':
        return this.halfOpenAttempts < this.config.halfOpenMaxAttempts;
    }
  }

  recordSuccess(): void {
    if (this.state === 'half-open') {
      log.info({ agentId: this.agentId }, 'Circuit closed (recovered)');
    }
    this.state = 'closed';
    this.failures = 0;
    this.halfOpenAttempts = 0;
  }

  recordFailure(error?: string): void {
    this.failures++;
    this.lastFailureAt = Date.now();

    if (this.state === 'half-open') {
      this.halfOpenAttempts++;
      if (this.halfOpenAttempts >= this.config.halfOpenMaxAttempts) {
        this.state = 'open';
        log.warn({ agentId: this.agentId, failures: this.failures, error }, 'Circuit re-opened');
      }
      return;
    }

    if (this.failures >= this.config.failureThreshold) {
      this.state = 'open';
      log.warn({ agentId: this.agentId, failures: this.failures, error },
        'Circuit opened (agent isolated)');
    }
  }

  getState(): CircuitState { return this.state; }
  getFailures(): number { return this.failures; }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.halfOpenAttempts = 0;
  }

  toJSON() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureAt: this.lastFailureAt,
      agentId: this.agentId,
    };
  }
}
