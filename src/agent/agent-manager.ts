import { OrchestratedLoop } from './orchestrated-loop.js';
import { ApiExecutor } from './api-executor.js';
import { createSandbox, type SandboxManager } from '../security/sandbox-manager.js';
import { verificationGate } from '../security/verification-gate.js';
import { eventBus } from '../core/event-bus.js';
import { sharedState } from '../core/shared-state.js';
import { loadEnabledProviders, env, type ProviderConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { createTaskId } from '../utils/id.js';

const log = createLogger('agent-manager');

// ─── Agent Type Classification ────────────────────────
// Type A: Native agent (claude-code) — has its own agent loop
// Type B: Orchestrated (codex, agy, opencode, cursor-agent, copilot) — NCO external loop
// Type C: API (openrouter, mlx) — OpenAI-compatible API

type AgentType = 'A' | 'B' | 'C';

function classifyAgent(provider: ProviderConfig): AgentType {
  if (provider.id === 'claude-code') return 'A';
  if (provider.type === 'api') return 'C';
  return 'B';
}

export function resolveApiHealthCheckUrl(provider: Pick<ProviderConfig, 'healthCheck'>): string | null {
  const health = provider.healthCheck as Record<string, unknown> | undefined;
  if (!health || typeof health !== 'object') return null;

  if (typeof health.url === 'string' && health.url.trim()) {
    return health.url;
  }

  // Some providers declare a curl-style probe instead of a direct URL field.
  if (health.command === 'curl' && Array.isArray(health.args)) {
    for (const rawArg of health.args) {
      if (typeof rawArg !== 'string') continue;
      const arg = rawArg.trim();
      if (/^https?:\/\//i.test(arg)) return arg;
    }
  }

  return null;
}

function isCliFailureOutput(output: string): boolean {
  const normalized = output.trim();
  if (!normalized) return false;

  return (
    /^error:/i.test(normalized) ||
    /^reached max turns/i.test(normalized) ||
    /reached max turns \(\d+\)/i.test(normalized)
  );
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
  private circuitSuccessCounts = new Map<string, number>();

  async init(): Promise<void> {
    const providers = loadEnabledProviders();
    const projectDir = env.PROJECT_DIR;

    for (const p of providers) {
      this.providers.set(p.id, p);
      this.sandboxes.set(p.id, createSandbox(p.id, p.role, projectDir));
    }

    // Start health monitor (30s)
    this.healthTimer = setInterval(() => this.healthCheck(), 30_000);

    log.info({ count: providers.length }, 'Agent Manager initialized');
  }

  async executeTask(agentId: string, prompt: string, options?: {
    taskId?: string;
    systemPrompt?: string;
    compact?: boolean;
    signal?: AbortSignal;
    projectDir?: string;  // Override PROJECT_DIR for this task (e.g. nova-voice vs nco)
  }): Promise<TaskResult> {
    const provider = this.providers.get(agentId);
    if (!provider) throw new Error(`Unknown agent: ${agentId}`);

    const sandbox = this.sandboxes.get(agentId)!;
    const taskId = options?.taskId || createTaskId();
    const startTime = Date.now();

    // Publish task start
    await eventBus.publish({
      type: 'task:started', taskId, agentId,
    });

    try {
      const agentType = classifyAgent(provider);
      let output: string;
      let iterations = 0;
      let toolCalls = 0;

      switch (agentType) {
        case 'A': {
          // Type A: Claude Code native — delegate to subprocess, monitor only
          const { execa } = await import('execa');
          // Build a merged abort signal: caller's signal OR a hard wall-clock timeout
          const timeoutMs = sandbox.getTimeout();
          const wallClock = AbortSignal.timeout(timeoutMs);
          const signal = options?.signal
            ? AbortSignal.any([options.signal, wallClock])
            : wallClock;
          // provider.args: extra Claude CLI flags (e.g. --dangerously-skip-permissions) so
          // headless NCO runs can use tools without an interactive permission prompt.
          // claude-code 전용 cwd: /tmp 사용 → CLAUDE.md 자동 로드 방지
          // (NCO PROJECT_DIR 에 CLAUDE.md가 있으면 NCO tool 호출 시도 → max-turns 소진)
          const claudeCwd = options?.projectDir === env.PROJECT_DIR || !options?.projectDir
            ? '/tmp'
            : options.projectDir;
          const result = await execa(provider.command!, [
            ...(provider.args ?? []),
            '-p', prompt,
            '--output-format', 'text',
            '--max-turns', '3',
          ], {
            cancelSignal: signal,
            forceKillAfterDelay: 3000, // SIGKILL 3s after SIGTERM if still alive
            env: {
              ...process.env,
              ...provider.env,
              // Claude CLI 연결 안정화: 홈 디렉토리와 인증 경로 명시
              HOME: process.env.HOME || '/Users/nova-ai',
              CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
              // 하위 세션에서 NCO 훅 비활성화 (재귀 호출 방지)
              NCO_HOOK_DISABLED: '1',
            },
            reject: false,
            stdin: 'ignore', // stdin을 닫아서 "no stdin data" 경고 방지
            cwd: claudeCwd,
          });
          output = result.stdout || result.stderr || '';
          iterations = 1;
          if (result.exitCode !== 0 || isCliFailureOutput(output)) {
            throw new Error(output || `${agentId} CLI exited with code ${result.exitCode}`);
          }
          sandbox.recordSuccess();
          break;
        }

        case 'B': {
          // Type B: NCO orchestrated loop
          const timeoutMs = sandbox.getTimeout();
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
          const result = await executor.run(taskId, prompt, options?.systemPrompt);
          output = result.output;
          iterations = result.iterations;
          toolCalls = result.toolCalls;
          break;
        }
      }

      const durationMs = Date.now() - startTime;
      this.recordLatency(agentId, durationMs);

      // Triple Verification Gate — run L1/L2/L3 checks
      try {
        const taskProjectDir = options?.projectDir || env.PROJECT_DIR;
        const { stdout: diffOutput } = await (await import('execa')).execa(
          'git', ['diff', '--name-only'], { cwd: taskProjectDir, reject: false }
        );
        const changedFiles = diffOutput.split('\n').filter(Boolean);

        if (changedFiles.length > 0) {
          // Use task-level projectDir override if provided (e.g. nova-voice work via NCO)
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

      const newCount = (this.circuitSuccessCounts.get(agentId) ?? 0) + 1;
      this.circuitSuccessCounts.set(agentId, newCount);

      // half-open → closed: propagate success to CircuitBreaker
      const cb = sandbox.circuitBreaker;
      if (cb.getState() === 'half-open') {
        cb.recordSuccess();
        if (newCount >= 3 && cb.getState() === 'closed') {
          log.info('Circuit closed: %s (3 consecutive successes)', agentId);
          this.circuitSuccessCounts.set(agentId, 0);
        }
      }

      return { taskId, agentId, output, iterations, toolCalls, success: true, durationMs };

    } catch (err: any) {
      const durationMs = Date.now() - startTime;

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

      this.circuitSuccessCounts.set(agentId, 0);
      this.recordLatency(agentId, durationMs);

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
      // For CLI (oneshot) providers, try the healthCheck.command if defined.
      // Oneshot agents don't maintain Redis heartbeats between tasks, so
      // isAgentAlive() would always return false — marking them wrongly as offline.
      const hc = provider.healthCheck as Record<string, unknown> | undefined;
      if (hc && typeof hc.command === 'string') {
        await this.healthCheckCliProvider(id, provider);
      } else {
        // Persistent CLI agent: fall back to heartbeat-based check
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
  }

  private async healthCheckCliProvider(id: string, provider: ProviderConfig): Promise<void> {
    const hc = provider.healthCheck as Record<string, unknown>;
    const cmd = hc.command as string;
    const args = Array.isArray(hc.args) ? hc.args as string[] : [];
    const timeout = typeof hc.timeout === 'number' ? hc.timeout : 5000;
    try {
      const { execa } = await import('execa');
      await execa(cmd, args, {
        timeout,
        reject: false,
        env: { ...process.env, ...(provider.env as Record<string, string> || {}) },
      });
      await sharedState.setAgentState(id, { status: 'idle' });
      await sharedState.heartbeat(id);
    } catch (e) {
      await sharedState.setAgentState(id, { status: 'offline' });
      log.debug({ id, error: e instanceof Error ? e.message : String(e) }, 'CLI health probe failed');
    }
  }

  private async healthCheckApiProvider(id: string, provider: ProviderConfig): Promise<void> {
    const url = resolveApiHealthCheckUrl(provider);
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
      await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeout),
      });
      await sharedState.setAgentState(id, { status: 'idle' });
      await sharedState.heartbeat(id);
    } catch (e) {
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
