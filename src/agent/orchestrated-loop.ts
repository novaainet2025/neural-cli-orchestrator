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
import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';
import { ECHO_LINE_RE } from '../utils/echo-filter.js';
import { buildProviderProcessEnv } from './provider-process-env.js';
import { CodexSubagentTracker } from '../core/subagent-service.js';

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
const NO_STDIN_PROVIDERS = new Set(['codex', 'hermes', 'cursor-agent', 'agy']);
// hermes는 codex CLI 백엔드로 실행되므로 codex와 동일한 stdin/output-last-message 규칙을 따른다.
const CODEX_FAMILY = new Set(['codex', 'hermes']);

interface LoopResult {
  output: string;
  iterations: number;
  toolCalls: number;
  artifacts: string[];
  success: boolean;
  canceled?: boolean;
  error?: string;
}

/**
 * Provider별 비대화형 CLI 인자 생성. 태스크 수준 model override가 실제 CLI 플래그로
 * 이어지는지 독립적으로 검증할 수 있게 순수 함수로 유지한다.
 */
export function buildOrchestratedCliArgs(
  provider: Pick<ProviderConfig, 'id' | 'model'>,
  baseArgs: string[],
  prompt: string,
  lastMessageFile?: string | null,
  model?: string,
  localNetworkAccess = false,
): string[] {
  const configuredModel = model || provider.model;
  const selectedModel = configuredModel && !['codex', 'cursor', 'multi-llm'].includes(configuredModel)
    ? configuredModel
    : undefined;

  switch (provider.id) {
    case 'hermes': {
      const hFlags = [
        'exec',
        '--skip-git-repo-check',
        '--sandbox',
        localNetworkAccess ? 'workspace-write' : 'read-only',
        ...(localNetworkAccess ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
        ...(selectedModel ? ['-m', selectedModel] : []),
      ];
      return lastMessageFile
        ? [...hFlags, '--output-last-message', lastMessageFile, prompt]
        : [...hFlags, prompt];
    }
    case 'codex':
      return lastMessageFile
        ? ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', ...(localNetworkAccess ? ['-c', 'sandbox_workspace_write.network_access=true'] : []), '--json', ...(selectedModel ? ['-m', selectedModel] : []), '--output-last-message', lastMessageFile, prompt]
        : ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', ...(localNetworkAccess ? ['-c', 'sandbox_workspace_write.network_access=true'] : []), '--json', ...(selectedModel ? ['-m', selectedModel] : []), prompt];
    case 'agy':
      // provider.model은 NCO 라우팅 별칭(`agy-internal`)일 수 있으며 AGY CLI의
      // 실제 모델 ID가 아니다. AGY는 태스크가 명시한 override만 --model로 전달하고,
      // 기본 실행은 AGY 자체 기본 모델 선택에 맡긴다.
      return [
        '--mode',
        'accept-edits',
        '--sandbox',
        ...baseArgs,
        ...(model?.trim() ? ['--model', model.trim()] : []),
        '--print',
        prompt,
      ];
    case 'aider':
      return ['--message', prompt, ...baseArgs];
    case 'opencode': {
      const formatArgs = baseArgs.some(arg => arg === '--format' || arg.startsWith('--format='))
        ? []
        : ['--format', 'json'];
      return baseArgs[0] && !baseArgs[0].startsWith('-')
        ? [baseArgs[0], ...(selectedModel ? ['-m', selectedModel] : []), ...baseArgs.slice(1), ...formatArgs, prompt]
        : ['run', ...(selectedModel ? ['-m', selectedModel] : []), ...baseArgs, ...formatArgs, prompt];
    }
    case 'cursor-agent':
      // Headless default는 안전한 명령도 승인 대화상자를 열 수 없어 거부한다.
      // Smart Auto가 안전 호출만 자동 승인하고 나머지는 거부하도록 sandbox와 함께 고정한다.
      return [
        '--print',
        '--trust',
        '--auto-review',
        '--sandbox',
        'enabled',
        '--output-format',
        'text',
        ...(selectedModel ? ['--model', selectedModel] : []),
        prompt,
      ];
    default:
      return [...baseArgs, prompt];
  }
}

function isSuccessfulResult(result: { failed?: boolean; exitCode?: number | null; timedOut?: boolean; isCanceled?: boolean }): boolean {
  return !result.failed && result.exitCode === 0 && !result.timedOut && !result.isCanceled;
}

// Cursor의 계정별 유료 모델 한도와 독립적으로 동작하는 공식 Auto 라우트를 기본값으로 쓴다.
// 특정 모델이 필요하면 NCO_CURSOR_FALLBACK_MODEL로 명시적으로 고정할 수 있다.
const DEFAULT_CURSOR_FALLBACK_MODEL = 'auto';
const DEFAULT_CURSOR_FALLBACK_TTL_MS = 10 * 60_000;
const CURSOR_MODEL_PROVIDER_ERROR_RE =
  /NonRetriableError:\s*Provider Error[\s\S]{0,500}trouble connecting to the model provider/i;
const DISABLED_CURSOR_FALLBACK_VALUES = new Set(['0', 'false', 'off', 'none', 'disabled']);
let cursorFallbackPreference: { model: string; until: number } | null = null;

export function resolveCursorFallbackModel(
  configured: string | undefined = process.env.NCO_CURSOR_FALLBACK_MODEL,
): string | null {
  const normalized = configured?.trim();
  if (!normalized) return DEFAULT_CURSOR_FALLBACK_MODEL;
  if (DISABLED_CURSOR_FALLBACK_VALUES.has(normalized.toLowerCase())) return null;
  return normalized;
}

export function resolveCursorFallbackTtlMs(
  configured: string | undefined = process.env.NCO_CURSOR_FALLBACK_TTL_MS,
): number {
  if (!configured?.trim()) return DEFAULT_CURSOR_FALLBACK_TTL_MS;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.max(Math.trunc(parsed), 30_000), 60 * 60_000);
}

export function preferCursorFallbackModel(
  model: string,
  ttlMs = resolveCursorFallbackTtlMs(),
  now = Date.now(),
): void {
  if (!model.trim() || ttlMs <= 0) {
    cursorFallbackPreference = null;
    return;
  }
  cursorFallbackPreference = {
    model: model.trim(),
    until: now + ttlMs,
  };
}

export function clearCursorFallbackPreference(): void {
  cursorFallbackPreference = null;
}

function preferredCursorFallbackModel(
  fallbackModel: string | null,
  now = Date.now(),
): string | null {
  if (
    !fallbackModel
    || !cursorFallbackPreference
    || cursorFallbackPreference.model !== fallbackModel
    || cursorFallbackPreference.until <= now
  ) {
    if (cursorFallbackPreference?.until != null && cursorFallbackPreference.until <= now) {
      cursorFallbackPreference = null;
    }
    return null;
  }
  return cursorFallbackPreference.model;
}

export function shouldFallbackCursorModel(input: {
  providerId: string;
  providerModel?: string | null;
  requestedModel?: string;
  error: unknown;
  fallbackModel: string | null;
}): boolean {
  if (input.providerId !== 'cursor-agent' || !input.fallbackModel) return false;
  if (input.requestedModel?.trim()) return false;

  const providerModel = input.providerModel?.trim().toLowerCase();
  if (providerModel && providerModel !== 'cursor' && providerModel !== 'auto') return false;

  const candidate = input.error as {
    message?: unknown;
    output?: unknown;
    canceled?: unknown;
  } | null;
  if (candidate?.canceled === true) return false;

  const signal = [
    typeof candidate?.message === 'string' ? candidate.message : '',
    typeof candidate?.output === 'string' ? candidate.output : '',
  ].filter(Boolean).join('\n');
  return CURSOR_MODEL_PROVIDER_ERROR_RE.test(signal);
}

export async function executeWithCursorModelFallback<T>(input: {
  providerId: string;
  providerModel?: string | null;
  requestedModel?: string;
  fallbackModel?: string | null;
  execute: (model?: string) => Promise<T>;
  onFallback?: (context: {
    failedModel: string;
    fallbackModel: string;
    error: unknown;
  }) => void | Promise<void>;
}): Promise<T> {
  const fallbackModel = input.fallbackModel === undefined
    ? resolveCursorFallbackModel()
    : input.fallbackModel;
  const providerModel = input.providerModel?.trim().toLowerCase();
  const defaultCursorRoute = input.providerId === 'cursor-agent'
    && !input.requestedModel?.trim()
    && (!providerModel || providerModel === 'cursor' || providerModel === 'auto');
  const preferredFallback = defaultCursorRoute
    ? preferredCursorFallbackModel(fallbackModel)
    : null;
  const initialModel = preferredFallback ?? input.requestedModel;

  try {
    return await input.execute(initialModel);
  } catch (error) {
    // A preferred fallback is already the single bounded retry route. If it
    // fails, bubble immediately so AgentManager can open the circuit.
    if (preferredFallback) throw error;
    if (!shouldFallbackCursorModel({
      providerId: input.providerId,
      providerModel: input.providerModel,
      requestedModel: input.requestedModel,
      error,
      fallbackModel,
    })) {
      throw error;
    }

    await input.onFallback?.({
      failedModel: input.providerModel?.trim() || 'auto',
      fallbackModel: fallbackModel!,
      error,
    });
    // Deliberately execute the fallback exactly once. A second failure bubbles
    // to AgentManager so the circuit breaker can gate the provider normally.
    const result = await input.execute(fallbackModel!);
    preferCursorFallbackModel(fallbackModel!);
    return result;
  }
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
  private localNetworkAccess = false;

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
    options?: {
      systemPrompt?: string;
      compact?: boolean;
      model?: string;
      projectDir?: string;
      disableHistory?: boolean;
      localNetworkAccess?: boolean;
    },
  ): Promise<LoopResult> {
    this.taskProjectDir = options?.projectDir;
    this.localNetworkAccess = options?.localNetworkAccess === true;
    this.toolExecutor = new AgentToolExecutor(this.provider.id, this.sandbox, taskId, options?.projectDir);
    const agentId = this.provider.id;
    let iterations = 0;
    let totalToolCalls = 0;
    let exitReason: 'completed' | 'max-iterations' | 'circuit-breaker' = 'max-iterations';
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

      // executeTask() already acquired the sole half-open probe slot. Calling
      // canExecute() again here would try to acquire a second slot and reject
      // the probe that is already in flight. Internal checks must only observe
      // whether another failure has opened the circuit during this task.
      if (circuitBreakerRegistry.getSnapshot(agentId).state === 'open') {
        log.warn({ agentId, iterations }, 'Agent isolated by Circuit Breaker');
        exitReason = 'circuit-breaker';
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
        exitReason = 'completed';
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

      const error = exitReason === 'max-iterations'
        ? `Loop reached maximum iterations (${MAX_ITERATIONS}) before completion`
        : exitReason === 'circuit-breaker'
          ? 'Loop stopped because the Circuit Breaker denied execution'
          : undefined;

      return {
        output,
        iterations,
        toolCalls: totalToolCalls,
        artifacts,
        success: exitReason === 'completed',
        ...(error ? { error } : {}),
      };
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
    return executeWithCursorModelFallback({
      providerId: this.provider.id,
      providerModel: this.provider.model,
      requestedModel: model,
      execute: selectedModel => this.callCLIOnce(
        taskId,
        system,
        history,
        disableHistory,
        selectedModel,
      ),
      onFallback: async ({ failedModel, fallbackModel, error }) => {
        log.warn({
          agentId: this.provider.id,
          taskId,
          failedModel,
          fallbackModel,
          error: error instanceof Error ? error.message : String(error),
        }, 'Retrying Cursor Agent once with fallback model');
        try {
          await eventBus.publish({
            type: 'provider:model-fallback',
            agentId: this.provider.id,
            taskId,
            failedModel,
            fallbackModel,
            reason: 'transient-model-provider-error',
          });
        } catch (publishError) {
          log.warn({
            agentId: this.provider.id,
            taskId,
            error: publishError instanceof Error ? publishError.message : String(publishError),
          }, 'Failed to publish Cursor model fallback event');
        }
      },
    });
  }

  private async callCLIOnce(
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
    const lastMessageFile = CODEX_FAMILY.has(this.provider.id)
      ? joinPath(tmpdir(), `nco-codex-last-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
      : null;

    // Most CLI AIs accept prompt via stdin or -p flag
    // Adapt per provider
    const finalArgs = this.buildArgs(args, combined, lastMessageFile, model);
    this.assertTaskProjectDir();
    const subagentTracker = this.provider.id === 'codex'
      ? new CodexSubagentTracker(taskId, this.provider.id)
      : null;
    let subagentTrackerStopped = false;

    try {
      const useStdin = !NO_STDIN_PROVIDERS.has(this.provider.id);
      // [W18/stdin 2026-07-07] codex는 stdin:'ignore'면 "Reading additional input from stdin"에서
      // 멈춰 timeout된다(codex 0.142.5). 빈 input('')을 주면 EOF를 받아 정상 진행한다.
      // (T1: execa stdin:'ignore' → 멈춤 / input:'' → prompt 실행+정상 에러표시 재현)
      const stdinOpt: Record<string, unknown> = CODEX_FAMILY.has(this.provider.id)
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
          ...buildProviderProcessEnv(this.provider.id, this.provider.env),
          NO_COLOR: '1', 
          TERM: 'dumb',
          ...(this.taskProjectDir ? { PROJECT_DIR: this.taskProjectDir } : {})
        },
        reject: false,
      });
      taskQueue.recordChildProcess(taskId, subprocess.pid);
      subprocess.stdout?.on('data', chunk => {
        const text = chunk.toString();
        taskQueue.recordActivity(taskId, text);
        subagentTracker?.feedStdout(text);
      });
      subprocess.stderr?.on('data', chunk => taskQueue.recordActivity(taskId, chunk.toString()));
      const abortSignal = this.abortSignal;
      const abortHandler = () => {
        if (!subprocess.pid || subprocess.exitCode !== null || process.platform === 'win32') return;
        try {
          process.kill(-subprocess.pid, 'SIGKILL');
        } catch {
          try {
            process.kill(subprocess.pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      };
      abortSignal?.addEventListener('abort', abortHandler, { once: true });
      let result: Awaited<typeof subprocess>;
      try {
        result = await subprocess;
      } finally {
        abortSignal?.removeEventListener('abort', abortHandler);
      }
      const trackerStatus = isSuccessfulResult(result)
        ? 'completed'
        : (result as { isCanceled?: boolean }).isCanceled || (result as { timedOut?: boolean }).timedOut
          ? 'cancelled'
          : 'failed';
      subagentTracker?.stop(trackerStatus);
      subagentTrackerStopped = true;
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
      if (!subagentTrackerStopped) subagentTracker?.stop('failed');
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
    return buildOrchestratedCliArgs(
      this.provider,
      baseArgs,
      prompt,
      lastMessageFile,
      model,
      this.localNetworkAccess,
    );
  }

  /** Preserve first user message; drop oldest assistant/user pairs beyond MAX_HISTORY_TURNS. */
  private trimConversationHistory(history: Array<{ role: string; content: string }>): void {
    const maxLen = 1 + MAX_HISTORY_TURNS * 2;
    const maxContextChars = 40_000;
    const contextChars = () => history.reduce(
      (total, message) => total + message.role.length + message.content.length + 8,
      0,
    );

    // Tool output is already capped per call, but one turn can contain many
    // calls. Bound the serialized CLI prompt as well as the turn count while
    // preserving the initial request and the most recent tool-result pair.
    while (
      (history.length > maxLen || contextChars() > maxContextChars)
      && history.length > 3
    ) {
      history.splice(1, 2);
    }

    const latest = history.at(-1);
    if (latest?.role === 'user' && contextChars() > maxContextChars) {
      const charsWithoutLatest = contextChars() - latest.content.length;
      const available = Math.max(0, maxContextChars - charsWithoutLatest);
      if (latest.content.length > available) {
        const omitted = latest.content.length - available;
        const marker = `\n\n... (history truncated ${omitted} chars)\nContinue your work.`;
        latest.content = available > marker.length
          ? latest.content.slice(0, available - marker.length) + marker
          : marker.slice(0, available);
      }
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
