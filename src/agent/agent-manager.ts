import { OrchestratedLoop } from './orchestrated-loop.js';
import { ApiExecutor } from './api-executor.js';
import { createSandbox, type SandboxManager } from '../security/sandbox-manager.js';
import { verificationGate } from '../security/verification-gate.js';
import { circuitBreakerRegistry, classifyCircuitError } from '../security/circuit-breaker-registry.js';
import { eventBus } from '../core/event-bus.js';
import { sharedState } from '../core/shared-state.js';
import { loadEnabledProviders, env, type ProviderConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { createTaskId } from '../utils/id.js';

const log = createLogger('agent-manager');

function promptSummary(s: string): boolean {
  return s.trim().length > 10;
}

// ─── Agent Type Classification ────────────────────────
// Type A: Native agent (claude-code) — has its own agent loop
// Type B: Orchestrated (codex, gemini, aider, opencode, cursor-agent, copilot) — NCO external loop
// Type C: API (ollama, openrouter) — OpenAI-compatible API

type AgentType = 'A' | 'B' | 'C';

function classifyAgent(provider: ProviderConfig): AgentType {
  if (provider.id === 'claude-code') return 'A';
  if (provider.type === 'api') return 'C';
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
}

class AgentManager {
  private sandboxes = new Map<string, SandboxManager>();
  private latencyHistory = new Map<string, number[]>();
  private providers = new Map<string, ProviderConfig>();
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
      let output: string;
      let iterations = 0;
      let toolCalls = 0;

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
          // Build a merged abort signal: caller's signal OR a hard wall-clock timeout
          const timeoutMs = options?.timeoutMs ?? sandbox.getTimeout();
          const wallClock = AbortSignal.timeout(timeoutMs);
          const signal = options?.signal
            ? AbortSignal.any([options.signal, wallClock])
            : wallClock;
          // provider.args: extra Claude CLI flags (e.g. --dangerously-skip-permissions) so
          // headless NCO runs can use tools without an interactive permission prompt.
          const result = await execa(provider.command!, [
            ...(provider.args ?? []),
            '-p', prompt,
            '--output-format', 'text',
          ], {
            cancelSignal: signal,
            forceKillAfterDelay: 3000, // SIGKILL 3s after SIGTERM if still alive
            // NCO 재귀보호 (2026-06-30, fleet 6a748e4): 서브에이전트 claude가 NCO 훅 재트리거 → 무한재귀 방지
            env: { ...process.env, ...provider.env, NCO_HOOK_DISABLED: '1' },
            reject: false,
            stdin: 'ignore', // stdin을 닫아서 "no stdin data" 경고 방지
          });
          output = result.stdout || result.stderr || '';
          iterations = 1;
          break;
        }

        case 'B': {
          // Type B: NCO orchestrated loop
          const timeoutMs = options?.timeoutMs ?? sandbox.getTimeout();
          const wallClock = AbortSignal.timeout(timeoutMs);
          const signal = options?.signal
            ? AbortSignal.any([options.signal, wallClock])
            : wallClock;
          const loop = new OrchestratedLoop(provider, sandbox, signal);
          const result = await loop.run(taskId, prompt, {
            systemPrompt: options?.systemPrompt,
            compact: options?.compact,
          });
          output = result.output;
          iterations = result.iterations;
          toolCalls = result.toolCalls;
          break;
        }

        case 'C': {
          // Type C: API executor
          const executor = new ApiExecutor(provider, sandbox);
          const result = await executor.run(taskId, prompt, {
            systemPrompt: options?.systemPrompt,
            compact: options?.compact,
          });
          output = result.output;
          iterations = result.iterations;
          toolCalls = result.toolCalls;
          // credential preflight 등 executor가 명시한 실패를 completed로 흘리지 않는다
          if (result.success === false) {
            throw new Error(result.error || 'api executor reported failure');
          }
          break;
        }
      }

      const durationMs = Date.now() - startTime;
      this.recordLatency(agentId, durationMs);

      const classified = classifyCircuitError(output);
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

      return { taskId, agentId, output, iterations, toolCalls, success: true, durationMs };

    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      circuitBreakerRegistry.recordFailure(agentId, err?.message);

      // 상태 복구 — 실패/타임아웃 시 idle로 복원
      await sharedState.setAgentState(agentId, {
        status: 'idle',
        currentTask: null,
        currentFiles: [],
      });

      await eventBus.publish({
        type: 'task:failed', taskId, agentId,
        error: err.message, durationMs,
      });
      this.recordLatency(agentId, durationMs);

      // ── AgentEvolver: record failure ──────────────────────
      try {
        const { agentEvolver } = await import('../core/agent-evolver.js');
        agentEvolver.record(agentId, taskId, false, durationMs, 0);
      } catch { /* non-critical */ }

      return {
        taskId, agentId, output: '', iterations: 0, toolCalls: 0,
        success: false, error: err.message, durationMs,
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
        await this.healthCheckApiProvider(id, provider);
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

  private async healthCheckApiProvider(id: string, provider: ProviderConfig): Promise<void> {
    // NCO 긴급가드 (2026-06-30, fleet 2740be4): healthCheck 필드 없는 provider(예: remote-mlx) TypeError crash-loop 방지
    const url = typeof provider.healthCheck?.url === 'string' ? provider.healthCheck.url : null;
    if (!url) {
      await sharedState.setAgentState(id, { status: 'offline' });
      return;
    }
    const timeout = typeof provider.healthCheck.timeout === 'number'
      ? provider.healthCheck.timeout
      : 5000;
    const headers: Record<string, string> = {};
    const apiKey = provider.apiKeyRef
      ? process.env[provider.apiKeyRef]?.split(',')[0]?.trim()
      : undefined;
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
        return;
      }
      await sharedState.setAgentState(id, { status: 'idle' });
      await sharedState.heartbeat(id);
    } catch (e) {
      circuitBreakerRegistry.recordFailure(id, e instanceof Error ? e.message : String(e));
      await sharedState.setAgentState(id, { status: 'offline' });
      log.debug({
        id,
        error: e instanceof Error ? e.message : String(e),
      }, 'API health probe failed');
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
