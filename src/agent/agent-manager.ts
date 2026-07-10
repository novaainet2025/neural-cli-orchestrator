import { OrchestratedLoop } from './orchestrated-loop.js';
import { ApiExecutor } from './api-executor.js';
import { createSandbox, type SandboxManager } from '../security/sandbox-manager.js';
import { verificationGate } from '../security/verification-gate.js';
import { circuitBreakerRegistry, classifyCircuitError } from '../security/circuit-breaker-registry.js';
import { eventBus } from '../core/event-bus.js';
import { sharedState } from '../core/shared-state.js';
import { taskQueue } from '../core/task-queue.js';
import { getApiKeys, loadEnabledProviders, env, type ProviderConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { createTaskId } from '../utils/id.js';

const log = createLogger('agent-manager');

function promptSummary(s: string): boolean {
  return s.trim().length > 10;
}

function isSuccessfulResult(result: { failed?: boolean; exitCode?: number | null; timedOut?: boolean; isCanceled?: boolean }): boolean {
  return !result.failed && result.exitCode === 0 && !result.timedOut && !result.isCanceled;
}

function getTaskTimeoutMs(): number {
  const v = Number(process.env.NCO_TASK_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 60_000 ? v : 1_200_000;
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

// ─── Agent Type Classification ────────────────────────
// Type A: Native agent (claude-code) — has its own agent loop
// Type B: Orchestrated (codex, aider, opencode, cursor-agent, copilot) — NCO external loop
// Type C: API (ollama, openrouter) — OpenAI-compatible API

type AgentType = 'A' | 'B' | 'B_SINGLE_PROMPT' | 'C';

function classifyAgent(provider: ProviderConfig): AgentType {
  if (provider.id === 'claude-code') return 'A';
  if (provider.type === 'api') return 'C';
  if (provider.id === 'higgsfield') return 'B_SINGLE_PROMPT';
  return 'B';
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
  private sandboxes = new Map<string, SandboxManager>();
  private latencyHistory = new Map<string, number[]>();
  private providers = new Map<string, ProviderConfig>();
  private healthApiKeyCallCounts = new Map<string, number>();
  private lastQuotaProbeAt = new Map<string, number>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  async init(): Promise<void> {
    const providers = loadEnabledProviders();
    const projectDir = env.PROJECT_DIR;

    for (const p of providers) {
      this.providers.set(p.id, p);
      this.sandboxes.set(p.id, createSandbox(p.id, p.role, projectDir));
    }

    this.injectDerivedKeys();
    await circuitBreakerRegistry.restore(providers.map(provider => provider.id));

    // Start health monitor (30s)
    this.healthTimer = setInterval(() => this.healthCheck(), 30_000);

    log.info({ count: providers.length }, 'Agent Manager initialized');
  }

  // Inject derived API keys for CLIs whose native env var naming differs from
  // NCO's rotation convention. Aider reads OPENROUTER_API_KEY (singular); we
  // store OPENROUTER_API_KEYS (plural, comma-separated). Pick the first key.
  private injectDerivedKeys(): void {
    const aider = this.providers.get('aider');
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
    signal?: AbortSignal;
    projectDir?: string;
    timeoutMs?: number;
  }): Promise<TaskResult> {
    const provider = this.providers.get(agentId);
    if (!provider) throw new Error(`Unknown agent: ${agentId}`);

    const sandbox = this.sandboxes.get(agentId)!;
    const taskId = options?.taskId || createTaskId();
    const startTime = Date.now();

    if (!sandbox.canExecute()) {
      const snapshot = circuitBreakerRegistry.getSnapshot(agentId);
      return {
        taskId,
        agentId,
        output: '',
        iterations: 0,
        toolCalls: 0,
        success: false,
        error: `Circuit breaker open for agent ${agentId} (${snapshot.reason ?? 'generic'})`,
        durationMs: 0,
      };
    }

    // Publish task start
    await eventBus.publish({
      type: 'task:started', taskId, agentId,
    });

    try {
      const agentType = classifyAgent(provider);
      const timeoutMs = options?.timeoutMs ?? getTaskTimeoutMs();
      const wallClock = AbortSignal.timeout(timeoutMs);
      const signal = options?.signal
        ? AbortSignal.any([options.signal, wallClock])
        : wallClock;
      let output: string;
      let iterations = 0;
      let toolCalls = 0;
      let usage: TaskResult['usage'];
      taskQueue.recordActivity(taskId);

      // ── HNSW Vector Memory: Pre-task semantic recall ─────
      try {
        const { vectorMemory } = await import('../core/vector-memory.js');
        const memories = await vectorMemory.search(agentId, prompt, 5);
        if (memories.length > 0) {
          const ctx = memories
            .map(m => `- [score:${m.score.toFixed(2)}${m.semantic ? ',sem' : ',bm25'}] ${m.content.slice(0, 300)}`)
            .join('\n');
          prompt = prompt + `\n\n[장기 기억 컨텍스트 (자동 검색됨)]\n${ctx}\n`;
          log.debug({ agentId, memCount: memories.length, semantic: memories[0]?.semantic }, 'memory context injected');
        }
      } catch { /* non-critical */ }

      switch (agentType) {
        case 'A': {
          // Type A: Claude Code native — delegate to subprocess, monitor only
          const { execa } = await import('execa');
          const subprocess = execa(provider.command!, [
            ...(provider.args ?? []),
            '-p', prompt,
            '--output-format', 'text',
          ], {
            cwd: options?.projectDir || undefined,
            cancelSignal: signal,
            forceKillAfterDelay: 3000, // SIGKILL 3s after SIGTERM if still alive
            detached: process.platform !== 'win32',
            // NCO 재귀보호 (2026-06-30, fleet 6a748e4): 서브에이전트 claude가 NCO 훅 재트리거 → 무한재귀 방지
            env: { 
              ...process.env, 
              ...provider.env, 
              NCO_HOOK_DISABLED: '1',
              ...(options?.projectDir ? { PROJECT_DIR: options.projectDir } : {})
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

        case 'B':
        case 'B_SINGLE_PROMPT': {
          // Type B: NCO orchestrated loop
          const loop = new OrchestratedLoop(provider, sandbox, signal);
          const result = await loop.run(taskId, prompt, {
            systemPrompt: options?.systemPrompt,
            compact: options?.compact,
            projectDir: options?.projectDir,
            disableHistory: agentType === 'B_SINGLE_PROMPT',
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

        case 'C': {
          // Type C: API executor
          const executor = new ApiExecutor(provider, sandbox);
          const result = await executor.run(taskId, prompt, {
            systemPrompt: options?.systemPrompt,
            compact: options?.compact,
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

      circuitBreakerRegistry.recordSuccess(agentId);

      // Triple Verification Gate — run L1/L2/L3 checks
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

      await eventBus.publish({
        type: 'task:completed', taskId, agentId,
        output: output.slice(0, 1000),
        iterations, toolCalls, durationMs,
      });

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
          await vectorMemory.add(agentId, `[${taskId}] Q: ${promptSnippet} → A: ${outputSummary}`, 1.0);
        }
      } catch { /* non-critical */ }

      // ── AgentEvolver: record success for persona tuning ─
      try {
        const { agentEvolver } = await import('../core/agent-evolver.js');
        agentEvolver.record(agentId, taskId, true, durationMs, output.length);
      } catch { /* non-critical */ }

      return { taskId, agentId, output, iterations, toolCalls, success: true, durationMs, usage };

    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const abortReason = taskQueue.getAbortReason(taskId);
      const partialOutput = taskQueue.getBufferedOutput(taskId);
      const errorMessage = abortReason || err?.message || 'unknown: execution failed';
      const terminalOutput = partialOutput || (err as { partialOutput?: string } | undefined)?.partialOutput || '';
      if (abortReason !== 'cancelled') {
        circuitBreakerRegistry.recordFailure(agentId, errorMessage);
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
      await sharedState.heartbeat(id);
    }
  }

  private async healthCheckApiProvider(id: string, provider: ProviderConfig): Promise<boolean> {
    // NCO 긴급가드 (2026-06-30, fleet 2740be4): healthCheck 필드 없는 provider(예: remote-mlx) TypeError crash-loop 방지
    const url = typeof provider.healthCheck?.url === 'string' ? provider.healthCheck.url : null;
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

  private getNextHealthApiKey(providerId: string, envVar: string, purpose: 'health' | 'gated-probe' = 'health'): string | undefined {
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
