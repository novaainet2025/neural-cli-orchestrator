import { execa } from 'execa';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { AgentToolExecutor } from './agent-tools.js';
import { parseToolCalls, extractThinking } from './tool-parser.js';
import { SandboxManager } from '../security/sandbox-manager.js';
import { eventBus } from '../core/event-bus.js';
import { sharedState } from '../core/shared-state.js';
import { taskQueue } from '../core/task-queue.js';
import { createLogger } from '../utils/logger.js';
import type { ProviderConfig } from '../utils/config.js';
import { buildOrchestrationSystemPrompt, buildCompactSystemPrompt } from './nco-orchestration-prompt.js';

const log = createLogger('orchestrated-loop');

const MAX_ITERATIONS = 10;
const MAX_HISTORY_TURNS = 10;
const MAX_OUTPUT_LEN = 2500;

// Strip ANSI escape codes from CLI output (opencode, gemini, etc. emit color codes)
// eslint-disable-next-line no-control-regex
function stripAnsi(str: string): string {
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').trim();
}

function extractOpenCodeText(stdout: string): string | undefined {
  let parsedAnyLine = false;
  const textParts: string[] = [];

  for (const line of stripAnsi(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;

    try {
      const event = JSON.parse(line);
      parsedAnyLine = true;
      if (event?.type === 'text' && typeof event.part?.text === 'string') {
        textParts.push(event.part.text);
      }
    } catch {
      // Ignore non-JSON lines mixed into the JSONL stream.
    }
  }

  // JSONL은 파싱됐지만 text 이벤트가 0개(도구만 실행 등)면 의도적으로 빈 문자열을
  // 반환한다 — raw JSONL로 폴백하면 step_start 등 이벤트 잡음이 답변으로 오염되고,
  // 빈 문자열은 하류 classifyResult가 silent-failure로 정확히 분류한다.
  // JSON 줄이 하나도 없으면(구버전 formatted 출력) undefined → raw 폴백.
  return parsedAnyLine ? textParts.join('') : undefined;
}

// Providers that handle prompt as CLI args — do NOT send via stdin
const NO_STDIN_PROVIDERS = new Set(['codex', 'cursor-agent', 'copilot', 'agy']);

interface LoopResult {
  output: string;
  iterations: number;
  toolCalls: number;
  artifacts: string[];
}

/**
 * Type B Executor: NCO runs the agent loop externally.
 * CLI AI gets a single prompt → returns text with tool calls →
 * NCO executes tools → appends results → calls AI again → repeat.
 */
export class OrchestratedLoop {
  private toolExecutor: AgentToolExecutor;

  constructor(
    private provider: ProviderConfig,
    private sandbox: SandboxManager,
    private abortSignal?: AbortSignal,
  ) {
    this.toolExecutor = new AgentToolExecutor(provider.id, sandbox);
  }

  async run(taskId: string, prompt: string, options?: { systemPrompt?: string, compact?: boolean }): Promise<LoopResult> {
    const agentId = this.provider.id;
    let iterations = 0;
    let totalToolCalls = 0;
    const artifacts: string[] = [];
    const history: Array<{ role: string; content: string }> = [];

    // Update agent state
    await sharedState.setAgentState(agentId, {
      status: 'working',
      currentTask: taskId,
    });

    const teamState = await this.buildTeamContext();
    const systemBase = options?.systemPrompt || this.provider.persona.systemPrompt;
    
    const fullSystem = options?.compact
      ? buildCompactSystemPrompt(systemBase)
      : buildOrchestrationSystemPrompt(systemBase, teamState);

    history.push({ role: 'user', content: prompt });

    try {
      while (iterations < MAX_ITERATIONS) {
      iterations++;
      taskQueue.recordActivity(taskId);

      // Check abort signal
      if (this.abortSignal?.aborted) {
        log.info({ agentId, iterations }, 'Loop aborted by signal');
        break;
      }

      if (!this.sandbox.canExecute()) {
        log.warn({ agentId, iterations }, 'Agent isolated by Circuit Breaker');
        break;
      }

      // Call AI (single shot)
      await eventBus.publish({
        type: 'agent:status', agentId,
        status: iterations === 1 ? 'thinking' : 'working',
      });

      const aiResponse = await this.callCLI(taskId, fullSystem, history);
      taskQueue.recordActivity(taskId, aiResponse);

      // Stream the response
      await eventBus.publish({
        type: 'task:chunk', taskId, agentId,
        chunk: aiResponse,
        iteration: iterations,
      });

      // Check for tool calls
      const toolCalls = parseToolCalls(aiResponse);

      if (toolCalls.length === 0) {
        // No tool calls = AI is done
        history.push({ role: 'assistant', content: aiResponse });
        this.trimConversationHistory(history);
        log.info({ agentId, iterations, totalToolCalls }, 'Loop completed (no more tools)');
        break;
      }

      // Execute each tool call
      const results: string[] = [];
      for (const call of toolCalls) {
        totalToolCalls++;
        taskQueue.recordActivity(taskId, `[tool:${call.tool}]`);
        log.debug({ agentId, tool: call.tool, args: call.args }, 'Executing tool');

        const result = await this.toolExecutor.execute(call);
        const outRaw = result.output || result.error || '';
        const truncated = outRaw.length > MAX_OUTPUT_LEN 
          ? outRaw.slice(0, MAX_OUTPUT_LEN) + `\n\n... (truncated ${outRaw.length - MAX_OUTPUT_LEN} chars)`
          : outRaw;
        results.push(`[Tool: ${call.tool}] ${result.ok ? 'OK' : 'ERROR'}: ${truncated}`);

        if (call.tool === 'writeFile' || call.tool === 'createFile') {
          artifacts.push(call.args.path);
        }
      }

      // Add AI response + tool results to history
      history.push({ role: 'assistant', content: aiResponse });
      history.push({ role: 'user', content: `Tool results:\n${results.join('\n')}\n\nContinue your work.` });
      this.trimConversationHistory(history);

      await eventBus.publish({
        type: 'task:progress', taskId, agentId,
        progress: Math.min(iterations / MAX_ITERATIONS, 0.95),
        detail: `Iteration ${iterations}: ${toolCalls.length} tools executed`,
      });
      }

      const finalOutput = history
        .filter(h => h.role === 'assistant')
        .map(h => extractThinking(h.content))
        .filter(Boolean)
        .join('\n\n');

      // finalOutput이 비어있으면 마지막 assistant 원본 메시지를 사용
      const output = finalOutput || history
        .filter(h => h.role === 'assistant')
        .map(h => h.content)
        .filter(Boolean)
        .pop() || '';

      return { output, iterations, toolCalls: totalToolCalls, artifacts };
    } finally {
      await sharedState.setAgentState(agentId, {
        status: 'idle',
        currentTask: null,
        currentFiles: [],
      });
    }
  }

  private async callCLI(taskId: string, system: string, history: Array<{ role: string; content: string }>): Promise<string> {
    const command = this.provider.command!;
    const args = [...(this.provider.args || [])];

    // Build combined prompt (system + history)
    const combined = [
      system,
      '',
      '---',
      '',
      ...history.map(h => `### ${h.role === 'user' ? 'User' : 'Assistant'}:\n${h.content}`),
    ].join('\n');

    // codex: --output-last-message writes ONLY the final assistant message to a file,
    // avoiding banner/echo pollution in stdout (T1-verified flag support)
    const lastMessageFile = this.provider.id === 'codex'
      ? joinPath(tmpdir(), `nco-codex-last-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
      : null;

    // Most CLI AIs accept prompt via stdin or -p flag
    // Adapt per provider
    const finalArgs = this.buildArgs(args, combined, lastMessageFile);

    try {
      const useStdin = !NO_STDIN_PROVIDERS.has(this.provider.id);
      const subprocess = execa(command, finalArgs, {
        ...(useStdin ? { input: combined } : { stdin: 'ignore' }),
        ...(this.abortSignal ? { cancelSignal: this.abortSignal } : { timeout: this.sandbox.getTimeout() }),
        forceKillAfterDelay: 3000,
        detached: process.platform !== 'win32',
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...this.provider.env, NO_COLOR: '1', TERM: 'dumb' },
        reject: false,
      });
      taskQueue.recordChildProcess(taskId, subprocess.pid);
      subprocess.stdout?.on('data', chunk => taskQueue.recordActivity(taskId, chunk.toString()));
      subprocess.stderr?.on('data', chunk => taskQueue.recordActivity(taskId, chunk.toString()));
      this.abortSignal?.addEventListener('abort', () => {
        if (!subprocess.pid || process.platform === 'win32') return;
        try {
          process.kill(-subprocess.pid, 'SIGKILL');
        } catch {
          try {
            process.kill(subprocess.pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }, { once: true });
      const result = await subprocess;

      if (lastMessageFile) {
        try {
          const lastMsg = readFileSync(lastMessageFile, 'utf-8').trim();
          if (lastMsg) return lastMsg;
        } catch {
          // file missing (codex failed before writing) — fall back below
        } finally {
          try { unlinkSync(lastMessageFile); } catch { /* already gone */ }
        }
      }

      if (result.failed || result.exitCode !== 0) {
        const stderrSummary = stripAnsi(result.stderr || '').slice(0, 500);
        log.warn({
          agentId: this.provider.id,
          exitCode: result.exitCode,
          shortMessage: result.shortMessage,
          stderr: stderrSummary,
        }, 'CLI call returned non-zero exit');

        if (lastMessageFile) {
          const status = (result as any).isCanceled ? 'aborted (timeout)' : 'failed';
          const suffix = stderrSummary ? ` — ${stderrSummary}` : '';
          return `[codex: no final response — process ${status}]${suffix}`;
        }

        const opencodeOutput = this.provider.id === 'opencode'
          ? extractOpenCodeText(result.stdout || '')
          : undefined;
        const output = opencodeOutput ?? stripAnsi(result.stdout || result.stderr || '');
        if (!output) {
          const fallbackSummary = stderrSummary || stripAnsi(result.shortMessage || '').slice(0, 500) || 'no stderr';
          return `[${this.provider.id}: CLI failed exit=${result.exitCode ?? 'unknown'} — ${fallbackSummary}]`;
        }

        return output;
      }

      if (this.provider.id === 'opencode') {
        const output = extractOpenCodeText(result.stdout || '');
        if (output !== undefined) return output;
      }

      return stripAnsi(result.stdout || result.stderr || '');
    } catch (err: any) {
      log.error({ agentId: this.provider.id, err: err.message }, 'CLI call failed');
      throw err;
    }
  }

  private buildArgs(baseArgs: string[], prompt: string, lastMessageFile?: string | null): string[] {
    switch (this.provider.id) {
      case 'codex':
        // codex exec <prompt> — non-interactive; skip git trust check outside workdir
        // --output-last-message: final assistant reply only (no banner/echo)
        // --sandbox workspace-write: 기본 read-only 샌드박스는 구현 위임이 전부
        //   "patch rejected: read-only sandbox"로 실패한다 (2026-07-03 subnote 실측)
        return lastMessageFile
          ? ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--output-last-message', lastMessageFile, prompt]
          : ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', prompt];
      case 'gemini':
        return [...baseArgs, prompt];
      case 'agy':
        // Antigravity CLI (Go flag 파서): 프롬프트는 반드시 마지막 위치.
        // 기존 ['--print', '--dangerously-skip-permissions', prompt] 순서는 --print가
        // 뒤따르는 플래그 문자열을 프롬프트로 오인해 매 태스크가 해당 플래그 설명만
        // 반환하는 버그가 있었다 (2026-07-03 subnote 실측: 순서 교정 후 정답 반환).
        return ['--dangerously-skip-permissions', ...baseArgs, '--print', prompt];
      case 'aider':
        // Flags (--yes, --no-auto-commits, --model, …) come from provider.args in config
        return ['--message', prompt, ...baseArgs];
      case 'opencode': {
        // opencode run <message> — non-interactive; 'chat' opens TUI.
        // provider.args 보존 규칙: 첫 토큰이 비플래그면 이미 subcommand(run/plan 등)가
        // 지정된 것이므로 그대로 쓰고, 플래그로 시작하거나 비어있으면 run을 앞에 붙인다.
        // (baseArgs 전체에서 비플래그를 찾으면 '-m <model>'의 값을 subcommand로 오판한다)
        // --format json 필수: 기본 formatted 모드는 non-TTY에서 배너만 찍고 영구 hang.
        const formatArgs = baseArgs.some(arg => arg === '--format' || arg.startsWith('--format='))
          ? []
          : ['--format', 'json'];
        return baseArgs[0] && !baseArgs[0].startsWith('-')
          ? [...baseArgs, ...formatArgs, prompt]
          : ['run', ...baseArgs, ...formatArgs, prompt];
      }
      case 'cursor-agent':
        // --print: non-interactive output, --trust: skip workspace trust prompt
        return ['--print', '--trust', '--output-format', 'text', prompt];
      case 'copilot':
        // copilot CLI v1.0.22: non-interactive mode via --prompt flag
        return ['--prompt', prompt];
      default:
        return [...baseArgs, prompt];
    }
  }

  /** Preserve first user message; drop oldest assistant/user pairs beyond MAX_HISTORY_TURNS. */
  private trimConversationHistory(history: Array<{ role: string; content: string }>): void {
    const maxLen = 1 + MAX_HISTORY_TURNS * 2;
    while (history.length > maxLen && history.length >= 3) {
      history.splice(1, 2);
    }
  }

  private async buildTeamContext(): Promise<string> {
    const states = await sharedState.getAllAgentStates();
    const lines = Object.values(states).map(s =>
      `- ${s.id}: ${s.status}${s.currentTask ? ` (working on: ${s.currentTask})` : ''}`
    );
    return lines.join('\n') || 'No agents online';
  }
}
