import { createLogger } from '../utils/logger.js';

const log = createLogger('resource-limiter');

export interface ResourcePolicy {
  maxFileSize: number;          // bytes (default 10MB)
  maxExecutionTime: number;     // ms (default 120000)
  maxMemory: number;            // bytes (default 512MB)
  maxConcurrentActions: number; // default 4
}

const DEFAULT_POLICY: ResourcePolicy = {
  maxFileSize: 10 * 1024 * 1024,      // 10MB
  maxExecutionTime: 120_000,           // 2 min
  maxMemory: 512 * 1024 * 1024,       // 512MB
  maxConcurrentActions: 4,
};

export class ResourceLimiter {
  private policy: ResourcePolicy;
  private activeActions: number = 0;

  constructor(policy?: Partial<ResourcePolicy>) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  checkFileSize(size: number): void {
    if (size > this.policy.maxFileSize) {
      throw new Error(
        `ResourceLimiter: File size ${size} exceeds limit ${this.policy.maxFileSize}`
      );
    }
  }

  getTimeout(): number {
    return this.policy.maxExecutionTime;
  }

  async acquireSlot(): Promise<() => void> {
    if (this.activeActions >= this.policy.maxConcurrentActions) {
      throw new Error(
        `ResourceLimiter: Max concurrent actions (${this.policy.maxConcurrentActions}) reached`
      );
    }
    this.activeActions++;
    return () => { this.activeActions--; };
  }

  getActiveCount(): number {
    return this.activeActions;
  }
}
