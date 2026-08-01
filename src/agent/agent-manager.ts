import {
  OrchestratedLoop,
  preferCursorFallbackModel,
  resolveCursorFallbackModel,
} from './orchestrated-loop.js';
import { ApiExecutor } from './api-executor.js';
import { createSandbox, type SandboxManager } from '../security/sandbox-manager.js';
import { verificationGate } from '../security/verification-gate.js';
import { circuitBreakerRegistry, classifyCircuitError } from '../security/circuit-breaker-registry.js';
import { eventBus } from '../core/event-bus.js';
import { sharedState } from '../core/shared-state.js';
import { taskQueue } from '../core/task-queue.js';
import { getDb } from '../storage/database.js';
import { getApiKeys, loadEnabledProviders, env, type ProviderConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { createTaskId } from '../utils/id.js';
import { OLLAMA_KEEP_ALIVE } from '../utils/ollama.js';
import { buildProviderProcessEnv } from './provider-process-env.js';
import { mergeMemoryContextEntries, resolveTeamMemoryScope } from '../core/task-memory-scope.js';
import {
  resolveProviderModel,
  resolveProviderRuntime,
  type ProviderExecutor,
} from '../core/provider-catalog.js';

const log = createLogger('agent-manager');

function promptSummary(s: string): boolean {
  return s.trim().length > 10;
}

function isSuccessfulResult(result: { failed?: boolean; exitCode?: number | null; timedOut?: boolean; isCanceled?: boolean }): boolean {
  return !result.failed && result.exitCode === 0 && !result.timedOut && !result.isCanceled;
}

function normalizeCliProbeOutput(output: string): string {
  // Keep recovery probes aligned with production CLI execution, where color
  // is disabled and any residual ANSI sequences are stripped before parsing.
  // eslint-disable-next-line no-control-regex
  return output.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').trim();
}

function getTaskTimeoutMs(): number {
  const v = Number(process.env.NCO_TASK_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 60_000 ? v : 3_600_000;
}

function resolveTaskTeamMemoryScope(taskId: string): string | null {
  try {
    const row = getDb().prepare('SELECT team_id FROM tasks WHERE id = ?').get(taskId) as
      | { team_id: string | null }
      | undefined;
    return resolveTeamMemoryScope(row?.team_id);
  } catch {
    return null;
  }
}

export function formatProviderUnavailableError(
  agentId: string,
  snapshot: { state: string; reason: string | null },
): string {
  return `provider_unavailable: ${agentId} (${snapshot.state}/${snapshot.reason ?? 'generic'})`;
}

const NON_CIRCUIT_CANCELLATION_RE =
  /(?:graceful shutdown|SIGINT|exit(?:ed| code)?[=: ]*130\b|(?:CLI|subprocess|loop) cancel(?:led|ed)|abort signal|AbortError|discussion_(?:quorum_reached|cancelled))/i;
const EXECUTION_TIMEOUT_RE = /(?:timed out|timeout\()/i;

/**
 * User/process cancellation is not provider-health evidence.
 *
 * PM2 sends SIGINT to the process group during a graceful reload. Some CLIs
 * expose that as exit 130 + "Aborting operation" without setting execa's
 * isCanceled flag, so task-queue normalization happens too late to stop this
 * catch path from incrementing the provider circuit. Timeouts remain relevant.
 */
export function isNonCircuitCancellation(
  error: unknown,
  abortReason?: string,
  shutdownSignal?: string,
): boolean {
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    canceled?: unknown;
  } | null;
  const signal = [
    abortReason ?? '',
    shutdownSignal ?? '',
    typeof candidate?.name === 'string' ? candidate.name : '',
    typeof candidate?.message === 'string' ? candidate.message : '',
  ].filter(Boolean).join('\n');

  if (EXECUTION_TIMEOUT_RE.test(signal)) return false;
  return Boolean(shutdownSignal)
    || abortReason === 'cancelled'
    || candidate?.canceled === true
    || NON_CIRCUIT_CANCELLATION_RE.test(signal);
}

export function classifyIncompleteAnswer(
  prompt: string,
  output: string,
): string | undefined {
  const normalizedPrompt = prompt.trim().toLowerCase();
  const normalizedOutput = output.trim();
  if (
    /(?:return|reply|respond)\s+exactly\s+unknown\b/i.test(normalizedPrompt)
    || /정확히\s*['"`]?unknown['"`]?(?:만|으로)?\s*(?:답|출력)/i.test(prompt)
  ) {
    return undefined;
  }
  if (/^unknown\b/i.test(normalizedOutput)) {
    return 'answer stopped at unknown without resolving the requested evidence';
  }
  if (
    normalizedOutput.length < 320
    && /^(?:(?:before|to)\b.{0,100}?\b)?(?:let me|i(?:'ll| will| need to))\s+(?:look|check|inspect|review|analy[sz]e|explore|read|scan|investigate|verify)\b/i.test(normalizedOutput)
  ) {
    return 'answer stopped at a future-intent preamble';
  }
  if (
    normalizedOutput.length < 320
    && (
      /^(?:먼저|우선|이제).{0,100}(?:살펴보겠|확인하겠|검토하겠|분석하겠|조사하겠|읽어보겠|탐색하겠)/.test(normalizedOutput)
      || /^(?:discussion|토론|분석|답변|제안).{0,30}(?:시작\s*전|전에).{0,120}(?:탐색|확인|검토|분석|조사|검증|파악)(?:하|해|하여)/i.test(normalizedOutput)
    )
  ) {
    return 'answer stopped at a future-intent preamble';
  }
  return undefined;
}

function killProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Execution behavior comes from the catalog descriptor, never provider IDs. */
export function classifyAgent(provider: ProviderConfig): ProviderExecutor {
  return resolveProviderRuntime(provider).executor;
}

interface TaskResult {
  taskId: string;
  agentId: string;
  output: string;
  iterations: number;
  toolCalls: number;
  success: boolean;
  error?: string;
  durationMs: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

class AgentManager {
  private static readonly QUOTA_PROBE_INTERVAL_MS = 10 * 60_000;
  private static readonly QUOTA_PROBE_TIMEOUT_MS = 10_000;
  private static readonly CLI_RECOVERY_PROBE_TIMEOUT_MS = 30_000;
  private sandboxes = new Map<string, SandboxManager>();
  private latencyHistory = new Map<string, number[]>();
  private providers = new Map<string, ProviderConfig>();
  private healthApiKeyCallCounts = new Map<string, number>();
  private lastQuotaProbeAt = new Map<string, number>();
  private cliRecoveryProbes = new Set<string>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  async init(): Promise<void> {
    const result = await this.reloadProviders();

    if (!this.healthTimer) this.healthTimer = setInterval(() => this.healthCheck(), 30_000);

    log.info({ count: result.current.length }, 'Agent Manager initialized');
  }

  /**
   * Stage a complete enabled roster and atomically swap admission maps.
   * Existing executions already captured their provider and sandbox references,
   * so removal blocks only new admission while in-flight work drains naturally.
   */
  async reloadProviders(next: readonly ProviderConfig[] = loadEnabledProviders()): Promise<{
    added: string[];
    updated: string[];
    removed: string[];
    draining: string[];
    current: string[];
  }> {
    const providers = next.filter(provider => provider.enabled !== false);
    const nextProviders = new Map<string, ProviderConfig>();
    const nextSandboxes = new Map<string, SandboxManager>();
    for (const provider of providers) {
      if (nextProviders.has(provider.id)) throw new Error(`duplicate provider id: ${provider.id}`);
      nextProviders.set(provider.id, provider);
      nextSandboxes.set(provider.id, createSandbox(provider.id, provider.role, env.PROJECT_DIR));
    }

    this.injectDerivedKeys(nextProviders);
    await circuitBreakerRegistry.restore([...nextProviders.keys()]);

    const previous = this.providers;
    const added = [...nextProviders.keys()].filter(id => !previous.has(id));
    const removed = [...previous.keys()].filter(id => !nextProviders.has(id));
    const updated = [...nextProviders.keys()].filter(id => {
      const before = previous.get(id);
      return !!before && JSON.stringify(before) !== JSON.stringify(nextProviders.get(id));
    });

    this.providers = nextProviders;
    this.sandboxes = nextSandboxes;
    for (const id of removed) {
      this.latencyHistory.delete(id);
      this.lastQuotaProbeAt.delete(id);
      this.cliRecoveryProbes.delete(id);
      for (const key of this.healthApiKeyCallCounts.keys()) {
        if (key.startsWith(`${id}:`)) this.healthApiKeyCallCounts.delete(key);
      }
    }
    log.info({ added, updated, removed, count: nextProviders.size }, 'Agent Manager roster swapped');
    return { added, updated, removed, draining: removed, current: [...nextProviders.keys()] };
  }

  // Inject derived API keys for CLIs whose native env var naming differs from
  // NCO's rotation convention. Aider reads OPENROUTER_API_KEY (singular); we
  // store OPENROUTER_API_KEYS (plural, comma-separated). Pick the first key.
  private injectDerivedKeys(providers = this.providers): void {
    const aider = [...providers.values()]
      .find(provider => resolveProviderRuntime(provider).adapter === 'aider');
    if (aider && !aider.env?.OPENROUTER_API_KEY) {
      const keys = process.env.OPENROUTER_API_KEYS;
      if (keys) {
        aider.env = { ...aider.env, OPENROUTER_API_KEY: keys.split(',')[0].trim() };
      }
    }
  }

  async executeTask(agentId: string, prompt: string, options?: {
    taskId?: string;
    systemPrompt?: string;
    compact?: boolean;
    model?: string;
    signal?: AbortSignal;
    projectDir?: string;
    timeoutMs?: number;
    localNetworkAccess?: boolean;
  }): Promise<TaskResult> {
    const provider = this.providers.get(agentId);
    if (!provider) throw new Error(`Unknown agent: ${agentId}`);

    const taskId = options?.taskId || createTaskId();
    const effectiveModel = resolveProviderModel(provider, options?.model);
    const originalPrompt = prompt;
    const teamMemoryScope = resolveTaskTeamMemoryScope(taskId);
    const startTime = Date.now();

    // [projectDir 백스톱] 내부 호출부(discussion/parallel/hive/message 등)가 projectDir 를 빠뜨려도
    // codex(Type B, assertTaskProjectDir)가 즉시 실패하지 않도록 env.PROJECT_DIR 로 기본값 채움.
    // 외부 /api/task 는 task-intake 에서 projectDir 를 필수 검증하므로 이 기본값의 영향 없음(내부 전용).
    const effectiveProjectDir = options?.projectDir || env.PROJECT_DIR;
    const admissionSandbox = this.sandboxes.get(agentId)!;
    // Provider sandbox는 서버 시작 시 env.PROJECT_DIR 하나로 만들어진다. 다른 repository를
    // 명시한 conductor/task에서 그 인스턴스를 재사용하면 실행 cwd는 맞아도 readFile/listFiles가
    // PathGuard에 막힌다. 회로차단 admission은 장기 인스턴스에 유지하고, 파일·명령 정책만
    // 해당 task의 projectDir를 루트로 갖는 task-scoped sandbox로 격리한다.
    const executionSandbox = effectiveProjectDir === env.PROJECT_DIR
      ? admissionSandbox
      : createSandbox(agentId, provider.role, effectiveProjectDir);

    if (!admissionSandbox.canExecute()) {
      const snapshot = circuitBreakerRegistry.getSnapshot(agentId);
      return {
        taskId,
        agentId,
        output: '',
        iterations: 0,
        toolCalls: 0,
        success: false,
        error: formatProviderUnavailableError(agentId, snapshot),
        durationMs: 0,
      };
    }

    // P0-3: canExecute()가 true를 반환한 직후 상태가 여전히 half-open이면 이 호출이 유일한
    // 프로브 슬롯을 실제로 획득한 것이다(closed 경로는 슬롯을 소모하지 않으므로 반납 대상이
    // 아니다). slotHeld로 가드해 finally에서 실제 획득한 경로에서만 반납 — 가드 없이 무조건
    // 반납하면 카운터가 음수로 내려가 이후 half-open 프로브 제한이 무력화된다.
    const slotHeld = circuitBreakerRegistry.getSnapshot(agentId).state === 'half-open';

    const timeoutMs = options?.timeoutMs ?? getTaskTimeoutMs();
    const wallClock = AbortSignal.timeout(timeoutMs);
    const signal = options?.signal
      ? AbortSignal.any([options.signal, wallClock])
      : wallClock;
    if (slotHeld && !circuitBreakerRegistry.bindProbeSlot(agentId, signal)) {
      circuitBreakerRegistry.releaseProbeSlot(agentId, signal);
      const snapshot = circuitBreakerRegistry.getSnapshot(agentId);
      return {
        taskId,
        agentId,
        output: '',
        iterations: 0,
        toolCalls: 0,
        success: false,
        error: formatProviderUnavailableError(agentId, snapshot),
        durationMs: Date.now() - startTime,
      };
    }

    try {
      // Publish task start
      await eventBus.publish({
        type: 'task:started', taskId, agentId,
      });

      const agentType = classifyAgent(provider);
      let output: string;
      let iterations = 0;
      let toolCalls = 0;
      let usage: TaskResult['usage'];
      taskQueue.recordActivity(taskId);

      // compact 호출(토론 R1/R2 등)은 즉시 응답 수집이 목적이다. 일반 task용 HNSW
      // recall을 수행하면 혼잡 시 모델 호출 전에 상한을 소모하고 프롬프트도 불필요하게
      // 팽창하므로 생략한다. 일반 작업의 장기기억 경로는 그대로 유지한다.
      if (!options?.compact) {
        try {
          const { vectorMemory } = await import('../core/vector-memory.js');
          const personalMemories = await vectorMemory.search(agentId, prompt, 5);
          const teamMemories = teamMemoryScope
            ? await vectorMemory.search(teamMemoryScope, prompt, 5)
            : [];
          const memories = mergeMemoryContextEntries(
            [personalMemories, teamMemories],
            5,
          );
          if (memories.length > 0) {
            const ctx = memories
              .map(m => `- [score:${m.score.toFixed(2)}${m.semantic ? ',sem' : ',bm25'}] ${m.content.slice(0, 300)}`)
              .join('\n');
            prompt = prompt + `\n\n[장기 기억 컨텍스트 (자동 검색됨)]\n${ctx}\n`;
            log.debug(
              { agentId, teamMemoryScope, memCount: memories.length, semantic: memories[0]?.semantic },
              'memory context injected',
            );
          }
        } catch { /* non-critical */ }
      }

      switch (agentType) {
        case 'native-cli': {
          // Type A: Claude Code native — delegate to subprocess, monitor only
          const { execa } = await import('execa');
          const subprocess = execa(provider.command!, [
            ...(provider.args ?? []),
            ...(effectiveModel ? ['--model', effectiveModel] : []),
            '-p', prompt,
            '--output-format', 'text',
          ], {
            cwd: effectiveProjectDir,
            cancelSignal: signal,
            forceKillAfterDelay: 3000, // SIGKILL 3s after SIGTERM if still alive
            detached: process.platform !== 'win32',
            // NCO 재귀보호 (2026-06-30, fleet 6a748e4): 서브에이전트 claude가 NCO 훅 재트리거 → 무한재귀 방지
            env: { 
              ...process.env, 
              ...provider.env, 
              NCO_HOOK_DISABLED: '1',
              PROJECT_DIR: effectiveProjectDir,
            },
            reject: false,
            stdin: 'ignore', // stdin을 닫아서 "no stdin data" 경고 방지
          });
          taskQueue.recordChildProcess(taskId, subprocess.pid);
          subprocess.stdout?.on('data', chunk => taskQueue.recordActivity(taskId, chunk.toString()));
          subprocess.stderr?.on('data', chunk => taskQueue.recordActivity(taskId, chunk.toString()));
          signal.addEventListener('abort', () => killProcessGroup(subprocess.pid), { once: true });
          const result = await subprocess;
          output = result.stdout || result.stderr || taskQueue.getBufferedOutput(taskId);
          if (!isSuccessfulResult(result)) {
            const timedOut = Boolean((result as { timedOut?: boolean }).timedOut);
            const isCanceled = Boolean((result as { isCanceled?: boolean }).isCanceled);
            const reason = isCanceled
              ? timedOut ? 'subprocess timed out' : 'subprocess cancelled'
              : `subprocess exited with code ${result.exitCode ?? 'unknown'}`;
            const detail = output.trim() || result.shortMessage || 'no process output';
            throw new Error(`${reason}: ${detail}`);
          }
          iterations = 1;
          break;
        }

        case 'orchestrated-cli': {
          // Type B: NCO orchestrated loop
          const loop = new OrchestratedLoop(provider, executionSandbox, signal);
          const result = await loop.run(taskId, prompt, {
            systemPrompt: options?.systemPrompt,
            compact: options?.compact,
            model: effectiveModel ?? undefined,
            projectDir: effectiveProjectDir,
            localNetworkAccess: options?.localNetworkAccess,
          });
          output = result.output;
          iterations = result.iterations;
          toolCalls = result.toolCalls;
          if (result.success === false) {
            const loopError = new Error(result.error || 'orchestrated loop reported failure');
            (loopError as Error & { partialOutput?: string }).partialOutput = result.output;
            throw loopError;
          }
          break;
        }

        case 'openai-api': {
          // Type C: API executor
          const executor = new ApiExecutor(provider, executionSandbox);
          const result = await executor.run(taskId, prompt, {
            systemPrompt: options?.systemPrompt,
            compact: options?.compact,
            model: effectiveModel ?? undefined,
            projectDir: effectiveProjectDir,
            signal,
            timeoutMs,
          });
          output = result.output;
          iterations = result.iterations;
          toolCalls = result.toolCalls;
          usage = result.usage;
          // credential preflight 등 executor가 명시한 실패를 completed로 흘리지 않는다
          if (result.success === false) {
            throw new Error(result.error || 'api executor reported failure');
          }
          break;
        }
      }

      const durationMs = Date.now() - startTime;
      this.recordLatency(agentId, durationMs);

      // 성공 출력의 실패패턴 분류는 짧은 출력(<300자)에만 적용 — 긴 기술 출력(diff·문서)이
      // 에러 문자열을 *인용*만 해도 서킷이 트립되는 오탐 방지 (2026-07-03 codex auth 오픈 실측:
      // v1.1 diff 본문의 'credential preflight failed' 리터럴에 트립됨)
      const classified = output.trim().length < 300 ? classifyCircuitError(output) : null;
      if (classified) {
        circuitBreakerRegistry.recordFailure(agentId, output);
        return {
          taskId,
          agentId,
          output,
          iterations,
          toolCalls,
          success: false,
          error: `Provider failure detected: ${classified.reason}`,
          durationMs,
        };
      }
      const incompleteAnswer = classifyIncompleteAnswer(originalPrompt, output);
      if (incompleteAnswer) {
        const failure = new Error(`silent-failure: ${incompleteAnswer}`);
        (failure as Error & { partialOutput?: string }).partialOutput = output;
        throw failure;
      }

      circuitBreakerRegistry.recordSuccess(agentId);

      // compact 토론 제안은 코드 산출 작업이 아니므로 저장소 전체 diff 검증을 붙이지 않는다.
      // 회사의 실제 stage task 및 최종 Nova-AX 감사 게이트에는 영향을 주지 않는다.
      if (!options?.compact) {
        try {
          const { stdout: diffOutput } = await (await import('execa')).execa(
            'git', ['diff', '--name-only'], { cwd: env.PROJECT_DIR, reject: false }
          );
          const changedFiles = diffOutput.split('\n').filter(Boolean);

          if (changedFiles.length > 0) {
            const vResult = await verificationGate.verify(taskId, changedFiles);
            if (!vResult.passed) {
              log.warn({ taskId, agentId, results: vResult.results }, 'Verification gate failed');
              await eventBus.publish({
                type: 'task:verification_failed', taskId, agentId,
                results: vResult.results, durationMs,
              });
            }
          }
        } catch (verifyErr: any) {
          log.debug({ err: verifyErr.message }, 'Verification gate skipped');
        }
      }

      await eventBus.publish({
        type: 'task:completed', taskId, agentId,
        output: output.slice(0, 1000),
        iterations, toolCalls, durationMs,
      });

      if (!options?.compact) {
        // Auto-extract knowledge from task result
        try {
          const { knowledgeBase } = await import('../core/knowledge-base.js');
          knowledgeBase.extractFromTaskResult(taskId, output, env.PROJECT_DIR);
        } catch { /* non-critical */ }

        // ── HNSW Vector Memory: Post-task storage ────────────
        try {
          const { vectorMemory } = await import('../core/vector-memory.js');
          // Store: task prompt (context) + output summary
          const promptSnippet = prompt.slice(0, 200).replace(/\[장기 기억 컨텍스트[\s\S]*?\]/m, '').trim();
          const outputSummary = output.replace(/\s+/g, ' ').trim().slice(0, 400);
          if (promptSummary(promptSnippet)) {
            const memory = `[${taskId}] Q: ${promptSnippet} → A: ${outputSummary}`;
            await vectorMemory.add(agentId, memory, 1.0);
            if (teamMemoryScope) {
              await vectorMemory.add(teamMemoryScope, memory, 1.0);
            }
          }
        } catch { /* non-critical */ }
      }

      // ── AgentEvolver: record success for persona tuning ─
      try {
        const { agentEvolver } = await import('../core/agent-evolver.js');
        agentEvolver.record(agentId, taskId, true, durationMs, output.length);
      } catch { /* non-critical */ }

      return { taskId, agentId, output, iterations, toolCalls, success: true, durationMs, usage };

    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const abortReason = taskQueue.getAbortReason(taskId);
      const shutdownSignal = taskQueue.getShutdownSignal(taskId);
      const partialOutput = taskQueue.getBufferedOutput(taskId);
      const errorMessage = abortReason || err?.message || 'unknown: execution failed';
      const terminalOutput = partialOutput || (err as { partialOutput?: string } | undefined)?.partialOutput || '';
      if (!isNonCircuitCancellation(err, abortReason, shutdownSignal)) {
        // terminalOutput(= tasks.response로 저장되는 값)을 함께 넘긴다. CLI 프로바이더의
        // HTTP 401 신호는 errorMessage(execa shortMessage = 명령 에코)에 없고 stdout 오류
        // 봉투에만 있어, 이 인자가 없으면 인증 실패가 generic 3연속 임계치로 떨어진다.
        // 분류 규칙·근거·롤백(NCO_CB_ERROR_ENVELOPE=off)은 circuit-breaker-registry.ts 참조.
        circuitBreakerRegistry.recordFailure(agentId, errorMessage, undefined, terminalOutput);
      } else {
        log.info(
          { taskId, agentId, error: errorMessage },
          'Skipped circuit failure for cancelled execution',
        );
      }

      // 상태 복구 — 실패/타임아웃 시 idle로 복원
      await sharedState.setAgentState(agentId, {
        status: 'idle',
        currentTask: null,
        currentFiles: [],
      });

      await eventBus.publish({
        type: 'task:failed', taskId, agentId,
        error: errorMessage, durationMs,
      });
      this.recordLatency(agentId, durationMs);

      // ── AgentEvolver: record failure ──────────────────────
      try {
        const { agentEvolver } = await import('../core/agent-evolver.js');
        agentEvolver.record(agentId, taskId, false, durationMs, 0);
      } catch { /* non-critical */ }

      return {
        taskId,
        agentId,
        output: terminalOutput,
        iterations: 0,
        toolCalls: 0,
        success: false,
        error: errorMessage,
        durationMs,
      };
    } finally {
      // P0-3: 실제로 획득한 half-open 프로브 슬롯만 반납(slotHeld 가드) — 성공/실패/throw
      // 어느 경로로 끝나든 반드시 실행되어야 다음 canExecute() 호출이 새 프로브를 시도할 수 있다.
      if (slotHeld) circuitBreakerRegistry.releaseProbeSlot(agentId, signal);
    }
  }

  // ─── Latency tracking ───────────────────────────────
  private recordLatency(agentId: string, ms: number): void {
    const hist = this.latencyHistory.get(agentId) ?? [];
    hist.push(ms);
    if (hist.length > 100) hist.shift();
    this.latencyHistory.set(agentId, hist);
  }

  getP95Latency(agentId: string): number {
    const hist = this.latencyHistory.get(agentId);
    if (!hist || hist.length === 0) return 30_000;
    const sorted = [...hist].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
  }

  async probeProvider(
    agentId: string,
    prompt = 'PING',
    timeoutMs = 30_000,
    model?: string,
  ): Promise<boolean> {
    const provider = this.providers.get(agentId);
    if (!provider) return false;

    try {
      if (provider.type === 'api') {
        const url = this.resolveApiHealthCheckUrl(provider);
        if (!url) return false;

        const apiKeyRef = provider.keyRotation?.enabled
          ? provider.keyRotation.envVar
          : provider.apiKeyRef;
        const apiKey = apiKeyRef
          ? this.getNextHealthApiKey(agentId, apiKeyRef, 'active-probe')
          : undefined;
        const response = await fetch(url, {
          method: 'GET',
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        return response.ok;
      }

      if (!provider.command) return false;
      const { execa } = await import('execa');
      const result = await execa(provider.command, this.buildProbeArgs(provider, prompt, model), {
        cwd: (await import('node:os')).tmpdir(),
        env: {
          ...buildProviderProcessEnv(
            provider.id,
            provider.env,
            process.env,
            undefined,
            resolveProviderRuntime(provider).adapter,
          ),
          NCO_HOOK_DISABLED: '1',
          NO_COLOR: '1',
          TERM: 'dumb',
        },
        reject: false,
        stdin: 'ignore',
        timeout: timeoutMs,
      });
      const processSucceeded = result.exitCode === 0
        && !result.failed
        && !result.timedOut
        && !result.isCanceled;
      if (
        processSucceeded
        && resolveProviderRuntime(provider).adapter === 'cursor'
        && prompt === 'Reply exactly: NCO_PROVIDER_PROBE_OK'
      ) {
        return normalizeCliProbeOutput(result.stdout) === 'NCO_PROVIDER_PROBE_OK';
      }
      return processSucceeded;
    } catch {
      return false;
    }
  }

  private buildProbeArgs(provider: ProviderConfig, prompt: string, model?: string): string[] {
    const runtime = resolveProviderRuntime(provider);
    switch (runtime.adapter) {
      case 'claude':
        return [...provider.args, '-p', prompt, '--output-format', 'text'];
      case 'codex':
        return runtime.profile === 'readonly-tool-worker'
          ? [...provider.args, 'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', ...(provider.model ? ['-m', provider.model] : []), prompt]
          : [...provider.args, 'exec', '--ephemeral', '--skip-git-repo-check', prompt];
      case 'cursor':
        return [
          ...provider.args,
          '--print',
          '--trust',
          ...(model ? ['--model', model] : []),
          '--output-format',
          'text',
          prompt,
        ];
      default:
        return [...provider.args, prompt];
    }
  }

  // ─── Health Monitor ─────────────────────────────────
  private async healthCheck(): Promise<void> {
    for (const [id, provider] of this.providers) {
      if (provider.type === 'api') {
        const healthOk = await this.healthCheckApiProvider(id, provider);
        if (!healthOk) {
          continue;
        }
        const availability = circuitBreakerRegistry.getAvailability(id);
        // quota·rate-limit 게이트 복구는 completions 실증만 신뢰 (헬스 200으로 열지 않음 — 리뷰 LOW)
        if (availability.status === 'probe'
          && (availability.reason === 'quota' || availability.reason === 'rate-limit')) {
          await this.probeGatedProvider(id, provider);
        }
        continue;
      }
      const alive = await sharedState.isAgentAlive(id);
      if (!alive) {
        await sharedState.setAgentState(id, { status: 'offline' });
      } else {
        const st = await sharedState.getAgentState(id);
        if (st?.status === 'offline') {
          await sharedState.setAgentState(id, { status: 'idle' });
        }
      }
      const availability = circuitBreakerRegistry.getAvailability(id);
      if (
        this.supportsCliRecoveryProbe(id, provider)
        && availability.status === 'probe'
        && availability.reason !== 'auth'
      ) {
        await this.probeGatedCliProvider(id);
      }
      await sharedState.heartbeat(id);
    }
  }

  /**
   * half-open 고착 회로의 자가복구 프로브 대상 판정.
   *
   * getAvailability()가 half-open을 available:false 로 보고하므로 게이트웨이 라우팅
   * (listAvailableProviders 등)은 해당 프로바이더를 절대 선택하지 않는다. 그런데
   * closed 로 가는 유일한 경로인 recordSuccess()는 실제 실행을 요구한다 → 실행이
   * 도달할 수 없어 영구 데드락이 된다. 5분 주기 reclaim 은 openedAt 만 재갱신하는
   * no-op 이라 탈출구가 되지 못한다(2026-07-29 T1: opencode 06:08Z~, codex 10:00Z~
   * 각각 6시간·2시간 고착, decision_log reclaim 76건+).
   *
   * 따라서 이 헬스체크 프로브가 유일한 탈출구다. cursor-agent 전용이던 대상을
   * orchestrated CLI 전체로 넓힌다. claude-code(Type A native)는 프로브 1회가 곧
   * 세션 1개 비용이라 제외한다. API 프로바이더는 위쪽 probeGatedProvider 분기가
   * 담당한다(quota·rate-limit 한정 — completions 실증만 신뢰). CLI 역시 실제
   * 응답만 복구 증거로 인정하므로 generic뿐 아니라 만료된 quota·rate-limit도
   * 여기서 프로브한다. auth는 cooldown 자체가 없고 자가복구 대상도 아니다.
   */
  private supportsCliRecoveryProbe(id: string, provider: ProviderConfig): boolean {
    void id;
    return resolveProviderRuntime(provider).executor === 'orchestrated-cli';
  }

  private async probeGatedCliProvider(id: string): Promise<void> {
    if (this.cliRecoveryProbes.has(id)) return;
    const sandbox = this.sandboxes.get(id);
    if (!sandbox || !sandbox.canExecute()) return;

    const slotHeld = circuitBreakerRegistry.getSnapshot(id).state === 'half-open';
    if (!slotHeld) return;

    const controller = new AbortController();
    if (!circuitBreakerRegistry.bindProbeSlot(id, controller.signal)) {
      circuitBreakerRegistry.releaseProbeSlot(id, controller.signal);
      return;
    }
    this.cliRecoveryProbes.add(id);
    try {
      const recoveryReason = circuitBreakerRegistry.getSnapshot(id).reason;
      const fallbackModel = resolveProviderRuntime(this.providers.get(id)!).adapter === 'cursor'
        ? resolveCursorFallbackModel()
        : null;
      const recovered = await this.probeProvider(
        id,
        'Reply exactly: NCO_PROVIDER_PROBE_OK',
        AgentManager.CLI_RECOVERY_PROBE_TIMEOUT_MS,
        fallbackModel ?? undefined,
      );
      if (recovered) {
        if (fallbackModel) preferCursorFallbackModel(fallbackModel);
        circuitBreakerRegistry.recordSuccess(id);
      } else {
        // Preserve the original classified cooldown. Reclassifying an expired
        // quota/rate-limit probe failure as generic would create a tight retry
        // loop and spend provider calls every generic cooldown interval.
        const failureSignal = recoveryReason === 'quota'
          ? 'CLI recovery probe failed: quota'
          : recoveryReason === 'rate-limit'
            ? 'CLI recovery probe failed: rate limit'
            : 'CLI recovery probe failed';
        circuitBreakerRegistry.recordFailure(id, failureSignal);
      }
      await eventBus.publish({
        type: 'provider:recovery-probe',
        agentId: id,
        success: recovered,
        model: fallbackModel ?? 'default',
      });
    } finally {
      controller.abort();
      circuitBreakerRegistry.releaseProbeSlot(id, controller.signal);
      this.cliRecoveryProbes.delete(id);
    }
  }

  private async healthCheckApiProvider(id: string, provider: ProviderConfig): Promise<boolean> {
    // NCO 긴급가드 (2026-06-30, fleet 2740be4): healthCheck 필드 없는 provider TypeError crash-loop 방지
    const url = this.resolveApiHealthCheckUrl(provider);
    if (!url) {
      await sharedState.setAgentState(id, { status: 'offline' });
      return false;
    }
    const timeout = typeof provider.healthCheck.timeout === 'number'
      ? provider.healthCheck.timeout
      : 5000;
    const headers: Record<string, string> = {};
    const apiKey = provider.apiKeyRef ? this.getNextHealthApiKey(id, provider.apiKeyRef) : undefined;
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        const body = await response.text();
        circuitBreakerRegistry.recordFailure(id, `HTTP ${response.status}: ${body}`);
        await sharedState.setAgentState(id, { status: 'offline' });
        return false;
      }
      const availability = circuitBreakerRegistry.getAvailability(id);
      // 헬스 GET 200은 generic 게이트 복구 증거로만 충분 — quota/rate-limit은
      // /health 200이어도 completions가 여전히 막혀 있을 수 있어 전용 프로브가 닫는다 (리뷰 LOW)
      if (availability.status === 'probe'
        && availability.reason !== 'quota' && availability.reason !== 'rate-limit') {
        circuitBreakerRegistry.recordSuccess(id);
      }
      await sharedState.setAgentState(id, { status: 'idle' });
      await sharedState.heartbeat(id);
      return true;
    } catch (e) {
      circuitBreakerRegistry.recordFailure(id, e instanceof Error ? e.message : String(e));
      await sharedState.setAgentState(id, { status: 'offline' });
      log.debug({
        id,
        error: e instanceof Error ? e.message : String(e),
      }, 'API health probe failed');
      return false;
    }
  }

  private resolveApiHealthCheckUrl(provider: ProviderConfig): string | null {
    if (typeof provider.endpoint === 'string' && provider.endpoint.length > 0) {
      try {
        const endpointUrl = new URL(provider.endpoint);
        const normalizedPath = endpointUrl.pathname.replace(/\/+$/, '');
        endpointUrl.pathname = normalizedPath.endsWith('/v1')
          ? `${normalizedPath}/models`
          : `${normalizedPath}/v1/models`;
        endpointUrl.search = '';
        endpointUrl.hash = '';
        return endpointUrl.toString();
      } catch {
        // Fall through to explicit healthCheck URL if endpoint is malformed.
      }
    }
    return typeof provider.healthCheck?.url === 'string' ? provider.healthCheck.url : null;
  }

  private getNextHealthApiKey(
    providerId: string,
    envVar: string,
    purpose: 'health' | 'gated-probe' | 'active-probe' = 'health',
  ): string | undefined {
    const keys = getApiKeys(envVar);
    if (keys.length === 0) {
      return undefined;
    }
    // 카운터를 providerId+envVar+purpose로 분리 — 헬스 GET과 프로브 POST가 서로 다른
    // 키 배열을 같은 카운터로 돌면 로테이션이 편향된다 (리뷰 MED)
    const counterKey = `${providerId}:${envVar}:${purpose}`;
    const callCount = this.healthApiKeyCallCounts.get(counterKey) ?? 0;
    const key = keys[callCount % keys.length];
    this.healthApiKeyCallCounts.set(counterKey, callCount + 1);
    return key;
  }

  private async probeGatedProvider(id: string, provider: ProviderConfig): Promise<void> {
    const now = Date.now();
    const lastProbeAt = this.lastQuotaProbeAt.get(id) ?? 0;
    if (now - lastProbeAt < AgentManager.QUOTA_PROBE_INTERVAL_MS) {
      return;
    }
    this.lastQuotaProbeAt.set(id, now);

    const baseUrl = provider.endpoint || provider.apiConfig?.primary.baseUrl;
    if (!baseUrl) {
      circuitBreakerRegistry.recordFailure(id, 'quota probe unavailable: missing provider endpoint');
      return;
    }

    const probeUrl = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const apiKeyRef = provider.keyRotation?.enabled
      ? provider.keyRotation.envVar
      : provider.apiKeyRef;
    const apiKey = apiKeyRef ? this.getNextHealthApiKey(id, apiKeyRef, 'gated-probe') : undefined;
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    try {
      const response = await fetch(probeUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: provider.model || provider.apiConfig?.primary.model || 'default',
          messages: [{ role: 'user', content: 'ping' }],
          ...(provider.type === 'local' ? { keep_alive: OLLAMA_KEEP_ALIVE } : {}),
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(AgentManager.QUOTA_PROBE_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = await response.text();
        circuitBreakerRegistry.recordFailure(id, `HTTP ${response.status}: ${body}`);
        return;
      }
      circuitBreakerRegistry.recordSuccess(id);
    } catch (error) {
      circuitBreakerRegistry.recordFailure(id, error instanceof Error ? error.message : String(error));
    }
  }

  // ─── Getters ────────────────────────────────────────
  getProvider(id: string): ProviderConfig | undefined {
    return this.providers.get(id);
  }

  getSandbox(id: string): SandboxManager | undefined {
    return this.sandboxes.get(id);
  }

  listProviders(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  listEnabledIds(): string[] {
    return Array.from(this.providers.keys());
  }

  destroy(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }
}

export const agentManager = new AgentManager();
