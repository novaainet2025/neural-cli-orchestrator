import OpenAI from 'openai';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { AgentToolExecutor } from './agent-tools.js';
import { parseToolCalls, extractThinking } from './tool-parser.js';
import { buildApiAgentSystemPrompt, getNcoOpenAiTools, buildCompactSystemPrompt } from './nco-orchestration-prompt.js';
import { SandboxManager } from '../security/sandbox-manager.js';
import { eventBus } from '../core/event-bus.js';
import { sharedState } from '../core/shared-state.js';
import { taskQueue } from '../core/task-queue.js';
import { getApiKeys, getProvider, type ProviderConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { trajectoryGuard } from '../security/trajectory-guard.js';
import { resolveProviderModel } from '../utils/mlx-models.js';

const log = createLogger('api-executor');

const MAX_ITERATIONS = 10;
const MAX_HISTORY = 24;
const MAX_OUTPUT_LEN = 16000;
const MAX_RETRYABLE_HTTP_RETRIES = 2;

interface RunOptions {
  systemPrompt?: string;
  compact?: boolean;
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  attemptedProviders?: string[];
  messages?: ChatCompletionMessageParam[];
}

interface ApiResult {
  output: string;
  iterations: number;
  toolCalls: number;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  success?: boolean;
  error?: string;
}

function jsonArgsToStringRecord(raw: string): Record<string, string> {
  let obj: unknown;
  try {
    obj = JSON.parse(raw || '{}');
  } catch {
    return {};
  }
  if (!obj || typeof obj !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

function isLikelyToolsUnsupportedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  const status =
    err && typeof err === 'object' && 'status' in err
      ? Number((err as { status?: number }).status)
      : NaN;
  if (status === 422) return true;
  return (
    (lower.includes('tools') && (lower.includes('not supported') || lower.includes('unknown'))) ||
    lower.includes('tool_choice') ||
    (lower.includes('function') && lower.includes('not support'))
  );
}

function getErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object' || !('status' in err)) return undefined;
  const status = Number((err as { status?: number }).status);
  return Number.isFinite(status) ? status : undefined;
}

export function isRetryableHttpError(err: unknown): boolean {
  const status = getErrorStatus(err);
  return status === 408 || status === 429;
}

function getRetryDelayMs(attempt: number): number {
  return 1000 * Math.min(attempt, 3);
}

function withAbortSignal<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation();

  const requestController = new AbortController();
  if (signal.aborted) {
    requestController.abort(signal.reason);
    return Promise.reject(new Error(signal.reason instanceof Error ? signal.reason.message : 'cancelled'));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      requestController.abort(signal.reason);
      reject(new Error(signal.reason instanceof Error ? signal.reason.message : 'cancelled'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    operation(requestController.signal).then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      err => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

/**
 * Type C Executor: API-based agents (OpenRouter, NVIDIA, etc.).
 * OpenAI-compatible API with key rotation, native tool_calls (Claude-parity) + XML fallback.
 */
export class ApiExecutor {
  private keys: string[] = [];
  private keyIndex = 0;
  private cooldowns: Map<number, number> = new Map();

  constructor(
    private provider: ProviderConfig,
    private sandbox: SandboxManager,
  ) {
    if (provider.keyRotation?.enabled && provider.keyRotation.envVar) {
      this.keys = getApiKeys(provider.keyRotation.envVar, provider.keyRotation.delimiter);
      log.info({ provider: provider.id, keyCount: this.keys.length }, 'API keys loaded');
    } else if (provider.apiKeyRef) {
      const key = process.env[provider.apiKeyRef];
      if (key) this.keys = [key];
    }
  }

  private resolveTaskModel(modelOverride?: string): string | null {
    return resolveProviderModel({
      id: this.provider.id,
      model: modelOverride ?? this.provider.model,
      endpoint: this.provider.endpoint,
    });
  }

  async run(taskId: string, prompt: string, options?: RunOptions): Promise<ApiResult> {
    const attemptedProviders = new Set(options?.attemptedProviders ?? []);
    attemptedProviders.add(this.provider.id);
    const agentId = this.provider.id;
    let iterations = 0;
    let rateLimitRotations = 0;
    let retryableHttpRetries = 0;
    let totalToolCalls = 0;
    const usage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    const credentialError = this.getCredentialPreflightError();
    if (credentialError) {
      const error = `credential preflight failed: ${credentialError}`;
      return {
        output: error,
        iterations,
        toolCalls: totalToolCalls,
        model: this.resolveTaskModel(options?.model) || 'unknown',
        success: false,
        error,
      };
    }

    const toolExecutor = new AgentToolExecutor(this.provider.id, this.sandbox, taskId);

    await sharedState.setAgentState(agentId, { status: 'working', currentTask: taskId });
    trajectoryGuard.beginTask(taskId, agentId);

    const systemContent = await this.buildSystemPrompt(options?.systemPrompt, options?.compact);
    const messages: ChatCompletionMessageParam[] = options?.messages
      ? [...options.messages]
      : [
          { role: 'system', content: systemContent },
          { role: 'user', content: prompt },
        ];

    const tools = getNcoOpenAiTools();
    let finalOutput = '';
    let useNativeTools = true;

    try {
      while (iterations < MAX_ITERATIONS) {
        iterations++;
        taskQueue.recordActivity(taskId);
        if (options?.signal?.aborted) {
          throw new Error(taskQueue.getAbortReason(taskId) || 'cancelled');
        }

        // Token optimization: Trim conversation history (keeping system + first user + last N)
        if (messages.length > MAX_HISTORY + 2) {
          const sys = messages[0] as ChatCompletionMessageParam;
          const initialUser = messages[1] as ChatCompletionMessageParam;
          const recent = messages.slice(-MAX_HISTORY);
          messages.length = 0;
          messages.push(sys, initialUser, ...recent);
        }

        if (!this.sandbox.canExecute()) break;

        const client = this.createClient();
        const model = this.resolveTaskModel(options?.model) || 'default';

        try {
          const createParams: ChatCompletionCreateParamsNonStreaming = {
            model,
            messages,
            max_tokens: 4096,
            stream: false,
          };
          // [2026-07-09] rep_penalty 1.25는 구 Qwen3-Coder EOS 폭주 대응책 — Instruct-2507로
          // 단일화된 현재는 과도해 정밀 답변(숫자·조건 필터)을 왜곡한다. MLX는 temp를 올리고
          // rep penalty를 기본치로 복귀시켜 경직된 응답을 완화한다.
          if (this.provider.id === 'mlx') {
            (createParams as unknown as Record<string, unknown>).repetition_penalty = 1.0;
            (createParams as unknown as Record<string, unknown>).repetition_context_size = 4096;
            createParams.temperature = 0.5;
          }
          if (useNativeTools) {
            createParams.tools = tools;
            createParams.tool_choice = 'auto';
          }

          const response = await withAbortSignal(
            requestSignal => client.chat.completions.create(createParams, { signal: requestSignal }),
            withTimeoutSignal(options?.signal, this.sandbox.getApiTimeout()),
          );
          usage.promptTokens += response.usage?.prompt_tokens ?? 0;
          usage.completionTokens += response.usage?.completion_tokens ?? 0;
          usage.totalTokens += response.usage?.total_tokens ?? 0;
          retryableHttpRetries = 0;

          const msg = response.choices[0]?.message;
          if (!msg) break;

          // NIM Nemotron 등 reasoner 모델은 본문을 content가 아닌 reasoning_content에
          // 넣는다 — content만 읽으면 빈 결과가 completed로 기록됨 (2026-07-03 실측)
          // NIM 등 일부 프로바이더는 content를 문자열 대신 콘텐츠 파트 배열
          // ([{type:'text',text:'...'}])로 반환한다 (2026-07-03 nvidia 실측:
          // contentType=object, completion_tokens>0인데 문자열 추출 실패).
          // reasoner 모델은 본문을 reasoning_content에 넣기도 한다.
          const rawContent: unknown = msg.content;
          let textContent = '';
          if (typeof rawContent === 'string') {
            textContent = rawContent;
          } else if (Array.isArray(rawContent)) {
            textContent = rawContent
              .map(p => typeof p === 'string' ? p : (p as { text?: unknown })?.text)
              .filter((t): t is string => typeof t === 'string')
              .join('');
          } else if (rawContent && typeof rawContent === 'object') {
            const t = (rawContent as { text?: unknown }).text;
            if (typeof t === 'string') textContent = t;
          }
          let fromReasoningFallback = false;
          if (!textContent) {
            // NIM: reasoning_content / Ollama(0.20+ thinking 모델): reasoning
            const m = msg as { reasoning_content?: unknown; reasoning?: unknown };
            if (typeof m.reasoning_content === 'string') textContent = m.reasoning_content;
            else if (typeof m.reasoning === 'string') textContent = m.reasoning;
            if (textContent) fromReasoningFallback = true;
          }

          if (!textContent && !msg.tool_calls?.length) {
            // 빈 응답 원인 추적용 — 어떤 필드/finish_reason으로 비었는지 남긴다
            log.warn({
              agentId, taskId,
              finishReason: response.choices[0]?.finish_reason,
              contentType: typeof msg.content,
              msgKeys: Object.keys(msg),
              usage: response.usage,
            }, 'empty content from provider response');
          }

          await eventBus.publish({
            type: 'task:chunk', taskId, agentId,
            chunk: textContent,
            iteration: iterations,
          });
          taskQueue.recordActivity(taskId, textContent);

          if (useNativeTools && msg.tool_calls?.length) {
            messages.push({
              role: 'assistant',
              content: msg.content ?? null,
              tool_calls: msg.tool_calls,
            });

            for (const tc of msg.tool_calls) {
              if (tc.type !== 'function') continue;
              totalToolCalls++;
              const args = jsonArgsToStringRecord(tc.function.arguments ?? '');
              log.debug({ agentId, tool: tc.function.name, args: JSON.stringify(args).slice(0, 200) }, 'Tool call');
              const decision = await trajectoryGuard.beforeTool(
                { taskId, agentId, sandbox: this.sandbox },
                { tool: tc.function.name, toAgent: tc.function.name === 'sendMessage' ? args.to : null },
              );
              if (!decision.allowed) {
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: `[${tc.function.name}] ERROR: ${decision.reason}`,
                });
                continue;
              }
              const result = await toolExecutor.execute({
                tool: tc.function.name,
                args,
              });
              await trajectoryGuard.afterTool(
                { taskId, agentId, sandbox: this.sandbox },
                { tool: tc.function.name, ok: result.ok, error: result.error ?? null },
              );
              taskQueue.recordActivity(taskId, `[tool:${tc.function.name}]`);
              const outRaw = result.output || result.error || '';
              log.debug({ agentId, tool: tc.function.name, ok: result.ok, outputLen: outRaw.length }, 'Tool result');
              const truncated = outRaw.length > MAX_OUTPUT_LEN
                ? outRaw.slice(0, MAX_OUTPUT_LEN) + `\n\n... (truncated ${outRaw.length - MAX_OUTPUT_LEN} chars)`
                : outRaw;
              const summary = `[${tc.function.name}] ${result.ok ? 'OK' : 'ERROR'}: ${truncated}`;
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: summary,
              });
            }
            continue;
          }

          // [2026-07-09 codex 리뷰] 도구 인젝션 차단: (a) reasoning 폴백 텍스트에서는 도구 실행 금지
          // (모델이 '생각만 한' 도구 구문이 실행되는 경로), (b) <think> 블록은 파싱 전에 제거.
          const parseSource = fromReasoningFallback
            ? ''
            : textContent.replace(/<think>[\s\S]*?<\/think>/g, '');
          const fromText = parseSource ? parseToolCalls(parseSource) : [];
          if (fromText.length > 0) {
            messages.push({ role: 'assistant', content: textContent });
            const results: string[] = [];
            for (const call of fromText) {
              totalToolCalls++;
              const decision = await trajectoryGuard.beforeTool(
                { taskId, agentId, sandbox: this.sandbox },
                { tool: call.tool, toAgent: call.tool === 'sendMessage' ? call.args.to : null },
              );
              if (!decision.allowed) {
                results.push(`[${call.tool}] ERROR: ${decision.reason}`);
                continue;
              }
              const result = await toolExecutor.execute(call);
              await trajectoryGuard.afterTool(
                { taskId, agentId, sandbox: this.sandbox },
                { tool: call.tool, ok: result.ok, error: result.error ?? null },
              );
              taskQueue.recordActivity(taskId, `[tool:${call.tool}]`);
              const outRaw = result.output || result.error || '';
              const truncated = outRaw.length > MAX_OUTPUT_LEN 
                ? outRaw.slice(0, MAX_OUTPUT_LEN) + `\n\n... (truncated ${outRaw.length - MAX_OUTPUT_LEN} chars)`
                : outRaw;
              results.push(`[${call.tool}] ${result.ok ? 'OK' : 'ERROR'}: ${truncated}`);
            }
            messages.push({
              role: 'user',
              content: `Tool results:\n${results.join('\n')}\n\nContinue.`,
            });
            continue;
          }

          finalOutput = extractThinking(textContent);
          break;
        } catch (err: unknown) {
          const status = getErrorStatus(err);
          if (status === 429 && this.keys.length > 1) {
            // 무한 회전 방지: 전 키가 rate-limit이면 iterations--가 MAX_ITERATIONS를
            // 무력화해 태스크가 영구 hang이었다 (2026-07-03 openrouter 7키 실측).
            rateLimitRotations++;
            if (rateLimitRotations > this.keys.length * 2) {
              throw new Error(`rate limited (429) on all ${this.keys.length} keys after ${rateLimitRotations} rotations`);
            }
            this.cooldowns.set(this.keyIndex, Date.now() + (this.provider.keyRotation?.cooldownMs || 60000));
            this.keyIndex = (this.keyIndex + 1) % this.keys.length;
            log.warn({ agentId, keyIndex: this.keyIndex, rateLimitRotations }, 'Rate limited, rotating key');
            await new Promise(r => setTimeout(r, 1000 * Math.min(rateLimitRotations, 10)));
            iterations--;
            continue;
          }

          if (isRetryableHttpError(err) && retryableHttpRetries < MAX_RETRYABLE_HTTP_RETRIES) {
            retryableHttpRetries++;
            const delayMs = getRetryDelayMs(retryableHttpRetries);
            log.warn({ agentId, status, retryableHttpRetries, delayMs }, 'Retryable API error, retrying same provider');
            await new Promise(r => setTimeout(r, delayMs));
            iterations--;
            continue;
          }

          if (useNativeTools && isLikelyToolsUnsupportedError(err)) {
            log.warn(
              { agentId, err: err instanceof Error ? err.message : String(err) },
              'Disabling native tools; using XML tool protocol only',
            );
            useNativeTools = false;
            iterations--;
            continue;
          }

          const message = err instanceof Error ? err.message : String(err);
          const fallbackProviderId = this.provider.apiConfig?.fallback?.provider;

          if (fallbackProviderId && !attemptedProviders.has(fallbackProviderId)) {
            const fallbackProvider = getProvider(fallbackProviderId);
            if (fallbackProvider?.enabled) {
              log.info({ agentId, fallback: fallbackProviderId }, 'Falling back');
              await eventBus.publish({
                type: 'system:fallback',
                from: agentId,
                to: fallbackProviderId,
                reason: message,
              });
              return new ApiExecutor(fallbackProvider, this.sandbox).run(taskId, prompt, {
                ...options,
                attemptedProviders: [...attemptedProviders],
                messages: [...messages],
              });
            }
          }

          throw err;
        }
      }
    } finally {
      trajectoryGuard.endTask(taskId, agentId);
      await sharedState.setAgentState(agentId, { status: 'idle', currentTask: null });
    }

    // 빈 완료를 성공으로 기록하면 위임자가 결과 유실을 감지 못한다 (nvidia 빈 결과 사건)
    if (!finalOutput.trim()) {
      const emptyError = new Error(`empty completion from provider '${agentId}' after ${iterations} iteration(s)`);
      const fallbackProviderId = this.provider.apiConfig?.fallback?.provider;
      if (fallbackProviderId && !attemptedProviders.has(fallbackProviderId)) {
        const fallbackProvider = getProvider(fallbackProviderId);
        if (fallbackProvider?.enabled) {
          await eventBus.publish({
            type: 'system:fallback',
            from: agentId,
            to: fallbackProviderId,
            reason: emptyError.message,
          });
          return new ApiExecutor(fallbackProvider, this.sandbox).run(taskId, prompt, {
            ...options,
            attemptedProviders: [...attemptedProviders],
            messages: [...messages],
          });
        }
      }
      throw emptyError;
    }

    return {
      output: finalOutput,
      iterations,
      toolCalls: totalToolCalls,
      model: this.resolveTaskModel(options?.model) || 'unknown',
      usage,
    };
  }

  private async buildSystemPrompt(override?: string, compact?: boolean): Promise<string> {
    const base = override || this.provider.persona.systemPrompt;
    if (compact) return buildCompactSystemPrompt(base);
    const teamState = await this.buildTeamContext();
    let systemContent = buildApiAgentSystemPrompt(base, teamState);
    // 로컬 툴유저는 도구 호출 예산을 소폭 완화하되 루프는 막는다.
    if (['mlx', 'ollama', 'mlx-instruct', 'hermes'].includes(this.provider.id)) {
      const maxToolUses = ['mlx', 'ollama'].includes(this.provider.id) ? 4 : 3;
      systemContent += '\n\n[출력 규칙] 1) 지식으로 답할 수 있는 질문은 도구 없이 즉시 평문으로 답하라. '
        + `2) 파일 읽기/검색/명령 실행이 실제로 필요할 때만 아래 형식으로 도구를 호출하라 (한 번에 하나, 최대 ${maxToolUses}회 사용 후 반드시 최종 답변):\n`
        + '<function=runCommand>\n<parameter=command>ls -la</parameter>\n</function>\n'
        + '사용 가능 도구: readFile(path), writeFile(path,content), editFile(path,old,new), listFiles(path), '
        + 'searchCode(query,path), runCommand(command), gitStatus(), gitDiff()\n'
        + '3) 최종 답변은 요청 형식을 정확히 지켜라 — 사족·검증문구·괄호주석 금지. '
        + '4) 질문의 조건(필터·범위·단위·확장자 등)을 정확히 적용한 값을 답하라. '
        + '5) 코드를 요구받지 않았다면 코드를 출력하지 말고 도구로 확인한 결과 값을 답하라. '
        + 'Answer with ONLY the requested content. No preamble, no extra text.';
    }
    return systemContent;
  }

  private getCredentialPreflightError(): string | null {
    // 키 불필요 프로바이더(ollama/mlx 등 apiKeyRef·keyRotation 미선언 로컬)는 preflight 대상 아님 —
    // 없으면 'no API keys configured'→auth immediateOpen 오분류 (2026-07-03 ollama 부팅 트립 실측)
    const requiresKey = Boolean(this.provider.keyRotation?.enabled || this.provider.apiKeyRef);
    if (!requiresKey) return null;

    if (this.keys.length === 0) {
      return 'no API keys configured';
    }

    if (this.keys.every(key => key.trim().length < 20)) {
      return 'all API keys are shorter than 20 characters';
    }

    return null;
  }

  private async buildTeamContext(): Promise<string> {
    const states = await sharedState.getAllAgentStates();
    const lines = Object.values(states).map(s =>
      `- ${s.id}: ${s.status}${s.currentTask ? ` (working on: ${s.currentTask})` : ''}`,
    );
    return lines.join('\n') || 'No agents online';
  }

  private createClient(): OpenAI {
    const apiKey = this.getNextKey();
    const baseURL = this.provider.endpoint || this.provider.apiConfig?.primary.baseUrl;

    // 로컬 엔드포인트(mlx/ollama)는 단일스레드 서버 경합으로 일시적 connection
    // refused가 정상 범주 — SDK 재시도 2회로 흡수 (2026-07-08 실측: mlx-server
    // POST 200인데 동시요청 경합으로 "Connection error." 실패, circuit open 유발).
    // 원격 API는 기존대로 0: 429 Retry-After(최대 수시간) sleep hang 방지.
    const isLocalEndpoint = /localhost|127\.0\.0\.1/.test(baseURL || '');

    return new OpenAI({
      apiKey: apiKey || 'not-needed',
      baseURL,
      // maxRetries 0: SDK 내부 재시도는 429의 Retry-After(실측 openrouter 일일한도
      // 소진 시 31162s)를 존중하며 잠들어 태스크가 시간 단위로 hang한다.
      // 429/오류는 즉시 throw시켜 우리 키 회전 루프가 제어하도록 한다.
      maxRetries: isLocalEndpoint ? 2 : 0,
      timeout: this.sandbox.getApiTimeout(),
    });
  }

  private getNextKey(): string {
    if (this.keys.length === 0) return '';

    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.keyIndex + i) % this.keys.length;
      const cooldown = this.cooldowns.get(idx) || 0;
      if (now > cooldown) {
        this.keyIndex = idx;
        return this.keys[idx];
      }
    }

    let earliest = Infinity;
    let bestIdx = 0;
    for (const [idx, cd] of this.cooldowns) {
      if (cd < earliest) { earliest = cd; bestIdx = idx; }
    }
    this.keyIndex = bestIdx;
    return this.keys[bestIdx];
  }
}
