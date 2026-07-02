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
import { getApiKeys, type ProviderConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('api-executor');

const MAX_ITERATIONS = 10;
const MAX_HISTORY = 24;
const MAX_OUTPUT_LEN = 16000;

interface ApiResult {
  output: string;
  iterations: number;
  toolCalls: number;
  model: string;
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

/**
 * Type C Executor: API-based agents (OpenRouter, Gemini API).
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

  async run(taskId: string, prompt: string, options?: { systemPrompt?: string, compact?: boolean }): Promise<ApiResult> {
    const agentId = this.provider.id;
    let iterations = 0;
    let totalToolCalls = 0;

    const toolExecutor = new AgentToolExecutor(this.provider.id, this.sandbox, taskId);

    await sharedState.setAgentState(agentId, { status: 'working', currentTask: taskId });

    const systemContent = await this.buildSystemPrompt(options?.systemPrompt, options?.compact);
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemContent },
      { role: 'user', content: prompt },
    ];

    const tools = getNcoOpenAiTools();
    let finalOutput = '';
    let useNativeTools = true;

    try {
      while (iterations < MAX_ITERATIONS) {
        iterations++;

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
        const model = this.provider.model || 'default';

        try {
          const createParams: ChatCompletionCreateParamsNonStreaming = {
            model,
            messages,
            max_tokens: 4096,
            stream: false,
          };
          if (useNativeTools) {
            createParams.tools = tools;
            createParams.tool_choice = 'auto';
          }

          const response = await client.chat.completions.create(createParams);

          const msg = response.choices[0]?.message;
          if (!msg) break;

          const textContent = typeof msg.content === 'string' ? msg.content : '';

          await eventBus.publish({
            type: 'task:chunk', taskId, agentId,
            chunk: textContent,
            iteration: iterations,
          });

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
              const result = await toolExecutor.execute({
                tool: tc.function.name,
                args,
              });
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

          const fromText = parseToolCalls(textContent);
          if (fromText.length > 0) {
            messages.push({ role: 'assistant', content: textContent });
            const results: string[] = [];
            for (const call of fromText) {
              totalToolCalls++;
              const result = await toolExecutor.execute(call);
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
          const status = err && typeof err === 'object' && 'status' in err
            ? (err as { status?: number }).status
            : undefined;
          if (status === 429 && this.keys.length > 1) {
            this.cooldowns.set(this.keyIndex, Date.now() + (this.provider.keyRotation?.cooldownMs || 60000));
            this.keyIndex = (this.keyIndex + 1) % this.keys.length;
            log.warn({ agentId, keyIndex: this.keyIndex }, 'Rate limited, rotating key');
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

          if (this.provider.apiConfig?.fallback) {
            log.info({ agentId, fallback: this.provider.apiConfig.fallback.provider }, 'Falling back');
            await eventBus.publish({
              type: 'system:fallback',
              from: agentId,
              to: this.provider.apiConfig.fallback.provider,
              reason: message,
            });
          }

          throw err;
        }
      }
    } finally {
      await sharedState.setAgentState(agentId, { status: 'idle', currentTask: null });
    }

    return {
      output: finalOutput,
      iterations,
      toolCalls: totalToolCalls,
      model: this.provider.model || 'unknown',
    };
  }

  private async buildSystemPrompt(override?: string, compact?: boolean): Promise<string> {
    const base = override || this.provider.persona.systemPrompt;
    if (compact) return buildCompactSystemPrompt(base);
    const teamState = await this.buildTeamContext();
    return buildApiAgentSystemPrompt(base, teamState);
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

    return new OpenAI({
      apiKey: apiKey || 'not-needed',
      baseURL,
      timeout: this.sandbox.getTimeout(),
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
