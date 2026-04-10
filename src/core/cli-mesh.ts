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
export type WorkMode = 'solo' | 'mesh' | 'waiting' | 'blocked' | 'reviewing' | 'done' | 'idle';

/** Structured conflict report between two sessions */
export interface ConflictReport {
  /** What kind of conflict */
  type: 'file' | 'task' | 'branch';
  /** Impact level */
  severity: 'high' | 'medium' | 'low';
  /** Session this conflicts with */
  withSession: string;
  withAgent: string;
  /** Human-readable description */
  detail: string;
  /** Files involved (for file-type conflicts) */
  affectedFiles?: string[];
}

/** Result of a pre-work conflict check */
export interface WorkCheckResult {
  /** True if no high-severity conflicts found */
  safe: boolean;
  conflictReports: ConflictReport[];
  /** Actionable suggestions */
  recommendations: string[];
}

export interface MeshSession {
  sessionId: string;
  agentId: string;
  pid: number;
  status: 'idle' | 'thinking' | 'coding' | 'reviewing' | 'discussing' | 'done';
  /** High-level work mode for monitor display */
  workMode: WorkMode;
  /** Free-text description of current task */
  currentWork: string;
  /** Work description that was completed (for done state display) */
  completedWork?: string;
  currentFiles: string[];
  branch: string;
  /** Optional: task ID this session is working on */
  taskId?: string;
  /** Optional: session IDs of collaborating CLIs (for mesh mode) */
  collaborators?: string[];
  startedAt: string;
  lastHeartbeat: string;
  /** When work was completed */
  completedAt?: string;
  messageQueue: MeshMessage[];
  /** Active conflicts detected at last heartbeat */
  activeConflicts?: ConflictReport[];
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

// ─── Overlap helpers ────────────────────────────────────────

/**
 * Jaccard similarity between two task descriptions (keyword-level).
 * Returns 0..1. Handles Korean/English mixed text.
 */
function taskOverlapScore(a: string, b: string): number {
  const tokenize = (s: string) =>
    s.toLowerCase()
      .split(/[\s\W]+/)
      .filter(w => w.length > 2)
      .reduce((acc, w) => { acc.add(w); return acc; }, new Set<string>());

  const wa = tokenize(a);
  const wb = tokenize(b);
  if (wa.size === 0 && wb.size === 0) return 0;

  let intersection = 0;
  for (const w of wa) if (wb.has(w)) intersection++;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Check if two file lists share a common directory (same module area).
 */
function sharedDirectory(files1: string[], files2: string[]): string[] {
  const dirs1 = files1.map(f => f.split('/').slice(0, -1).join('/'));
  const dirs2 = new Set(files2.map(f => f.split('/').slice(0, -1).join('/')));
  return [...new Set(dirs1.filter(d => d && dirs2.has(d)))];
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
  }): Promise<{ conflicts: string[]; conflictReports: ConflictReport[]; messages: MeshMessage[] }> {
    const now = new Date().toISOString();

    // Infer workMode if not provided
    const inferredMode = (): WorkMode => {
      const st = session.status || 'idle';
      if (st === 'done') return 'done';
      if (session.collaborators && session.collaborators.length > 0) return 'mesh';
      if (st === 'discussing') return 'mesh';
      if (st === 'reviewing') return 'reviewing';
      if (st === 'idle' && !session.currentWork) return 'idle';
      if (['coding', 'thinking'].includes(st)) return 'solo';
      return 'waiting';
    };

    const resolvedWorkMode = session.workMode ?? inferredMode();
    const meshSession: MeshSession = {
      sessionId: session.sessionId,
      agentId: session.agentId,
      pid: session.pid,
      status: (session.status as any) || 'idle',
      workMode: resolvedWorkMode,
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

      // Preserve existing startedAt, messageQueue, and detect done transition
      const existing = await redis.get(key);
      if (existing) {
        const prev: MeshSession = JSON.parse(existing);
        meshSession.startedAt = prev.startedAt;
        meshSession.messageQueue = prev.messageQueue || [];

        // Auto-detect work completion: had work before, now idle with no work
        if (
          prev.currentWork &&
          !session.currentWork &&
          (session.status === 'idle' || !session.status) &&
          resolvedWorkMode !== 'done'
        ) {
          meshSession.workMode = 'done';
          meshSession.status = 'done';
          meshSession.completedWork = prev.currentWork;
          meshSession.completedAt = now;
          // Done sessions expire faster (60s display window)
          await redis.set(key, JSON.stringify(meshSession), 'EX', 60);
          this.persistSession(meshSession);
          await eventBus.publish({ type: 'mesh:heartbeat', sessionId: session.sessionId, agentId: session.agentId, status: 'done', currentWork: '' });
          return { conflicts: [], conflictReports: [], messages: meshSession.messageQueue };
        }

        // Explicit done state
        if (resolvedWorkMode === 'done' && !meshSession.completedAt) {
          meshSession.completedWork = prev.currentWork || session.currentWork || '';
          meshSession.completedAt = now;
        }
      }

      const ttl = resolvedWorkMode === 'done' ? 60 : MESH_TTL;
      await redis.set(key, JSON.stringify(meshSession), 'EX', ttl);

      // Also store agentId alias pointing to the canonical sessionId
      // This allows sendMessage("claude-2") to resolve to the real key
      if (session.agentId && session.agentId !== session.sessionId) {
        await redis.set(`${MESH_PREFIX}alias:${session.agentId}`, session.sessionId, 'EX', MESH_TTL);
      }
    }

    // Persist to SQLite for history
    this.persistSession(meshSession);

    // Full conflict check (non-fatal — don't break heartbeat on error)
    let conflictReports: ConflictReport[] = [];
    try {
      conflictReports = await this.detectAllConflicts(
        session.sessionId,
        session.agentId,
        session.currentWork || '',
        session.currentFiles || [],
        session.branch || 'unknown',
      );
    } catch (err) {
      log.warn({ err, sessionId: session.sessionId }, 'Conflict detection failed, continuing');
    }
    const conflicts = conflictReports.map(r => r.detail);

    // Store conflicts back in session
    meshSession.activeConflicts = conflictReports;

    // Publish presence event
    await eventBus.publish({
      type: 'mesh:heartbeat',
      sessionId: session.sessionId,
      agentId: session.agentId,
      status: meshSession.status,
      currentWork: meshSession.currentWork,
    });

    // Emit conflict warnings
    if (conflictReports.length > 0) {
      await eventBus.publish({
        type: 'mesh:conflict',
        sessionId: session.sessionId,
        conflicts,
        conflictReports,
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

    return { conflicts, conflictReports, messages };
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
   * Comprehensive conflict detection:
   *   1. File conflicts — exact same file being edited
   *   2. Task overlap — similar work description (Jaccard keyword similarity)
   *   3. Branch + directory proximity — same branch, same module area
   */
  async detectAllConflicts(
    mySessionId: string,
    myAgentId: string,
    myWork: string,
    myFiles: string[],
    myBranch: string,
  ): Promise<ConflictReport[]> {
    const sessions = await this.getActiveSessions();
    const reports: ConflictReport[] = [];

    for (const other of sessions) {
      if (other.sessionId === mySessionId) continue;

      // 1. Exact file conflicts (high severity)
      const exactFiles = myFiles.filter(f => other.currentFiles.includes(f));
      if (exactFiles.length > 0) {
        reports.push({
          type: 'file',
          severity: 'high',
          withSession: other.sessionId,
          withAgent: other.agentId,
          detail: `${other.agentId}이(가) 같은 파일 편집 중: ${exactFiles.map(f => f.split('/').pop()).join(', ')}`,
          affectedFiles: exactFiles,
        });
      }

      // 2. Task overlap — keyword Jaccard similarity
      if (myWork && other.currentWork) {
        const score = taskOverlapScore(myWork, other.currentWork);
        if (score >= 0.55) {
          reports.push({
            type: 'task',
            severity: score >= 0.75 ? 'high' : 'medium',
            withSession: other.sessionId,
            withAgent: other.agentId,
            detail: `${other.agentId}와(과) 유사한 작업 중복 가능성 (${Math.round(score * 100)}% 유사): "${other.currentWork.slice(0, 40)}"`,
          });
        }
      }

      // 3. Same branch + shared directory (medium severity, only if files present)
      if (
        myFiles.length > 0 &&
        other.currentFiles.length > 0 &&
        myBranch !== 'unknown' &&
        myBranch === other.branch &&
        exactFiles.length === 0  // already reported above
      ) {
        const sharedDirs = sharedDirectory(myFiles, other.currentFiles);
        if (sharedDirs.length > 0) {
          reports.push({
            type: 'branch',
            severity: 'low',
            withSession: other.sessionId,
            withAgent: other.agentId,
            detail: `${other.agentId}와(과) 같은 브랜치(${myBranch}) + 같은 모듈 영역: ${sharedDirs.map(d => d.split('/').pop()).join(', ')}`,
            affectedFiles: sharedDirs,
          });
        }
      }
    }

    // Sort by severity
    const order = { high: 0, medium: 1, low: 2 };
    return reports.sort((a, b) => order[a.severity] - order[b.severity]);
  }

  /**
   * Pre-work conflict check — call BEFORE starting work to get full analysis.
   * Does NOT register the session, just checks against current state.
   */
  async checkWorkConflicts(
    mySessionId: string,
    myAgentId: string,
    plannedWork: string,
    plannedFiles: string[],
    branch: string,
  ): Promise<WorkCheckResult> {
    const reports = await this.detectAllConflicts(
      mySessionId, myAgentId, plannedWork, plannedFiles, branch,
    );

    const hasHigh = reports.some(r => r.severity === 'high');
    const recommendations: string[] = [];

    const fileConflicts = reports.filter(r => r.type === 'file');
    const taskConflicts = reports.filter(r => r.type === 'task');
    const branchConflicts = reports.filter(r => r.type === 'branch');

    if (fileConflicts.length > 0) {
      recommendations.push(
        `파일 충돌: ${fileConflicts.map(r => r.withAgent).join(', ')}와(과) 작업 조율 필요. /nco-mesh send @${fileConflicts[0].withAgent} "파일 작업 순서 조율 요청"`,
      );
    }
    if (taskConflicts.length > 0) {
      recommendations.push(
        `작업 중복: ${taskConflicts.map(r => r.withAgent).join(', ')}와(과) 역할 분담 확인. 동일 작업을 나눠서 처리하거나 한 세션이 위임하세요.`,
      );
    }
    if (branchConflicts.length > 0) {
      recommendations.push(
        `브랜치 근접: 같은 모듈 영역 수정 시 병합 충돌 가능. 작업 완료 후 pull --rebase 권장.`,
      );
    }
    if (reports.length === 0) {
      recommendations.push('충돌 없음 — 안전하게 작업을 시작할 수 있습니다.');
    }

    log.info(
      { sessionId: mySessionId, safe: !hasHigh, conflictCount: reports.length },
      'Work conflict check',
    );

    return { safe: !hasHigh, conflictReports: reports, recommendations };
  }

  /**
   * Mark a session as "work completed" — transitions to done state.
   * The session stays visible for 60s then expires automatically.
   */
  async complete(sessionId: string, completedWork?: string): Promise<void> {
    const now = new Date().toISOString();
    if (isRedisConnected()) {
      const redis = await getRedis();
      const key = `${MESH_PREFIX}${sessionId}`;
      const raw = await redis.get(key);
      if (raw) {
        const session: MeshSession = JSON.parse(raw);
        session.workMode = 'done';
        session.status = 'done';
        session.completedWork = completedWork || session.currentWork;
        session.completedAt = now;
        session.currentWork = '';
        session.currentFiles = [];
        session.activeConflicts = [];
        await redis.set(key, JSON.stringify(session), 'EX', 60);
      }
    }
    await eventBus.publish({ type: 'mesh:session_update', session: { sessionId, workMode: 'done', completedAt: now } } as any);
    await eventBus.publish({ type: 'mesh:complete', sessionId, completedWork: completedWork || '' });
    log.info({ sessionId, completedWork }, 'Session marked as done');
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
          (session_id, agent_id, pid, status, current_work, current_files_json, branch, started_at, last_heartbeat, active_conflicts_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.sessionId, session.agentId, session.pid,
        session.status, session.currentWork,
        JSON.stringify(session.currentFiles),
        session.branch, session.startedAt, session.lastHeartbeat,
        JSON.stringify(session.activeConflicts || []),
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
          activeConflicts: JSON.parse(r.active_conflicts_json || '[]'),
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
