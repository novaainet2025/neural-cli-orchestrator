import { PathGuard, type PathPolicy } from './path-guard.js';
import { CommandGate, type CommandPolicy } from './command-gate.js';
import { ResourceLimiter, type ResourcePolicy } from './resource-limiter.js';
import { CircuitBreaker, type CircuitBreakerConfig } from './circuit-breaker.js';
import { createLogger } from '../utils/logger.js';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

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
  'grep', 'rg', 'find', 'which', 'ps', 'pgrep',
  'echo', 'date', 'pwd',
  'mkdir', 'cp', 'mv', 'sed', 'awk',
  'vitest', 'jest', 'mocha',
  'python3', 'pip3',
  // curl: 검증 태스크의 로컬 API 확인(:6200/:11434 등)에 필수 — 차단 시 ollama
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

  getApiTimeout(): number {
    return this.resourceLimiter.getApiTimeout();
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
// (hermes는 2026-07-18 codex CLI로 전환 — codex와 동일하게 로컬 타임아웃 대상 아님)
const LOCAL_LLM_IDS = new Set(['ollama']);

export interface ProviderRuntimeHints {
  endpoint?: string | null;
}

/** Detect local/private inference endpoints without coupling policy to provider IDs. */
export function isLocalInferenceEndpoint(endpoint?: string | null): boolean {
  if (!endpoint?.trim()) return false;
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '::1' || hostname === 'host.docker.internal') {
      return true;
    }
    if (hostname.endsWith('.local') || /^127\./.test(hostname) || /^10\./.test(hostname)) {
      return true;
    }
    if (/^192\.168\./.test(hostname)) return true;
    const private172 = hostname.match(/^172\.(\d{1,2})\./);
    return private172 != null
      && Number(private172[1]) >= 16
      && Number(private172[1]) <= 31;
  } catch {
    return false;
  }
}

function canonicalRoot(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** @internal Exported for deterministic cross-platform path-policy tests. */
export function isSystemTemporaryProject(
  projectDir: string,
  systemTempDir = tmpdir(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  const projectRoot = canonicalRoot(projectDir);
  const systemTempRoot = canonicalRoot(systemTempDir);
  if (projectRoot === systemTempRoot || projectRoot.startsWith(`${systemTempRoot}/`)) {
    return true;
  }
  // A deliberately sanitized launch (`env -i`, PM2 filter_env, launchd) can
  // omit TMPDIR on macOS. Node then reports /tmp even though mkdtemp callers
  // and test harnesses use the host's canonical per-user temp root. Recognize
  // only Apple's narrow /private/var/folders/<2>/<hash>/T boundary; never
  // grant the broad /var tree.
  return platform === 'darwin'
    && systemTempRoot === canonicalRoot('/tmp')
    && /^\/private\/var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/.test(projectRoot);
}

/**
 * 에이전트가 쓸 수 있는 임시 디렉터리 루트를 정한다.
 *
 * **초판은 `allowedPaths` 에 `/tmp` 를 통째로 넣었다.** macOS 는 `os.tmpdir()` 이
 * `/var/folders/<hash>/T` 로 사용자별이라 이 구멍이 드러나지 않는다. 그런데 **Linux 는
 * `/tmp` 가 공유**라, 임시 디렉터리 안에 작업공간을 잡은 에이전트끼리 서로의 파일을
 * 전부 읽고 쓸 수 있다.
 *
 * kangnote 실측(2026-08-07, WSL2): Engineer 샌드박스에서 자기 프로젝트 ok=true,
 * **형제 디렉터리 ok=true, 남의 작업공간 `/tmp/other-agent-workspace/secret.txt` 도
 * ok=true** 였다. 패턴 기반 차단(홈의 `.ssh` 등)은 살아 있으므로 경로 루트 판정만
 * 넓어진 것이다.
 *
 * 그래서 공유 루트 대신 **에이전트별 하위 경로**만 연다. 자기 작업공간은 `projectRoot`
 * 로 이미 열려 있으므로 스크래치 용도에는 영향이 없다.
 *
 * 롤백: `NCO_SANDBOX_SHARED_TMP=1` 이면 예전처럼 공유 루트를 연다(재빌드 불필요).
 */
export function resolveAgentTempRoots(
  agentId: string,
  systemTempDir = tmpdir(),
  sharedToggle = process.env.NCO_SANDBOX_SHARED_TMP,
): string[] {
  const systemTempRoot = canonicalRoot(systemTempDir);
  if (sharedToggle === '1' || sharedToggle === 'true') {
    return [systemTempRoot, '/tmp'];
  }
  const safeAgentId = agentId.replace(/[^A-Za-z0-9_-]/g, '_');
  const roots = [`${systemTempRoot}/nco-${safeAgentId}`];
  // macOS 에서 `/tmp` 는 `/private/tmp` 심링크이고 tmpdir() 과 다를 수 있다.
  // 두 갈래 모두 자기 몫만 연다.
  const posixTempRoot = canonicalRoot('/tmp');
  if (posixTempRoot !== systemTempRoot) roots.push(`${posixTempRoot}/nco-${safeAgentId}`);
  return roots;
}

// ─── Factory: Create sandbox for a provider ───────────
export function createSandbox(
  agentId: string,
  role: string,
  projectDir: string,
  runtimeHints: ProviderRuntimeHints = {},
): SandboxManager {
  const isCommander = role === 'Commander';
  const isLocalInference = LOCAL_LLM_IDS.has(agentId)
    || isLocalInferenceEndpoint(runtimeHints.endpoint);
  const projectRoot = canonicalRoot(projectDir);
  const allowSystemTemporaryProject = isSystemTemporaryProject(projectRoot);

  const ncoRoot = '/home/nova/projects/neural-cli-orchestrator';
  return new SandboxManager({
    agentId,
    paths: {
      allowedPaths: [
        projectRoot,
        ncoRoot,
        ...resolveAgentTempRoots(agentId),
        '/Users/nova-ai/nova-cli',
        ...(isCommander ? ['/home', '/Users'] : []),
      ],
      deniedPaths: [
        '/etc', ...(allowSystemTemporaryProject ? [] : ['/var']), '/usr',
        `${projectRoot}/node_modules`,
        `${ncoRoot}/node_modules`,
      ],
    },
    commands: {
      allowedCommands: isCommander ? COMMANDER_ALLOWED_COMMANDS : DEFAULT_ALLOWED_COMMANDS,
      deniedCommands: [],
    },
    resources: {
      maxConcurrentActions: isCommander ? 8 : 4,
      // [2026-07-09] 로컬 LLM은 도구 사용+생성 조합에서 300s를 넘기는 케이스가 남아 있다.
      // 하드타임아웃을 360s로 완화하되 idle/hardcap 감시는 별도로 유지한다.
      maxExecutionTime: isCommander ? 300_000
        : isLocalInference ? 360_000
        : 120_000,
      // API 호출은 도구 실행보다 조금 더 짧게 끊어 경합 timeout 원인을 분리한다.
      maxApiRequestTime: isCommander ? 240_000
        : isLocalInference ? 300_000
        : 90_000,
    },
  });
}
