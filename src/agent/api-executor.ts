import OpenAI from 'openai';
import { AgentToolExecutor } from './agent-tools.js';
import { parseToolCalls, extractThinking } from './tool-parser.js';
import { SandboxManager } from '../security/sandbox-manager.js';
import { eventBus } from '../core/event-bus.js';
import { sharedState } from '../core/shared-state.js';
import { getApiKeys, type ProviderConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('api-executor');

const MAX_ITERATIONS = 15;

interface ApiResult {
  output: string;
  iterations: number;
  toolCalls: number;
  model: string;
}

/**
 * Type C Executor: API-based agents (vLLM, OpenRouter, Gemini API).
 * Uses OpenAI-compatible API with streaming + key rotation.
 */
export class ApiExecutor {
  private toolExecutor: AgentToolExecutor;
  private keys: string[] = [];
  private keyIndex = 0;
  private cooldowns: Map<number, number> = new Map();

  constructor(
    private provider: ProviderConfig,
    private sandbox: SandboxManager,
  ) {
    this.toolExecutor = new AgentToolExecutor(provider.id, sandbox);

    // Load API keys with rotation
    if (provider.keyRotation?.enabled && provider.keyRotation.envVar) {
      this.keys = getApiKeys(provider.keyRotation.envVar, provider.keyRotation.delimiter);
      log.info({ provider: provider.id, keyCount: this.keys.length }, 'API keys loaded');
    } else if (provider.apiKeyRef) {
      const key = process.env[provider.apiKeyRef];
      if (key) this.keys = [key];
    }
  }

  async run(taskId: string, prompt: string, systemPrompt?: string): Promise<ApiResult> {
    const agentId = this.provider.id;
    let iterations = 0;
    let totalToolCalls = 0;

    await sharedState.setAgentState(agentId, { status: 'working', currentTask: taskId });

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: systemPrompt || this.provider.persona.systemPrompt,
      },
      { role: 'user', content: prompt },
    ];

    let finalOutput = '';

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      if (!this.sandbox.canExecute()) break;

      const client = this.createClient();
      const model = this.provider.model || 'default';

      try {
        const response = await client.chat.completions.create({
          model,
          messages,
          max_tokens: 4096,
          stream: true,
        });

        let fullResponse = '';
        for await (const chunk of response) {
          const token = chunk.choices[0]?.delta?.content || '';
          fullResponse += token;

          await eventBus.publish({
            type: 'task:chunk', taskId, agentId,
            chunk: token, iteration: iterations,
          });
        }

        this.sandbox.recordSuccess();

        // Check for tool calls
        const toolCalls = parseToolCalls(fullResponse);

        if (toolCalls.length === 0) {
          finalOutput = extractThinking(fullResponse);
          break;
        }

        // Execute tools
        const results: string[] = [];
        for (const call of toolCalls) {
          totalToolCalls++;
          const result = await this.toolExecutor.execute(call);
          results.push(`[${call.tool}] ${result.ok ? 'OK' : 'ERROR'}: ${result.output || result.error}`);
        }

        messages.push({ role: 'assistant', content: fullResponse });
        messages.push({ role: 'user', content: `Tool results:\n${results.join('\n')}\n\nContinue.` });

      } catch (err: any) {
        // Rate limit → rotate key
        if (err.status === 429 && this.keys.length > 1) {
          this.cooldowns.set(this.keyIndex, Date.now() + (this.provider.keyRotation?.cooldownMs || 60000));
          this.keyIndex = (this.keyIndex + 1) % this.keys.length;
          log.warn({ agentId, keyIndex: this.keyIndex }, 'Rate limited, rotating key');
          continue; // retry with next key
        }

        this.sandbox.recordFailure(err.message);

        // Fallback to secondary provider
        if (this.provider.apiConfig?.fallback) {
          log.info({ agentId, fallback: this.provider.apiConfig.fallback.provider }, 'Falling back');
          await eventBus.publish({
            type: 'system:fallback',
            from: agentId,
            to: this.provider.apiConfig.fallback.provider,
            reason: err.message,
          });
        }

        throw err;
      }
    }

    await sharedState.setAgentState(agentId, { status: 'idle', currentTask: null });

    return {
      output: finalOutput,
      iterations,
      toolCalls: totalToolCalls,
      model: this.provider.model || 'unknown',
    };
  }

  private createClient(): OpenAI {
    const apiKey = this.getNextKey();
    const baseURL = this.provider.endpoint || this.provider.apiConfig?.primary.baseUrl;

    return new OpenAI({
      apiKey: apiKey || 'not-needed',
      baseURL,
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

    // All keys on cooldown — use the one that expires soonest
    let earliest = Infinity;
    let bestIdx = 0;
    for (const [idx, cd] of this.cooldowns) {
      if (cd < earliest) { earliest = cd; bestIdx = idx; }
    }
    this.keyIndex = bestIdx;
    return this.keys[bestIdx];
  }
}
