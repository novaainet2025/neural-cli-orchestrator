import { OrchestratedLoop } from './orchestrated-loop.js';
import { ApiExecutor } from './api-executor.js';
import { createSandbox, type SandboxManager } from '../security/sandbox-manager.js';
import { eventBus } from '../core/event-bus.js';
import { sharedState } from '../core/shared-state.js';
import { loadEnabledProviders, env, type ProviderConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { createTaskId } from '../utils/id.js';

const log = createLogger('agent-manager');

// ─── Agent Type Classification ────────────────────────
// Type A: Native agent (claude-code) — has its own agent loop
// Type B: Orchestrated (codex, gemini, aider, opencode, cursor-agent, copilot) — NCO external loop
// Type C: API (vllm, openrouter) — OpenAI-compatible API

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
  private providers = new Map<string, ProviderConfig>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;

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
          const result = await execa(provider.command!, [
            '-p', prompt,
            '--output-format', 'text',
          ], {
            timeout: sandbox.getTimeout(),
            env: { ...process.env, ...provider.env },
            reject: false,
          });
          output = result.stdout || result.stderr || '';
          iterations = 1;
          sandbox.recordSuccess();
          break;
        }

        case 'B': {
          // Type B: NCO orchestrated loop
          const loop = new OrchestratedLoop(provider, sandbox);
          const result = await loop.run(taskId, prompt, options?.systemPrompt);
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

      await eventBus.publish({
        type: 'task:completed', taskId, agentId,
        output: output.slice(0, 1000),
        iterations, toolCalls, durationMs,
      });

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

      return {
        taskId, agentId, output: '', iterations: 0, toolCalls: 0,
        success: false, error: err.message, durationMs,
      };
    }
  }

  // ─── Health Monitor ─────────────────────────────────
  private async healthCheck(): Promise<void> {
    for (const [id, provider] of this.providers) {
      const alive = await sharedState.isAgentAlive(id);
      if (!alive) {
        await sharedState.setAgentState(id, { status: 'offline' });
      }
      await sharedState.heartbeat(id);
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
