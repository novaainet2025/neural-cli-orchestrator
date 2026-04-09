import { PathGuard, type PathPolicy } from './path-guard.js';
import { CommandGate, type CommandPolicy } from './command-gate.js';
import { ResourceLimiter, type ResourcePolicy } from './resource-limiter.js';
import { CircuitBreaker, type CircuitBreakerConfig } from './circuit-breaker.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sandbox');

export interface SandboxConfig {
  agentId: string;
  paths: PathPolicy;
  commands: CommandPolicy;
  resources?: Partial<ResourcePolicy>;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
}

// Default sandbox for most agents
const DEFAULT_ALLOWED_COMMANDS = [
  'node', 'npm', 'npx', 'tsx', 'tsc',
  'git', 'cat', 'ls', 'head', 'tail', 'wc',
  'grep', 'rg', 'find', 'which',
  'echo', 'date', 'pwd',
  'vitest', 'jest', 'mocha',
  'python3', 'pip3',
];

export class SandboxManager {
  readonly agentId: string;
  readonly pathGuard: PathGuard;
  readonly commandGate: CommandGate;
  readonly resourceLimiter: ResourceLimiter;
  readonly circuitBreaker: CircuitBreaker;

  constructor(config: SandboxConfig) {
    this.agentId = config.agentId;
    this.pathGuard = new PathGuard(config.paths);
    this.commandGate = new CommandGate(config.commands);
    this.resourceLimiter = new ResourceLimiter(config.resources);
    this.circuitBreaker = new CircuitBreaker(config.agentId, config.circuitBreaker);
  }

  // Check if agent can execute anything
  canExecute(): boolean {
    return this.circuitBreaker.canExecute();
  }

  // Validate file path
  assertPath(path: string): void {
    this.pathGuard.assertValid(path);
  }

  // Validate command
  assertCommand(cmd: string, args: string[] = []): void {
    this.commandGate.assertValid(cmd, args);
  }

  // Check file size
  assertFileSize(size: number): void {
    this.resourceLimiter.checkFileSize(size);
  }

  // Get execution timeout
  getTimeout(): number {
    return this.resourceLimiter.getTimeout();
  }

  // Acquire/release action slot
  async acquireSlot(): Promise<() => void> {
    return this.resourceLimiter.acquireSlot();
  }

  // Record execution result
  recordSuccess(): void {
    this.circuitBreaker.recordSuccess();
  }

  recordFailure(error?: string): void {
    this.circuitBreaker.recordFailure(error);
  }

  toJSON() {
    return {
      agentId: this.agentId,
      circuitBreaker: this.circuitBreaker.toJSON(),
      activeActions: this.resourceLimiter.getActiveCount(),
    };
  }
}

// ─── Factory: Create sandbox for a provider ───────────
export function createSandbox(
  agentId: string,
  role: string,
  projectDir: string
): SandboxManager {
  const isCommander = role === 'Commander';

  return new SandboxManager({
    agentId,
    paths: {
      allowedPaths: [
        projectDir,
        '/tmp',
        ...(isCommander ? ['/home'] : []),
      ],
      deniedPaths: [
        '/etc', '/var', '/usr',
        `${projectDir}/node_modules`,
      ],
    },
    commands: {
      allowedCommands: isCommander ? [] : DEFAULT_ALLOWED_COMMANDS, // empty = allow all for Commander
      deniedCommands: [],
    },
    resources: {
      maxConcurrentActions: isCommander ? 8 : 4,
      maxExecutionTime: isCommander ? 300_000 : 120_000,
    },
  });
}
