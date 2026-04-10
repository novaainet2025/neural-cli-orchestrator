import { OrchestratedLoop } from './orchestrated-loop.js';
import { ApiExecutor } from './api-executor.js';
import { agentManager } from './agent-manager.js';
import { createSandbox } from '../security/sandbox-manager.js';
import { eventBus } from '../core/event-bus.js';
import { sharedState } from '../core/shared-state.js';
import { getDb } from '../storage/database.js';
import { env, type ProviderConfig } from '../utils/config.js';
import { createSessionId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('session-manager');

export interface AgentSession {
  id: string;
  agentId: string;
  prompt: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  iterations: number;
  toolCalls: number;
  output: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
  abortController?: AbortController;
  pendingApproval?: {
    toolCall: any;
    resolve: (approved: boolean) => void;
  };
}

class AgentSessionManager {
  private sessions = new Map<string, AgentSession>();

  /**
   * Start a new agent session. Runs the agent in background.
   * Returns immediately with sessionId.
   */
  async startSession(
    prompt: string,
    agentId: string,
    options?: { systemPrompt?: string; autoApprove?: boolean },
  ): Promise<string> {
    const provider = agentManager.getProvider(agentId);
    if (!provider) throw new Error(`Unknown agent: ${agentId}`);

    const sessionId = createSessionId();
    const abortController = new AbortController();

    const session: AgentSession = {
      id: sessionId,
      agentId,
      prompt,
      status: 'running',
      iterations: 0,
      toolCalls: 0,
      output: '',
      createdAt: new Date().toISOString(),
      abortController,
    };

    this.sessions.set(sessionId, session);

    // Persist to DB
    this.persistSession(session);

    // Run in background (non-blocking)
    this.executeInBackground(session, provider, options).catch(err => {
      log.error({ sessionId, err: err.message }, 'Session execution failed');
    });

    await eventBus.publish({
      type: 'agent:session_started',
      sessionId,
      agentId,
    });

    log.info({ sessionId, agentId }, 'Session started');
    return sessionId;
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  listSessions(): AgentSession[] {
    return Array.from(this.sessions.values())
      .map(s => ({ ...s, abortController: undefined, pendingApproval: undefined }));
  }

  listActiveSessions(): AgentSession[] {
    return this.listSessions().filter(s => s.status === 'running');
  }

  /**
   * Abort a running session — kills subprocess via AbortController.
   */
  async abortSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'running') return false;

    session.abortController?.abort();
    session.status = 'aborted';
    session.completedAt = new Date().toISOString();

    this.persistSession(session);

    await eventBus.publish({
      type: 'agent:session_aborted',
      sessionId,
      agentId: session.agentId,
    });

    log.info({ sessionId }, 'Session aborted');
    return true;
  }

  /**
   * Approve a pending tool call in a session.
   */
  approveAction(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.pendingApproval) return false;

    session.pendingApproval.resolve(true);
    session.pendingApproval = undefined;

    log.info({ sessionId }, 'Action approved');
    return true;
  }

  /**
   * Reject a pending tool call in a session.
   */
  rejectAction(sessionId: string, reason?: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.pendingApproval) return false;

    session.pendingApproval.resolve(false);
    session.pendingApproval = undefined;

    log.info({ sessionId, reason }, 'Action rejected');
    return true;
  }

  /**
   * Request approval for a dangerous tool call.
   * Emits WebSocket event and waits for approve/reject.
   */
  async requestApproval(sessionId: string, toolCall: any): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return true; // no session = auto-approve

    return new Promise<boolean>((resolve) => {
      session.pendingApproval = { toolCall, resolve };

      eventBus.publish({
        type: 'agent:tool_approval_required',
        sessionId,
        agentId: session.agentId,
        toolCall,
      });

      // Auto-approve after 60s timeout to prevent blocking forever
      setTimeout(() => {
        if (session.pendingApproval) {
          session.pendingApproval.resolve(true);
          session.pendingApproval = undefined;
          log.info({ sessionId }, 'Approval auto-granted (timeout)');
        }
      }, 60_000);
    });
  }

  // ─── Background Execution ──────────────────────────
  private async executeInBackground(
    session: AgentSession,
    provider: ProviderConfig,
    options?: { systemPrompt?: string; autoApprove?: boolean },
  ): Promise<void> {
    try {
      const result = await agentManager.executeTask(session.agentId, session.prompt, {
        taskId: session.id,
        systemPrompt: options?.systemPrompt,
        signal: session.abortController?.signal,
      });

      session.output = result.output;
      session.iterations = result.iterations;
      session.toolCalls = result.toolCalls;
      session.status = result.success ? 'completed' : 'failed';
      session.error = result.error;
      session.completedAt = new Date().toISOString();

    } catch (err: any) {
      session.status = session.status === 'aborted' ? 'aborted' : 'failed';
      session.error = err.message;
      session.completedAt = new Date().toISOString();
    }

    this.persistSession(session);

    await eventBus.publish({
      type: `agent:session_${session.status}`,
      sessionId: session.id,
      agentId: session.agentId,
      iterations: session.iterations,
      toolCalls: session.toolCalls,
    });

    log.info({ sessionId: session.id, status: session.status, iterations: session.iterations }, 'Session ended');
  }

  // ─── DB Persistence ────────────────────────────────
  private persistSession(session: AgentSession): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT OR REPLACE INTO agent_sessions
          (id, agent_id, prompt, status, iterations, tool_calls, artifacts_json, error, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.id,
        session.agentId,
        session.prompt,
        session.status,
        session.iterations,
        session.toolCalls,
        '[]',
        session.error || null,
        session.createdAt,
        session.completedAt || null,
      );
    } catch {
      // Non-critical
    }
  }

  /**
   * Load completed sessions from DB (for listing history).
   */
  getSessionsFromDb(limit = 20): any[] {
    try {
      const db = getDb();
      return db.prepare(
        'SELECT * FROM agent_sessions ORDER BY created_at DESC LIMIT ?'
      ).all(limit);
    } catch {
      return [];
    }
  }

  destroy(): void {
    // Abort all running sessions
    for (const session of this.sessions.values()) {
      if (session.status === 'running') {
        session.abortController?.abort();
      }
    }
    this.sessions.clear();
  }
}

export const sessionManager = new AgentSessionManager();
