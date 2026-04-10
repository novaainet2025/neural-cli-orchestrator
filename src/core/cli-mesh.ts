import { existsSync } from 'fs';
import { getRedis, isRedisConnected } from '../storage/redis.js';
import { getDb } from '../storage/database.js';
import { eventBus } from './event-bus.js';
import { createId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('cli-mesh');

/** Check if a PID is still alive (0 or negative = skip check) */
function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return true; // No valid PID — assume alive
  try {
    // /proc/<pid> exists on Linux if the process is alive
    if (existsSync(`/proc/${pid}`)) return true;
    // Fallback: signal 0 checks existence without killing
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const MESH_PREFIX = 'nco:mesh:';
const MESH_TTL = 300; // 5min — sessions expire if no heartbeat

/**
 * CLI Mesh — Real-time awareness between running CLI sessions.
 *
 * Each CLI (claude-code, codex, gemini, etc.) registers with the mesh:
 *   - Who am I (agent id, PID)
 *   - What am I working on (current task description, files being edited)
 *   - Status (thinking, coding, idle, reviewing)
 *
 * Other CLIs can query the mesh to:
 *   - See who else is online
 *   - Avoid editing the same files (conflict detection)
 *   - Send direct messages
 *   - Coordinate work
 */

/** High-level work mode — shown prominently in the monitor UI */
export type WorkMode = 'solo' | 'mesh' | 'waiting' | 'blocked' | 'reviewing';

export interface MeshSession {
  sessionId: string;
  agentId: string;
  pid: number;
  status: 'idle' | 'thinking' | 'coding' | 'reviewing' | 'discussing';
  /** High-level work mode for monitor display */
  workMode: WorkMode;
  /** Free-text description of current task */
  currentWork: string;
  currentFiles: string[];
  branch: string;
  /** Optional: task ID this session is working on */
  taskId?: string;
  /** Optional: session IDs of collaborating CLIs (for mesh mode) */
  collaborators?: string[];
  startedAt: string;
  lastHeartbeat: string;
  messageQueue: MeshMessage[];
}

export interface MeshMessage {
  id: string;
  from: string;           // sessionId of sender
  fromAgent: string;      // agentId (e.g., 'claude-code')
  to: string;             // sessionId of recipient ('*' for broadcast)
  content: string;
  type: 'info' | 'warning' | 'request' | 'conflict';
  createdAt: string;
  read: boolean;
}

class CliMesh {
  /**
   * Register/update a CLI session in the mesh.
   */
  async heartbeat(session: {
    sessionId: string;
    agentId: string;
    pid: number;
    status?: string;
    workMode?: WorkMode;
    currentWork?: string;
    currentFiles?: string[];
    branch?: string;
    taskId?: string;
    collaborators?: string[];
  }): Promise<{ conflicts: string[]; messages: MeshMessage[] }> {
    const now = new Date().toISOString();

    // Infer workMode if not provided
    const inferredMode = (): WorkMode => {
      const st = session.status || 'idle';
      if (session.collaborators && session.collaborators.length > 0) return 'mesh';
      if (st === 'discussing') return 'mesh';
      if (st === 'reviewing') return 'reviewing';
      if (st === 'idle' && !session.currentWork) return 'waiting';
      if (['coding', 'thinking'].includes(st)) return 'solo';
      return 'waiting';
    };

    const meshSession: MeshSession = {
      sessionId: session.sessionId,
      agentId: session.agentId,
      pid: session.pid,
      status: (session.status as any) || 'idle',
      workMode: session.workMode ?? inferredMode(),
      currentWork: session.currentWork || '',
      currentFiles: session.currentFiles || [],
      branch: session.branch || 'unknown',
      taskId: session.taskId,
      collaborators: session.collaborators || [],
      startedAt: now,
      lastHeartbeat: now,
      messageQueue: [],
    };

    // Register in Redis FIRST (before conflict check, so session is visible)
    if (isRedisConnected()) {
      const redis = await getRedis();
      const key = `${MESH_PREFIX}${session.sessionId}`;

      // Preserve existing startedAt and messageQueue
      const existing = await redis.get(key);
      if (existing) {
        const prev = JSON.parse(existing);
        meshSession.startedAt = prev.startedAt;
        meshSession.messageQueue = prev.messageQueue || [];
      }

      await redis.set(key, JSON.stringify(meshSession), 'EX', MESH_TTL);

      // Also store agentId alias pointing to the canonical sessionId
      // This allows sendMessage("claude-2") to resolve to the real key
      if (session.agentId && session.agentId !== session.sessionId) {
        await redis.set(`${MESH_PREFIX}alias:${session.agentId}`, session.sessionId, 'EX', MESH_TTL);
      }
    }

    // Persist to SQLite for history
    this.persistSession(meshSession);

    // Check for file conflicts (non-fatal — don't break heartbeat on error)
    let conflicts: string[] = [];
    try {
      conflicts = await this.detectConflicts(session.sessionId, session.currentFiles || []);
    } catch (err) {
      log.warn({ err, sessionId: session.sessionId }, 'Conflict detection failed, continuing');
    }

    // Publish presence event
    await eventBus.publish({
      type: 'mesh:heartbeat',
      sessionId: session.sessionId,
      agentId: session.agentId,
      status: meshSession.status,
      currentWork: meshSession.currentWork,
    });

    // Emit conflict warnings
    if (conflicts.length > 0) {
      await eventBus.publish({
        type: 'mesh:conflict',
        sessionId: session.sessionId,
        conflicts,
      });
    }

    // Drain pending messages
    const messages = meshSession.messageQueue;
    if (messages.length > 0) {
      meshSession.messageQueue = [];
      if (isRedisConnected()) {
        const redis = await getRedis();
        await redis.set(`${MESH_PREFIX}${session.sessionId}`, JSON.stringify(meshSession), 'EX', MESH_TTL);
      }
    }

    return { conflicts, messages };
  }

  /**
   * Get all active sessions in the mesh.
   * Automatically removes zombie sessions (PID no longer alive).
   */
  async getActiveSessions(): Promise<MeshSession[]> {
    if (!isRedisConnected()) return this.getSessionsFromDb();

    const redis = await getRedis();
    const keys = await redis.keys(`${MESH_PREFIX}*`);
    const sessions: MeshSession[] = [];

    for (const key of keys) {
      if (key.includes(':alias:')) continue; // skip alias keys
      const raw = await redis.get(key);
      if (!raw) continue;

      const session: MeshSession = JSON.parse(raw);

      // Zombie check: if PID is dead, clean up and skip
      if (!isPidAlive(session.pid)) {
        log.info({ sessionId: session.sessionId, pid: session.pid, agentId: session.agentId }, 'Reaping zombie session');
        await redis.del(key);
        this.markSessionDisconnected(session.sessionId);
        continue;
      }

      sessions.push(session);
    }

    return sessions.sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  /**
   * Send a message to a specific session or broadcast to all.
   */
  async sendMessage(
    fromSessionId: string,
    fromAgent: string,
    toSessionId: string,  // '*' for broadcast
    content: string,
    type: MeshMessage['type'] = 'info',
  ): Promise<number> {
    const message: MeshMessage = {
      id: createId('msg'),
      from: fromSessionId,
      fromAgent,
      to: toSessionId,
      content,
      type,
      createdAt: new Date().toISOString(),
      read: false,
    };

    let delivered = 0;

    if (!isRedisConnected()) return 0;
    const redis = await getRedis();

    if (toSessionId === '*') {
      // Broadcast to all active sessions
      const keys = await redis.keys(`${MESH_PREFIX}*`);
      for (const key of keys) {
        if (key.includes(':alias:')) continue; // skip alias keys
        const raw = await redis.get(key);
        if (!raw) continue;
        const session: MeshSession = JSON.parse(raw);
        if (session.sessionId === fromSessionId) continue; // skip self
        session.messageQueue.push(message);
        await redis.set(key, JSON.stringify(session), 'EX', MESH_TTL);
        delivered++;
      }
    } else {
      // Direct message — try exact key first, then resolve agentId alias
      let resolvedId = toSessionId;
      const aliasKey = `${MESH_PREFIX}alias:${toSessionId}`;
      const aliasVal = await redis.get(aliasKey);
      if (aliasVal) resolvedId = aliasVal;

      const key = `${MESH_PREFIX}${resolvedId}`;
      const raw = await redis.get(key);
      if (raw) {
        const session: MeshSession = JSON.parse(raw);
        session.messageQueue.push(message);
        await redis.set(key, JSON.stringify(session), 'EX', MESH_TTL);
        delivered = 1;
      }
    }

    // Persist message
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO mesh_messages (id, from_session, from_agent, to_session, content, type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(message.id, fromSessionId, fromAgent, toSessionId, content, type, message.createdAt);
    } catch { /* non-critical */ }

    await eventBus.publish({
      type: 'mesh:message',
      messageId: message.id,
      from: fromSessionId,
      fromAgent,
      to: toSessionId,
      messageType: type,
    });

    log.info({ from: fromAgent, to: toSessionId, type, delivered }, 'Mesh message sent');
    return delivered;
  }

  /**
   * Detect file conflicts — which other sessions are editing the same files?
   */
  async detectConflicts(mySessionId: string, myFiles: string[]): Promise<string[]> {
    if (myFiles.length === 0) return [];

    const sessions = await this.getActiveSessions();
    const conflicts: string[] = [];

    for (const other of sessions) {
      if (other.sessionId === mySessionId) continue;

      const overlapping = myFiles.filter(f => other.currentFiles.includes(f));
      if (overlapping.length > 0) {
        conflicts.push(
          `${other.agentId} (${other.sessionId.slice(0, 8)}) is also editing: ${overlapping.join(', ')}`
        );
      }
    }

    return conflicts;
  }

  /**
   * Remove a session from the mesh (disconnect).
   */
  async disconnect(sessionId: string): Promise<void> {
    if (isRedisConnected()) {
      const redis = await getRedis();
      await redis.del(`${MESH_PREFIX}${sessionId}`);
    }

    await eventBus.publish({
      type: 'mesh:disconnect',
      sessionId,
    });

    log.info({ sessionId }, 'Session disconnected from mesh');
  }

  /**
   * Get a summary of what all agents are currently doing.
   */
  async getWorkSummary(): Promise<string> {
    const sessions = await this.getActiveSessions();
    if (sessions.length === 0) return 'No active CLI sessions.';

    return sessions.map(s => {
      const files = s.currentFiles.length > 0 ? ` [${s.currentFiles.slice(0, 3).join(', ')}]` : '';
      return `• ${s.agentId} (${s.status}): ${s.currentWork || 'idle'}${files}`;
    }).join('\n');
  }

  // ─── DB Persistence ────────────────────────────────
  private persistSession(session: MeshSession): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT OR REPLACE INTO mesh_sessions
          (session_id, agent_id, pid, status, current_work, current_files_json, branch, started_at, last_heartbeat)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.sessionId, session.agentId, session.pid,
        session.status, session.currentWork,
        JSON.stringify(session.currentFiles),
        session.branch, session.startedAt, session.lastHeartbeat,
      );
    } catch { /* non-critical */ }
  }

  private getSessionsFromDb(): MeshSession[] {
    try {
      const db = getDb();
      const rows = db.prepare(`
        SELECT * FROM mesh_sessions
        WHERE last_heartbeat > datetime('now', '-2 minutes')
        ORDER BY agent_id
      `).all() as any[];

      const alive: MeshSession[] = [];
      for (const r of rows) {
        if (!isPidAlive(r.pid)) {
          log.info({ sessionId: r.session_id, pid: r.pid }, 'Reaping zombie session from DB');
          this.markSessionDisconnected(r.session_id);
          continue;
        }
        alive.push({
          sessionId: r.session_id,
          agentId: r.agent_id,
          pid: r.pid,
          status: r.status,
          currentWork: r.current_work,
          currentFiles: JSON.parse(r.current_files_json || '[]'),
          branch: r.branch,
          startedAt: r.started_at,
          lastHeartbeat: r.last_heartbeat,
          workMode: (r.work_mode ?? 'autonomous') as any,
          messageQueue: [],
        });
      }
      return alive;
    } catch {
      return [];
    }
  }

  /** Mark a session as disconnected in SQLite */
  private markSessionDisconnected(sessionId: string): void {
    try {
      const db = getDb();
      db.prepare(`
        UPDATE mesh_sessions SET status = 'disconnected', last_heartbeat = datetime('now', '-1 hour')
        WHERE session_id = ?
      `).run(sessionId);
    } catch { /* non-critical */ }
  }

  /**
   * Get recent messages for/from a session.
   */
  getMessageHistory(sessionId: string, limit = 20): any[] {
    try {
      const db = getDb();
      return db.prepare(`
        SELECT * FROM mesh_messages
        WHERE from_session = ? OR to_session = ? OR to_session = '*'
        ORDER BY created_at DESC LIMIT ?
      `).all(sessionId, sessionId, limit);
    } catch {
      return [];
    }
  }
}

export const cliMesh = new CliMesh();
