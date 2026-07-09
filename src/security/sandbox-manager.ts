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
  // curl: 검증 태스크의 로컬 API 확인(:6200/:11434 등)에 필수 — 차단 시 hermes/ollama
  // 검증이 "Command not in allowlist"로 실패 (2026-07-08 실측). node/python3가 이미
  // 허용이라 curl 추가는 신규 네트워크 권한이 아님.
  'curl',
];

const COMMANDER_ALLOWED_COMMANDS = [
  ...DEFAULT_ALLOWED_COMMANDS,
  'sed', 'awk', 'sort', 'uniq', 'cut', 'xargs',
  'mkdir', 'cp', 'mv', 'touch',
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

// 로컬 추론 프로바이더 — 프롬프트 처리+생성이 클라우드 API보다 느려 별도 타임아웃 필요
const LOCAL_LLM_IDS = new Set(['mlx', 'mlx-instruct', 'hermes', 'ollama']);

// ─── Factory: Create sandbox for a provider ───────────
export function createSandbox(
  agentId: string,
  role: string,
  projectDir: string
): SandboxManager {
  const isCommander = role === 'Commander';

  const ncoRoot = '/home/nova/projects/neural-cli-orchestrator';
  return new SandboxManager({
    agentId,
    paths: {
      allowedPaths: [
        projectDir,
        ncoRoot,
        '/tmp',
        '/Users/nova-ai/nova-cli',
        ...(isCommander ? ['/home', '/Users'] : []),
      ],
      deniedPaths: [
        '/etc', '/var', '/usr',
        `${projectDir}/node_modules`,
        `${ncoRoot}/node_modules`,
      ],
    },
    commands: {
      allowedCommands: isCommander ? COMMANDER_ALLOWED_COMMANDS : DEFAULT_ALLOWED_COMMANDS,
      deniedCommands: [],
    },
    resources: {
      maxConcurrentActions: isCommander ? 8 : 4,
      // [2026-07-09] 로컬 LLM(mlx 등)은 프롬프트 처리+생성에 120s를 상시 초과
      // (mlx 역대 평균 170s) → "Request timed out" 실패 누적의 근본 원인. 360s로 확대.
      maxExecutionTime: isCommander ? 300_000
        : LOCAL_LLM_IDS.has(agentId) ? 360_000
        : 120_000,
    },
  });
}
