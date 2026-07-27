import { circuitBreakerRegistry, type CircuitState } from './circuit-breaker-registry.js';
import {
  collaborationChannelKey,
  collaborationLoopGuard,
  type CollaborationLoopDecision,
  type CollaborationLoopRuleConfig,
} from './collaboration-loop-guard.js';

export type {
  CollaborationLoopDecision,
  CollaborationLoopRule,
  CollaborationLoopRuleConfig,
} from './collaboration-loop-guard.js';
export {
  CollaborationLoopGuard,
  DEFAULT_COLLABORATION_LOOP_CONFIG,
  collaborationChannelKey,
  collaborationLoopGuard,
  isCollaborationLoopGuardEnabled,
} from './collaboration-loop-guard.js';

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

  /**
   * collaboration-msg-loop 룰을 이 에이전트가 보내는 협업 메시지에 적용한다.
   * 채널 키는 `<agentId>-><peerSessionId>` 이며, 프로바이더 회로 상태와는 독립이다
   * (협업 메시지 루프는 프로바이더 장애가 아니므로 circuit_states를 오염시키지 않는다).
   */
  checkCollaborationMessage(
    peerSessionId: string,
    content: string,
    config?: Partial<CollaborationLoopRuleConfig>,
  ): CollaborationLoopDecision {
    return collaborationLoopGuard.check(
      collaborationChannelKey(this.agentId, peerSessionId),
      content,
      config,
    );
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
