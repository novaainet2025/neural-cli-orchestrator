import { execa } from 'execa';
import { existsSync, mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
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
import {
  resolveProviderRuntime,
  type ModelSelectionSource,
} from '../core/provider-catalog.js';
import { buildOrchestrationSystemPrompt, buildCompactSystemPrompt } from './nco-orchestration-prompt.js';
import { forbidsTools } from './tool-policy.js';
import { trajectoryGuard } from '../security/trajectory-guard.js';
import { circuitBreakerRegistry, classifyCircuitError } from '../security/circuit-breaker-registry.js';
import { ECHO_LINE_RE } from '../utils/echo-filter.js';
import { applyOpenCodeOrchestrationIsolation, buildProviderProcessEnv } from './provider-process-env.js';
import { CodexSubagentTracker } from '../core/subagent-service.js';
import {
  chooseOrchestrationOutput,
  decideToolFreeOrchestrationResponse,
  MAX_ORCHESTRATION_ITERATIONS,
} from './orchestration-completion.js';
import { formatToolOutput } from './orchestration-tool-output.js';
import { SchemaAdvisor } from './schema-advisor.js';
import {
  requireProviderRateLimitAdmission,
  resolveProviderRateLimitAdmission,
} from '../core/rate-limit-state.js';

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

const MAX_HISTORY_TURNS = 10;
// 2.5KB pages forced 9-10 model round trips for an ordinary 20-25KB source file.
// 8KB keeps the 10-turn history bounded while bringing Type B agents closer to
// the 16KB native API-tool path and materially reducing CLI latency/cost.
const MAX_OUTPUT_LEN = 8000;
// Keep one full capped tool page per retained turn, plus room for the original
// task and assistant XML/final responses. The former 40KB bound dropped early
// required evidence after five or six reads once tool pages grew to 8KB.
export const MAX_ORCHESTRATED_HISTORY_CHARS = MAX_OUTPUT_LEN * MAX_HISTORY_TURNS + 16_000;

export function trimOrchestratedConversationHistory(
  history: Array<{ role: string; content: string }>,
  maxTurns = MAX_HISTORY_TURNS,
  maxContextChars = MAX_ORCHESTRATED_HISTORY_CHARS,
): void {
  const maxLen = 1 + maxTurns * 2;
  const contextChars = () => history.reduce(
    (total, message) => total + message.role.length + message.content.length + 8,
    0,
  );

  // Preserve the first user message and remove complete assistant/result pairs
  // so a tool call is never separated from its result.
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

/**
 * Recover the model-visible assistant text from `codex exec --json` output.
 *
 * Codex can emit a non-empty agent_message containing an NCO XML tool call and
 * then finish with an empty agent_message. In that case --output-last-message
 * is empty, while parsing the raw JSONL as plain text leaves XML quotes escaped
 * and makes the tool call invisible to parseToolCalls().
 */
export function extractCodexJsonlAgentText(stdout: string): string | undefined {
  let lastNonEmpty: string | undefined;

  for (const line of stripAnsi(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;

    try {
      const event = JSON.parse(line);
      const text = event?.type === 'item.completed'
        && event.item?.type === 'agent_message'
        && typeof event.item.text === 'string'
        ? event.item.text.trim()
        : '';
      if (text) lastNonEmpty = text;
    } catch {
      // Formatted/non-JSON stdout keeps using the existing raw fallback.
    }
  }

  return lastNonEmpty;
}

// Codex-family providers are Type B: NCO, not the nested CLI, owns tool execution.
// Ignore personal/project MCP state and remove native shell/subagent/web tools so the
// model emits NCO XML calls for AgentToolExecutor. Read-only is defense in depth for
// native file tools that the CLI may still expose. Auth remains available with
// --ignore-user-config (Codex CLI contract; verified against 0.146.0).
const CODEX_ORCHESTRATED_ISOLATION_ARGS = [
  '--ignore-user-config',
  '--ignore-rules',
  '--ephemeral',
  '-c', 'mcp_servers={}',
  '-c', 'features.shell_tool=false',
  '-c', 'features.unified_exec=false',
  '-c', 'agents.enabled=false',
  '-c', 'web_search="disabled"',
  '--sandbox', 'read-only',
] as const;

let openCodeIsolatedConfigHome: string | undefined;

function getOpenCodeIsolatedConfigHome(): string {
  openCodeIsolatedConfigHome ??= mkdtempSync(joinPath(tmpdir(), 'nco-opencode-config-'));
  return openCodeIsolatedConfigHome;
}

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
  provider: Pick<ProviderConfig, 'id' | 'model'>
    & Partial<Pick<ProviderConfig, 'command' | 'runtime'>>,
  baseArgs: string[],
  prompt: string,
  lastMessageFile?: string | null,
  model?: string,
  localNetworkAccess = false,
): string[] {
  const runtime = resolveProviderRuntime(provider);
  const explicitModel = model?.trim() || undefined;
  const selectedModel = explicitModel
    ?? (runtime.modelTransport === 'override-only' ? undefined : provider.model?.trim() || undefined);

  switch (runtime.adapter) {
    case 'codex': {
      const hFlags = [
        'exec',
        '--skip-git-repo-check',
        ...CODEX_ORCHESTRATED_ISOLATION_ARGS,
        ...(selectedModel ? ['-m', selectedModel] : []),
      ];
      if (runtime.profile === 'readonly-tool-worker') {
        return lastMessageFile
          ? [...hFlags, '--output-last-message', lastMessageFile, prompt]
          : [...hFlags, prompt];
      }
      const codexFlags = [
        'exec',
        '--skip-git-repo-check',
        ...CODEX_ORCHESTRATED_ISOLATION_ARGS,
        '--json',
        ...(selectedModel ? ['-m', selectedModel] : []),
      ];
      return lastMessageFile
        ? [...codexFlags, '--output-last-message', lastMessageFile, prompt]
        : [...codexFlags, prompt];
    }
    case 'agy':
      return [
        '--mode',
        'accept-edits',
        '--sandbox',
        ...baseArgs,
        ...(selectedModel ? ['--model', selectedModel] : []),
        '--print',
        prompt,
      ];
    case 'aider':
      return ['--message', prompt, ...baseArgs];
    case 'opencode': {
      // Do not inherit session/attach/auto flags from ambient provider config.
      // Each NCO iteration is a clean text generation; any requested
      // tools must be emitted as XML and executed by AgentToolExecutor.
      return [
        'run',
        '--pure',
        '--agent',
        'nco-orchestrated',
        ...(selectedModel ? ['-m', selectedModel] : []),
        '--format',
        'json',
        prompt,
      ];
    }
    case 'cursor':
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
      return runtime.promptTransport === 'argv' ? [...baseArgs, prompt] : [...baseArgs];
  }
}

export interface OrchestratedCliInvocation {
  args: string[];
  input?: string;
  stdin?: 'ignore';
}

/** Build argv and stdio together so the prompt can never use both transports. */
export function buildOrchestratedCliInvocation(
  provider: Pick<ProviderConfig, 'id' | 'model'>
    & Partial<Pick<ProviderConfig, 'command' | 'runtime'>>,
  baseArgs: string[],
  prompt: string,
  lastMessageFile?: string | null,
  model?: string,
  localNetworkAccess = false,
): OrchestratedCliInvocation {
  const runtime = resolveProviderRuntime(provider);
  const args = buildOrchestratedCliArgs(
    provider,
    baseArgs,
    prompt,
    lastMessageFile,
    model,
    localNetworkAccess,
  );
  if (runtime.adapter === 'codex') return { args, input: '' };
  return runtime.promptTransport === 'stdin'
    ? { args, input: prompt }
    : { args, stdin: 'ignore' };
}

/**
 * 실패 요약에 **진짜 사유**가 담기도록 고른다.
 *
 * `fallbackSummary` 는 stderr 요약이나 execa `shortMessage` 인데, 프로바이더가 배너를
 * stderr 로 내고 구조화된 오류를 stdout 으로 내면 **배너가 사유를 가린다.**
 *
 * 실측(2026-08-07): codex 태스크 116건의 error 가 전부
 * `codex: CLI failed exit=1 — Reading additional input from stdin...` 이었다. 그 문구만
 * 보면 stdin 처리 결함으로 읽히지만, 같은 실행의 stdout 에는
 * `{"type":"error","message":"You've hit your usage limit …"}` 가 있었다. **쿼터 소진이다.**
 *
 * 배너가 error 에 박히면 두 가지가 망가진다.
 *   ① 운영자가 원인을 못 본다 — 116건이 전부 같은 무의미한 문구로 남는다
 *   ② `classifyCircuitError` 가 error 에서 아무것도 못 찾아 **서킷이 안 열린다**
 *      (실측: 이 문구만 넣으면 null, stdout 을 함께 넣으면 quota 로 잡힌다)
 *
 * 이미 `combinedOutput` 은 stderr 우선으로 합쳐 두었으므로(W18), 거기서 분류 가능한
 * 줄을 찾아 요약으로 승격한다. 이미 사유가 담긴 요약은 건드리지 않는다.
 */
export function preferDiagnosticSummary(fallbackSummary: string, combinedOutput: string): string {
  if (!combinedOutput) return fallbackSummary;
  if (classifyCircuitError(fallbackSummary)) return fallbackSummary;
  const classified = classifyCircuitError(combinedOutput);
  if (!classified) return fallbackSummary;
  const line = combinedOutput
    .split('\n')
    .find(candidate => candidate.includes(classified.matchedText));
  return (line ?? classified.matchedText).trim().slice(0, 500) || fallbackSummary;
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
  providerAdapter?: string;
  providerModel?: string | null;
  requestedModel?: string;
  modelSelection?: ModelSelectionSource;
  error: unknown;
  fallbackModel: string | null;
}): boolean {
  if (input.providerAdapter !== 'cursor' && input.providerId !== 'cursor-agent') return false;
  if (!input.fallbackModel) return false;
  const selection = input.modelSelection
    ?? (input.requestedModel?.trim() ? 'explicit' : 'provider-default');
  if (selection === 'explicit') return false;

  const providerModel = input.providerModel?.trim().toLowerCase();
  if (
    selection === 'provider-default'
    && providerModel
    && providerModel !== 'cursor'
    && providerModel !== 'auto'
  ) return false;

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
  providerAdapter?: string;
  providerModel?: string | null;
  requestedModel?: string;
  modelSelection?: ModelSelectionSource;
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
  const selection = input.modelSelection
    ?? (input.requestedModel?.trim() ? 'explicit' : 'provider-default');
  const defaultCursorRoute = selection === 'provider-default'
    && (input.providerAdapter === 'cursor' || input.providerId === 'cursor-agent')
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
      providerAdapter: input.providerAdapter,
      providerModel: input.providerModel,
      requestedModel: input.requestedModel,
      modelSelection: selection,
      error,
      fallbackModel,
    })) {
      throw error;
    }

    await input.onFallback?.({
      failedModel: input.requestedModel?.trim() || input.providerModel?.trim() || 'auto',
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
    this.toolExecutor = new AgentToolExecutor(provider.id, sandbox, undefined, undefined, abortSignal);
  }

  async run(
    taskId: string,
    prompt: string,
    options?: {
      systemPrompt?: string;
      compact?: boolean;
      model?: string;
      modelSelection?: ModelSelectionSource;
      projectDir?: string;
      disableHistory?: boolean;
      localNetworkAccess?: boolean;
    },
  ): Promise<LoopResult> {
    this.taskProjectDir = options?.projectDir;
    this.localNetworkAccess = options?.localNetworkAccess === true;
    this.toolExecutor = new AgentToolExecutor(
      this.provider.id,
      this.sandbox,
      taskId,
      options?.projectDir,
      this.abortSignal,
    );
    const agentId = this.provider.id;
    let iterations = 0;
    let totalToolCalls = 0;
    let exitReason: 'completed' | 'max-iterations' | 'circuit-breaker' = 'max-iterations';
    let prematureToolFailureRetries = 0;
    let terminalResponse = '';
    const artifacts: string[] = [];
    const history: Array<{ role: string; content: string }> = [];
    // Schema 하네스: 도구 호출을 관측해 규칙을 세우고, 무익함이 확정된 재호출을 막는다.
    // 태스크마다 새로 만든다 — 규칙은 이 작업의 맥락에서만 유효하다.
    const schema = new SchemaAdvisor(undefined, undefined, 'orchestrated-loop', taskId, agentId);

    // Update agent state
    await sharedState.setAgentState(agentId, {
      status: 'working',
      currentTask: taskId,
    });
    trajectoryGuard.beginTask(taskId, agentId);

    const teamState = await this.buildTeamContext();
    const systemBase = options?.systemPrompt || this.provider.persona.systemPrompt;
    
    // 호출부가 도구 금지를 지시했으면 XML 도구 프로토콜을 아예 붙이지 않는다. 붙이면
    // "Do not use tools." 와 "Do not claim workspace tools are unavailable until you have
    // tried this protocol." 이 같은 시스템 프롬프트에 공존해 지시가 충돌한다(2026-08-06
    // kangnote 정적 분석 → 실패 로그의 opencode 프롬프트에 `## Tools (XML)` 실재 확인).
    // 도구 없이 온 응답은 decideToolFreeOrchestrationResponse 가 이미 정상 처리한다.
    const fullSystem = forbidsTools(systemBase, prompt)
      ? systemBase
      : options?.compact
        ? buildCompactSystemPrompt(systemBase)
        : buildOrchestrationSystemPrompt(systemBase, teamState);

    history.push({ role: 'user', content: prompt });

    try {
      while (iterations < MAX_ORCHESTRATION_ITERATIONS) {
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
      //
      // 이 루프 자신의 호출이 실패하면 callCLI()가 throw 해 while 밖으로 나간다. 따라서 여기
      // 도달한 open 상태는 **항상 같은 프로바이더의 다른 태스크가 연 것**이고, 예전에는 멀쩡히
      // 진행 중인 태스크까지 연좌로 죽였다(젠탑 실측 2026-08-05, 토론 만장일치로 수정 채택).
      // 프로바이더 전체가 못 쓰게 되는 사유(quota·rate-limit·auth)일 때만 중단하고, 다른
      // 태스크의 일시적 generic 실패로는 중단하지 않는다.
      const circuit = circuitBreakerRegistry.getSnapshot(agentId);
      if (circuit.state === 'open') {
        if (circuit.reason === 'quota' || circuit.reason === 'rate-limit' || circuit.reason === 'auth') {
          log.warn({ agentId, iterations, reason: circuit.reason }, 'Agent isolated by Circuit Breaker');
          exitReason = 'circuit-breaker';
          break;
        }
        log.info(
          { agentId, iterations, reason: circuit.reason },
          'Circuit open from another task; continuing this in-flight task',
        );
      }

      // Call AI (single shot)
      await eventBus.publish({
        type: 'agent:status', agentId,
        status: iterations === 1 ? 'thinking' : 'working',
      });

      const aiResponse = await this.callCLI(
        taskId,
        fullSystem,
        history,
        options?.disableHistory === true,
        options?.model,
        options?.modelSelection,
      );
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
        history.push({ role: 'assistant', content: aiResponse });
        this.trimConversationHistory(history);
        const visibleResponse = extractThinking(aiResponse) || aiResponse;
        const decision = decideToolFreeOrchestrationResponse(
          visibleResponse,
          totalToolCalls,
          prematureToolFailureRetries,
        );
        if (decision.action === 'continue') {
          prematureToolFailureRetries = decision.recoveryAttempts;
          history.push({ role: 'user', content: decision.prompt });
          this.trimConversationHistory(history);
          const detail = decision.reason === 'status'
            ? 'provider reported intermediate status'
            : decision.reason === 'contradictory-completion'
              ? 'provider reported unresolved completion evidence'
              : decision.reason === 'premature-incomplete-work'
                ? 'recovering from admitted incomplete repository work'
                : 'recovering from premature workspace-tool failure';
          await eventBus.publish({
            type: 'task:progress', taskId, agentId,
            progress: Math.min(iterations / MAX_ORCHESTRATION_ITERATIONS, 0.95),
            detail: `Iteration ${iterations}: ${detail}`,
          });
          const context = {
            agentId,
            iterations,
            totalToolCalls,
            reason: decision.reason,
            recoveryAttempt: prematureToolFailureRetries,
          };
          if (decision.reason === 'status') {
            log.info(context, 'Continuing after intermediate status response');
          } else {
            log.warn(context, 'Continuing after non-terminal tool-free response');
          }
          continue;
        }
        // A non-status response with no tool calls is a final answer.
        terminalResponse = visibleResponse;
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
          { tool: call.tool, args: call.args, toAgent: call.tool === 'sendMessage' ? call.args.to : null },
        );
        if (!decision.allowed) {
          results.push(`[Tool: ${call.tool}] ERROR: ${decision.reason}`);
          continue;
        }

        // 실행 전 스키마 판정 — 같은 인자로 일관되게 무익했던 호출은 실행하지 않고
        // 그 사실을 결과로 돌려준다. 프로바이더 호출 1회와 이터레이션 1회를 아낀다.
        const suppression = schema.beforeTool({ tool: call.tool, args: call.args });
        if (suppression.suppress) {
          log.info({ agentId, tool: call.tool }, 'Tool call suppressed by schema harness');
          results.push(`[Tool: ${call.tool}] SKIPPED: ${suppression.reason}`);
          continue;
        }

        const result = await this.toolExecutor.execute(call);
        await trajectoryGuard.afterTool(
          { taskId, agentId, sandbox: this.sandbox },
          { tool: call.tool, ok: result.ok, error: result.error ?? null },
        );
        const formattedOutput = formatToolOutput(call, result, MAX_OUTPUT_LEN);
        schema.afterTool(
          { tool: call.tool, args: call.args },
          { ok: result.ok, output: formattedOutput },
        );
        results.push(`[Tool: ${call.tool}] ${result.ok ? 'OK' : 'ERROR'}: ${formattedOutput}`);

        if (call.tool === 'writeFile' || call.tool === 'createFile') {
          artifacts.push(call.args.path);
        }
      }

      // Add AI response + tool results to history
      history.push({ role: 'assistant', content: aiResponse });
      history.push({
        role: 'user',
        content: `Tool results:\n${results.join('\n')}${schema.hint()}\n\nContinue your work.`,
      });
      this.trimConversationHistory(history);

      await eventBus.publish({
        type: 'task:progress', taskId, agentId,
        progress: Math.min(iterations / MAX_ORCHESTRATION_ITERATIONS, 0.95),
        detail: `Iteration ${iterations}: ${toolCalls.length} tools executed`,
      });
      }

      const assistantOutputs = history
        .filter(h => h.role === 'assistant')
        .map(h => extractThinking(h.content))
        .filter(Boolean);

      const fallbackOutputs = assistantOutputs.length > 0 ? assistantOutputs : history
        .filter(h => h.role === 'assistant')
        .map(h => h.content)
        .filter(Boolean);
      const output = chooseOrchestrationOutput(terminalResponse, fallbackOutputs);

      const error = exitReason === 'max-iterations'
        ? `Loop reached maximum iterations (${MAX_ORCHESTRATION_ITERATIONS}) before completion`
        : exitReason === 'circuit-breaker'
          ? 'Loop stopped because the Circuit Breaker denied execution'
          : undefined;

      // 스키마 하네스가 실제로 무엇을 배웠고 몇 회를 아꼈는지 남긴다 —
      // 이 수치가 없으면 하네스가 켜져 있는지조차 사후에 확인할 수 없다.
      log.info({ agentId, taskId, ...schema.stats }, 'Schema harness summary');

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
    modelSelection?: ModelSelectionSource,
  ): Promise<string> {
    return executeWithCursorModelFallback({
      providerId: this.provider.id,
      providerAdapter: resolveProviderRuntime(this.provider).adapter,
      providerModel: this.provider.model,
      requestedModel: model,
      modelSelection,
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
    const runtime = resolveProviderRuntime(this.provider);
    const isCodexAdapter = runtime.adapter === 'codex';

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
    const lastMessageFile = isCodexAdapter
      ? joinPath(tmpdir(), `nco-codex-last-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
      : null;

    // Most CLI AIs accept prompt via stdin or -p flag
    // Adapt per provider
    const invocation = buildOrchestratedCliInvocation(
      this.provider,
      args,
      combined,
      lastMessageFile,
      model,
      this.localNetworkAccess,
    );
    const finalArgs = invocation.args;
    this.assertTaskProjectDir();
    const subagentTracker = isCodexAdapter && runtime.profile !== 'readonly-tool-worker'
      ? new CodexSubagentTracker(taskId, this.provider.id)
      : null;
    let subagentTrackerStopped = false;

    try {
      // [W18/stdin 2026-07-07] codex는 stdin:'ignore'면 "Reading additional input from stdin"에서
      // 멈춰 timeout된다(codex 0.142.5). 빈 input('')을 주면 EOF를 받아 정상 진행한다.
      // (T1: execa stdin:'ignore' → 멈춤 / input:'' → prompt 실행+정상 에러표시 재현)
      const stdinOpt: Record<string, unknown> = invocation.input !== undefined
        ? { input: invocation.input }
        : { stdin: invocation.stdin ?? 'ignore' };
      const providerProcessEnv = buildProviderProcessEnv(
        this.provider.id,
        this.provider.env,
        process.env,
        undefined,
        runtime.adapter,
      );
      const subprocessEnv = runtime.adapter === 'opencode'
        ? applyOpenCodeOrchestrationIsolation(providerProcessEnv, getOpenCodeIsolatedConfigHome())
        : providerProcessEnv;
      // AgentManager's final gate runs before Type B context/event preparation.
      // Recheck at the irreversible boundary as every loop iteration and Cursor
      // model-fallback attempt reaches this method independently.
      requireProviderRateLimitAdmission(
        this.provider.id,
        resolveProviderRateLimitAdmission(this.provider.id),
      );
      const subprocess = execa(command, finalArgs, {
        ...stdinOpt,
        cwd: this.taskProjectDir || undefined,
        ...(this.abortSignal ? { cancelSignal: this.abortSignal } : { timeout: this.sandbox.getTimeout() }),
        forceKillAfterDelay: 3000,
        detached: process.platform !== 'win32',
        maxBuffer: 10 * 1024 * 1024,
        // execa merges process.env back into `env` by default. That would
        // resurrect OpenCode path-based config variables intentionally deleted
        // by applyOpenCodeOrchestrationIsolation(). subprocessEnv already
        // contains the complete inherited environment, so disable the second
        // merge for every provider process.
        extendEnv: false,
        env: {
          ...subprocessEnv,
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

        const opencodeOutput = runtime.adapter === 'opencode'
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
        const diagnosticSummary = preferDiagnosticSummary(fallbackSummary, combinedOutput);
        throw new CliExecutionError(
          `${this.provider.id}: ${reason} — ${diagnosticSummary}`,
          combinedOutput || `[${this.provider.id}: ${reason} — ${diagnosticSummary}]`,
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

      if (runtime.adapter === 'codex') {
        const output = extractCodexJsonlAgentText(result.stdout || '');
        if (output !== undefined) return output;
      }

      if (runtime.adapter === 'opencode') {
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
    const runtime = resolveProviderRuntime(this.provider);
    if (runtime.adapter !== 'codex' || runtime.profile === 'readonly-tool-worker') return;

    const projectDir = this.taskProjectDir?.trim();
    if (!projectDir) {
      throw new Error('codex requires metadata.projectDir: missing task project directory');
    }
    if (!existsSync(projectDir)) {
      throw new Error(`codex requires metadata.projectDir to exist: ${projectDir}`);
    }
  }

  /** Preserve first user message; drop oldest assistant/user pairs beyond MAX_HISTORY_TURNS. */
  private trimConversationHistory(history: Array<{ role: string; content: string }>): void {
    trimOrchestratedConversationHistory(history);
  }

  private async buildTeamContext(): Promise<string> {
    const states = await sharedState.getAllAgentStates();
    const lines = Object.values(states).map(s =>
      `- ${s.id}: ${s.status}${s.currentTask ? ` (working on: ${s.currentTask})` : ''}`
    );
    return lines.join('\n') || 'No agents online';
  }
}
