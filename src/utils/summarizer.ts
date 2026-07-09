import { createLogger } from './logger.js';

const log = createLogger('summarizer');

/**
 * Summarize a text string.
 * Uses a simple heuristic if no AI is available,
 * or can be extended to use a cheap local/API model.
 */
export async function summarizeText(
  text: string,
  maxLength = 500,
  options?: {
    agentId?: string;
    useAi?: boolean;
  }
): Promise<string> {
  if (!text || text.length <= maxLength) return text;
  const truncateToMaxLength = (value: string): string => {
    if (value.length <= maxLength) return value;
    if (maxLength <= 3) return value.slice(0, maxLength);
    return `${value.slice(0, maxLength - 3)}...`;
  };

  // If AI is requested and agentManager is available, try to use a cheap model
  if (options?.useAi) {
    try {
      const { agentManager } = await import('../agent/agent-manager.js');
      const { sortProvidersByCostOrder } = await import('../core/smart-router.js');
      
      const cheapAgents = sortProvidersByCostOrder(agentManager.listEnabledIds());
      const agentId = options.agentId || cheapAgents[0]; // mlx, openrouter, etc.

      if (agentId) {
        const prompt = `Summarize the following text to under ${maxLength} characters:\n\n${text.slice(0, 10000)}`;
        const result = await agentManager.executeTask(agentId, prompt, {
          systemPrompt: 'You are a summarization assistant. Be brief and preserve key points.',
          signal: AbortSignal.timeout(10000),
        });

        if (result.success && result.output) {
          return truncateToMaxLength(result.output.trim());
        }

        throw new Error(`AI summarization failed: success=${String(result.success)}`);
      }

      throw new Error('AI summarization failed: no enabled agent available');
    } catch (err: any) {
      log.warn({ err: err.message }, 'AI summarization failed');
      throw err;
    }
  }

  // Heuristic-based summarization (truncation + key points)
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length <= 5) return truncateToMaxLength(text);

  const summary = [
    lines[0], // First line (often a header or intro)
    '...',
    lines[Math.floor(lines.length / 2)], // Middle line
    '...',
    lines[lines.length - 1], // Last line
  ].join('\n');

  return truncateToMaxLength(summary);
}
