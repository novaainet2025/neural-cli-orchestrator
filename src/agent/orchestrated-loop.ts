import { execa } from 'execa';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
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
import { trajectoryGuard } from '../security/trajectory-guard.js';
import { ECHO_LINE_RE } from '../utils/echo-filter.js';

const log = createLogger('orchestrated-loop');

// [W20 2026-07-15] 자기지칭 리밋 문형만 리밋 신호로 인정 — CLI가 직접 뱉는 에러 형태.
const QUOTA_SELF_RE = /you'?(?:ve| have)? (?:hit|reached|exceeded) (?:your )?(?:current )?(?:usage limit|quota|rate limit)|usage limit (?:reached|hit)|exceeded your current quota|rate limit (?:reached|exceeded)|\b429 too many requests\b/i;
// [W21 2026-07-16] diff/픽스처 에코 판별 — gen-5 실측(1784127552491): 테스트 픽스처
// `+  agents: [{ id: 'codex', health: { lastError: "You've hit your usage limit" } }]` 가
// 기존 에코 토큰에 안 걸림. 실제 CLI 에러 라인은 diff 접두(+/-)도, 따옴표로 감싼 리밋 문구도,
// lastError/health: 메타 어휘도 갖지 않는다. (quota 판정 전용 — 공용 echo-filter는 광범위 오차단
// 위험이 있어 로컬 상수로 유지)
const QUOTA_ECHO_EXTRA_RE = /^\s*[+-]{1,3}\s|["'`][^"'`]*(?:usage limit|quota|rate limit)[^"'`]*["'`]|lastError|health\s*:/i;
// [W20] 에코 라인 판별은 utils/echo-filter.ts 공용 상수 사용 (gateway detectFailedCompletion과
// 동일 기준). 근거: 오탐 3세대 실측 — fleet에코(1784110597975) → 분류기 소스에코(1784111153688)
// → 수정 정규식 자기참조(1784112187354).

const MAX_ITERATIONS = 10;
const MAX_HISTORY_TURNS = 10;
const MAX_OUTPUT_LEN = 2500;

// Strip ANSI escape codes from CLI output (opencode, etc. emit color codes)
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
  success: boolean;
  canceled?: boolean;
  error?: string;
}

function isSuccessfulResult(result: { failed?: boolean; exitCode?: number | null; timedOut?: boolean; isCanceled?: boolean }): boolean {
  return !result.failed && result.exitCode === 0 && !result.timedOut && !result.isCanceled;
}

class CliExecutionError extends Error {
  constructor(
    message: string,
    readonly output: string,
    readonly canceled: boolean,
  ) {
    super(message);
    this.name = 'CliExecutionError';
  }
}

/**
 * Type B Executor: NCO runs the agent loop externally.
 * CLI AI gets a single prompt → returns text with tool calls →
 * NCO executes tools → appends results → calls AI again → repeat.
 */
export class OrchestratedLoop {
  private toolExecutor: AgentToolExecutor;
  private taskProjectDir?: string;

  constructor(
    private provider: ProviderConfig,
    private sandbox: SandboxManager,
    private abortSignal?: AbortSignal,
  ) {
    this.toolExecutor = new AgentToolExecutor(provider.id, sandbox);
  }

  async run(
    taskId: string,
    prompt: string,
    options?: { systemPrompt?: string, compact?: boolean, model?: string, projectDir?: string, disableHistory?: boolean },
  ): Promise<LoopResult> {
    this.taskProjectDir = options?.projectDir;
    this.toolExecutor = new AgentToolExecutor(this.provider.id, this.sandbox, taskId, options?.projectDir);
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
    trajectoryGuard.beginTask(taskId, agentId);

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
        return {
          output: '',
          iterations,
          toolCalls: totalToolCalls,
          artifacts,
          success: false,
          canceled: true,
          error: 'Loop cancelled by abort signal',
        };
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

      const aiResponse = await this.callCLI(taskId, fullSystem, history, options?.disableHistory === true, options?.model);
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

        const decision = await trajectoryGuard.beforeTool(
          { taskId, agentId, sandbox: this.sandbox },
          { tool: call.tool, toAgent: call.tool === 'sendMessage' ? call.args.to : null },
        );
        if (!decision.allowed) {
          results.push(`[Tool: ${call.tool}] ERROR: ${decision.reason}`);
          continue;
        }

        const result = await this.toolExecutor.execute(call);
        await trajectoryGuard.afterTool(
          { taskId, agentId, sandbox: this.sandbox },
          { tool: call.tool, ok: result.ok, error: result.error ?? null },
        );
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

      return { output, iterations, toolCalls: totalToolCalls, artifacts, success: true };
    } finally {
      trajectoryGuard.endTask(taskId, agentId);
      await sharedState.setAgentState(agentId, {
        status: 'idle',
        currentTask: null,
        currentFiles: [],
      });
    }
  }

  private async callCLI(
    taskId: string,
    system: string,
    history: Array<{ role: string; content: string }>,
    disableHistory = false,
    model?: string,
  ): Promise<string> {
    const command = this.provider.command!;
    const args = [...(this.provider.args || [])];

    // Build combined prompt (system + history)
    const currentPrompt = [...history].reverse().find(h => h.role === 'user')?.content ?? '';
    const combined = disableHistory
      ? currentPrompt
      : [
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
    const finalArgs = this.buildArgs(args, combined, lastMessageFile, model);
    this.assertTaskProjectDir();

    try {
      const useStdin = !NO_STDIN_PROVIDERS.has(this.provider.id);
      // [W18/stdin 2026-07-07] codex는 stdin:'ignore'면 "Reading additional input from stdin"에서
      // 멈춰 timeout된다(codex 0.142.5). 빈 input('')을 주면 EOF를 받아 정상 진행한다.
      // (T1: execa stdin:'ignore' → 멈춤 / input:'' → prompt 실행+정상 에러표시 재현)
      const stdinOpt: Record<string, unknown> = this.provider.id === 'codex'
        ? { input: '' }
        : (useStdin ? { input: combined } : { stdin: 'ignore' });
      const subprocess = execa(command, finalArgs, {
        ...stdinOpt,
        cwd: this.taskProjectDir || undefined,
        ...(this.abortSignal ? { cancelSignal: this.abortSignal } : { timeout: this.sandbox.getTimeout() }),
        forceKillAfterDelay: 3000,
        detached: process.platform !== 'win32',
        maxBuffer: 10 * 1024 * 1024,
        env: { 
          ...process.env, 
          ...this.provider.env, 
          NO_COLOR: '1', 
          TERM: 'dumb',
          ...(this.taskProjectDir ? { PROJECT_DIR: this.taskProjectDir } : {})
        },
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
      let lastMsg = '';

      if (lastMessageFile) {
        try {
          lastMsg = readFileSync(lastMessageFile, 'utf-8').trim();
        } catch {
          // file missing (codex failed before writing) — fall back below
        } finally {
          try { unlinkSync(lastMessageFile); } catch { /* already gone */ }
        }
      }

      if (!isSuccessfulResult(result)) {
        // [W18 2026-07-07] 핵심 에러 라인 우선 추출 — stderr 앞 500자만 보면 codex 배너에
        // 묻혀 진짜 원인(usage limit 등, stderr 뒤쪽)이 잘린다. 알려진 에러패턴을 먼저 찾고,
        // 없으면 앞 500자로 폴백.
        const _stderrRaw = stripAnsi(result.stderr || '');
        // [W20 2026-07-15] 에코 라인 제외 — 타 에이전트 fleet 상태 문구 + 소스코드/파일 인용
        // (path.ts:NN prefix, const/regex 문법 "(?:")이 에러 메시지에 실려 classifyCircuitError가
        // 이 에이전트의 quota로 오분류(1h open)하는 3세대 오탐(fleet에코→분류기소스에코→
        // 수정정규식 자기참조)을 실패 경로에서도 차단한다. 실제 CLI 에러 라인에는 이 토큰들이 없다.
        const _stderrNoEcho = _stderrRaw.split('\n').filter((l) => !ECHO_LINE_RE.test(l)).join('\n');
        const _errMatch = _stderrNoEcho.match(/[^\n]*(usage limit|not valid|quota|exceeded|forbidden|unauthorized|rate limit|error:|failed)[^\n]*/i);
        const stderrSummary = (_errMatch ? _errMatch[0].trim().slice(0, 300) : '') || _stderrNoEcho.slice(0, 500);
        const timedOut = Boolean((result as { timedOut?: boolean }).timedOut);
        const isCanceled = Boolean((result as { isCanceled?: boolean }).isCanceled);
        log.warn({
          agentId: this.provider.id,
          exitCode: result.exitCode,
          shortMessage: result.shortMessage,
          stderr: stderrSummary,
        }, 'CLI call returned non-zero exit');

        const opencodeOutput = this.provider.id === 'opencode'
          ? extractOpenCodeText(result.stdout || '')
          : undefined;
        const stderrTail = _stderrNoEcho.trim().slice(-300);
        const stdoutTail = stripAnsi(result.stdout || '').trim().slice(-300);
        // [W18 2026-07-07] stderr 우선: 실패 진짜원인(usage limit 등)은 stderr에 있는데
        // codex 배너("Reading additional input from stdin")가 stdout이라 앞서면 원인이 가려짐.
        const combinedOutput = [lastMsg, opencodeOutput, stderrTail, stdoutTail].filter(Boolean).join('\n').trim();
        const fallbackSummary = stderrSummary || stripAnsi(result.shortMessage || '').slice(0, 500) || 'no stderr';
        const reason = isCanceled
          ? timedOut ? 'CLI timed out' : 'CLI cancelled'
          : `CLI failed exit=${result.exitCode ?? 'unknown'}`;
        throw new CliExecutionError(
          `${this.provider.id}: ${reason} — ${fallbackSummary}`,
          combinedOutput || `[${this.provider.id}: ${reason} — ${fallbackSummary}]`,
          isCanceled || timedOut,
        );
      }

      // [W19 2026-07-12][W20 2026-07-15][W21 2026-07-16] 재활성 오판 차단: exit 0(성공)이라도 stderr에
      // "자기 자신"의 소진 신호가 있으면 실제로는 실패다(오판 재활성 3회 원인). 오탐 5세대 실측 후 규칙:
      //  (1) 자기지칭 문형만(QUOTA_SELF_RE) 라인 단위 매칭
      //  (2) 에코 라인 제외(ECHO_LINE_RE: fleet 상태·파일:줄·코드·정규식 문법)
      //  (3) diff/픽스처 에코 제외(QUOTA_ECHO_EXTRA_RE: +/- diff 접두, 따옴표 안 문구, lastError 메타)
      //  (4) 구조 신호 우선: CLI가 최종 메시지를 정상 산출했으면(lastMsg 존재) 리밋 아님 —
      //      실제 리밋은 턴을 완성하지 못한다(텍스트 군비경쟁 종식용 1차 판정, gen-5 근본 차단).
      const _successStderr = stripAnsi(result.stderr || '');
      const _q = _successStderr.split('\n').find(
        (l) => QUOTA_SELF_RE.test(l) && !ECHO_LINE_RE.test(l) && !QUOTA_ECHO_EXTRA_RE.test(l),
      );
      if (_q && !lastMsg) {
        throw new CliExecutionError(
          `${this.provider.id}: quota exhausted (stderr, exit 0) — ${_q.trim().slice(0, 200)}`,
          `[${this.provider.id}: quota exhausted despite exit 0 — 재활성 차단]`,
          false,
        );
      }

      if (lastMsg) return lastMsg;

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

  private assertTaskProjectDir(): void {
    if (this.provider.id !== 'codex') return;

    const projectDir = this.taskProjectDir?.trim();
    if (!projectDir) {
      throw new Error('codex requires metadata.projectDir: missing task project directory');
    }
    if (!existsSync(projectDir)) {
      throw new Error(`codex requires metadata.projectDir to exist: ${projectDir}`);
    }
  }

  private buildArgs(baseArgs: string[], prompt: string, lastMessageFile?: string | null, model?: string): string[] {
    switch (this.provider.id) {
      case 'codex':
        // codex exec <prompt> — non-interactive; skip git trust check outside workdir
        // --output-last-message: final assistant reply only (no banner/echo)
        // --sandbox workspace-write: 기본 read-only 샌드박스는 구현 위임이 전부
        //   "patch rejected: read-only sandbox"로 실패한다 (2026-07-03 subnote 실측)
        return lastMessageFile
          ? ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', ...(model ? ['-m', model] : []), '--output-last-message', lastMessageFile, prompt]
          : ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', ...(model ? ['-m', model] : []), prompt];
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
          ? [baseArgs[0], ...(model ? ['-m', model] : []), ...baseArgs.slice(1), ...formatArgs, prompt]
          : ['run', ...(model ? ['-m', model] : []), ...baseArgs, ...formatArgs, prompt];
      }
      case 'cursor-agent':
        // --print: non-interactive output, --trust: skip workspace trust prompt
        return ['--print', '--trust', '--output-format', 'text', ...(model ? ['--model', model] : []), prompt];
      case 'copilot':
        // copilot CLI v1.0.22: non-interactive mode via --prompt flag
        return ['--prompt', prompt];
      case 'higgsfield':
        return ['generate', 'create', this.provider.model || 'higgsfield', '--prompt', prompt];
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
