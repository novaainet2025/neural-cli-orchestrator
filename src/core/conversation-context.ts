/**
 * ConversationContext — workspace-scoped conversation history
 *
 * Loads the last N completed tasks for a workspace from SQLite and
 * formats them as a conversation history header that gets prepended
 * to the agent's system prompt.
 *
 * This lets sequential /api/task calls within the same workspace
 * share context without the client having to manage state.
 */

import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('conversation-context');

// How many previous turns to include (keeps prompt size reasonable)
const MAX_HISTORY_TURNS = 5;
const MAX_TOTAL_HISTORY_CHARS = 4000;
const MAX_TURN_RESPONSE_CHARS = 600;

export interface HistoryTurn {
  prompt: string;
  response: string;
  agentId: string;
  completedAt: string;
}

/**
 * Load the most recent completed tasks for a workspace and format
 * them as a conversation history string.
 *
 * Returns null if there's no history (first turn) or workspace is 'default'
 * with no meaningful prior context.
 */
export function buildConversationContext(
  workspaceId: string,
  currentTaskId: string,
): string | null {
  if (!workspaceId || workspaceId === 'none') return null;

  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT prompt, response, assigned_to, completed_at
      FROM tasks
      WHERE workspace_id = ?
        AND status = 'completed'
        AND id != ?
        AND response IS NOT NULL
        AND length(response) > 0
      ORDER BY completed_at DESC
      LIMIT ?
    `).all(workspaceId, currentTaskId, MAX_HISTORY_TURNS) as Array<{
      prompt: string;
      response: string;
      assigned_to: string;
      completed_at: string;
    }>;

    if (rows.length === 0) return null;

    // Reverse so oldest first (natural reading order)
    const turns = rows.reverse();

    const lines: string[] = [
      `## Context (${workspaceId})`,
      '',
    ];

    let totalChars = 0;
    for (const t of turns) {
      const promptSnippet = t.prompt.length > 200 ? t.prompt.slice(0, 200) + '...' : t.prompt;
      // Truncate long responses to keep prompt size bounded
      const truncated = t.response.length > MAX_TURN_RESPONSE_CHARS
        ? t.response.slice(0, MAX_TURN_RESPONSE_CHARS) + '... [truncated]'
        : t.response;

      const turnText = `User: ${promptSnippet}\n${t.assigned_to}: ${truncated}\n\n`;
      
      if (totalChars + turnText.length > MAX_TOTAL_HISTORY_CHARS) {
        break;
      }
      
      lines.push(turnText);
      totalChars += turnText.length;
    }

    lines.push('---');
    return lines.join('\n');
  } catch (err: any) {
    log.warn({ err: err.message, workspaceId }, 'Failed to load conversation context');
    return null;
  }
}

/**
 * Inject conversation history into a system prompt.
 * Returns the original systemPrompt unchanged if there's no history.
 */
export function injectContext(
  systemPrompt: string | undefined,
  workspaceId: string,
  currentTaskId: string,
): string | undefined {
  const history = buildConversationContext(workspaceId, currentTaskId);
  if (!history) return systemPrompt;

  return systemPrompt
    ? `${history}\n\n${systemPrompt}`
    : history;
}
