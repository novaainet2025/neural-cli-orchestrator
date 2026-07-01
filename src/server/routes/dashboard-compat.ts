/**
 * Dashboard compatibility routes — NCO-Dashboard 프론트엔드 계약 호환
 * Vite 플러그인이 처리하던 180+ 라우트 중 핵심만 구현
 */
import type { FastifyInstance } from 'fastify';
import { getDb } from '../../storage/database.js';
import { sharedState } from '../../core/shared-state.js';
import { agentManager } from '../../agent/agent-manager.js';
import { eventBus } from '../../core/event-bus.js';
import { discussionEngine } from '../../core/discussion-engine.js';
import { createTaskId, createSessionId, createMessageId } from '../../utils/id.js';
import { env } from '../../utils/config.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const IS_CLIENTS_DIR = join(process.env.HOME ?? '/Users/nova-ai', '.claude', 'data', 'inter-session', 'clients');

// 살아있는 .session 파일 찾기
function findActiveSessionState(): any | null {
  try {
    const files = readdirSync(IS_CLIENTS_DIR).filter(f => f.endsWith('.session'));
    for (const f of files) {
      try {
        const state = JSON.parse(readFileSync(join(IS_CLIENTS_DIR, f), 'utf-8'));
        const pid = state?.listener_pid;
        if (!pid) continue;
        try { process.kill(Number(pid), 0); return state; } catch {}
      } catch {}
    }
  } catch {}
  return null;
}

// inter-session 서버에 ws 모듈로 list 요청
async function listInterSessions(): Promise<Array<{
  name: string; label: string; cwd: string; since: string; id: string;
  isNco: boolean; host: string;
}>> {
  try {
    const state = findActiveSessionState();
    if (!state) return [];

    const host = state.host ?? '127.0.0.1';
    const port = state.port ?? 9473;

    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://${host}:${port}/`);
      const timer = setTimeout(() => { ws.terminate(); resolve([]); }, 6000);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          op: 'hello',
          session_id: randomUUID(),
          name: 'nco-backend-ctrl',
          label: '',
          cwd: process.cwd(),
          pid: process.pid,
          role: 'control',
          for_session: state.session_id,
          nonce: state.nonce,
          token: state.token,
        }));
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.op === 'welcome') {
            ws.send(JSON.stringify({ op: 'list' }));
          } else if (msg.op === 'list_ok') {
            clearTimeout(timer);
            ws.close();
            const sessions = (msg.sessions ?? []).map((s: any) => {
              const name: string = s.name || '(unnamed)';
              const hostMatch = name.match(/^(.+?)-claude-\d+/);
              const h = hostMatch ? hostMatch[1] : name.startsWith('nco-') ? 'nco' : name;
              const sinceMs = s.since ? Date.now() - new Date(s.since).getTime() : 0;
              const sinceSec = Math.floor(sinceMs / 1000);
              const sinceStr = sinceSec < 60 ? `${sinceSec}s` : sinceSec < 3600 ? `${Math.floor(sinceSec/60)}m` : `${Math.floor(sinceSec/3600)}h`;
              return { name, label: s.label ?? '', cwd: s.cwd ?? '', since: sinceStr, id: (s.session_id ?? '').slice(0, 8), isNco: name.startsWith('nco-'), host: h };
            });
            resolve(sessions);
          } else if (msg.op === 'error') {
            clearTimeout(timer);
            ws.close();
            resolve([]);
          }
        } catch {}
      });

      ws.on('error', () => { clearTimeout(timer); resolve([]); });
      ws.on('close', () => { clearTimeout(timer); resolve([]); });
    });
  } catch {
    return [];
  }
}

// ═══ CB 자동 복구 타이머 (2분마다 open CB 헬스체크 후 리셋) ═══════
let cbAutoHealTimer: ReturnType<typeof setInterval> | null = null;

async function startCbAutoHeal() {
  if (cbAutoHealTimer) return; // 이미 실행 중
  cbAutoHealTimer = setInterval(async () => {
    try {
      for (const [id, provider] of (agentManager as any).providers as Map<string, any>) {
        const sandbox = agentManager.getSandbox(id);
        if (!sandbox) continue;
        const cbJson = sandbox.circuitBreaker?.toJSON?.() as any;
        if (cbJson?.state !== 'open') continue;

        // open CB → 헬스체크 커맨드 실행
        const hc = provider.healthCheck;
        if (!hc?.command) {
          // healthCheck.command 없으면 그냥 리셋
          sandbox.circuitBreaker.reset();
          await sharedState.setAgentState(id, {
            health: { consecutiveFailures: 0, circuitState: 'closed', lastError: null },
            status: 'online',
          });
          continue;
        }

        try {
          await execFileAsync(hc.command, hc.args ?? [], { timeout: hc.timeout ?? 8000 });
          // 헬스체크 통과 → CB 리셋
          sandbox.circuitBreaker.reset();
          await sharedState.setAgentState(id, {
            health: { consecutiveFailures: 0, circuitState: 'closed', lastError: null },
            status: 'online',
          });
        } catch {
          // 헬스체크 실패 → CB 유지 (에이전트 실제 사용 불가)
        }
      }
    } catch { /* 예외 무시 */ }
  }, 2 * 60 * 1000); // 2분
}

export async function registerDashboardRoutes(app: FastifyInstance) {
  // CB 자동 복구 타이머 시작
  startCbAutoHeal().catch(() => {});

  // ═══ Debug ══════════════════════════════════════════
  app.get('/api/debug/is', async () => {
    const peers = await listInterSessions();
    return { peers: peers.length, first: peers[0]?.name ?? null, clientsDir: IS_CLIENTS_DIR };
  });

  // ═══ Task Master / Kanban ═══════════════════════════
  app.get('/api/task-master/tasks', async (req) => {
    const db = getDb();
    const rawLimit = Number((req.query as any).limit || 100);
    const limit = Math.min(Number.isFinite(rawLimit) ? rawLimit : 100, 200);
    return { tasks: db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) };
  });

  app.get('/api/task-master/stats', async () => {
    const db = getDb();
    const total = (db.prepare('SELECT COUNT(*) as c FROM tasks').get() as any).c;
    const byStatus: Record<string, number> = {};
    const rows = db.prepare('SELECT status, COUNT(*) as c FROM tasks GROUP BY status').all() as any[];
    for (const r of rows) byStatus[r.status] = r.c;
    return { total, byStatus };
  });

  app.get('/api/task-master/workspaces', async () => {
    const db = getDb();
    const rows = db.prepare('SELECT DISTINCT workspace_id FROM tasks').all() as any[];
    return { workspaces: rows.map(r => r.workspace_id) };
  });

  app.get('/api/v2/tasks', async (req) => {
    const db = getDb();
    const rawLimit = Number((req.query as any).limit || 100);
    const limit = Math.min(Number.isFinite(rawLimit) ? rawLimit : 100, 200);
    return { tasks: db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) };
  });

  app.get('/api/kanban/tasks', async () => {
    const db = getDb();
    return { tasks: db.prepare('SELECT * FROM tasks ORDER BY priority DESC, created_at DESC LIMIT 200').all() };
  });

  app.post('/api/kanban/tasks', async (req) => {
    const body = req.body as any;
    const id = createTaskId();
    const db = getDb();
    db.prepare(`INSERT INTO tasks (id, mode, prompt, status, workspace_id, priority) VALUES (?, 'task', ?, 'pending', ?, ?)`)
      .run(id, body.title || body.prompt || '', body.workspace || 'default', body.priority || 0);
    return { task: db.prepare('SELECT * FROM tasks WHERE id=?').get(id) };
  });

  app.patch('/api/kanban/tasks/:id', async (req) => {
    const { id } = req.params as any;
    const body = req.body as any;
    const db = getDb();
    if (body.status) db.prepare("UPDATE tasks SET status=?, updated_at=datetime('now') WHERE id=?").run(body.status, id);
    if (body.assigned_to) db.prepare("UPDATE tasks SET assigned_to=?, updated_at=datetime('now') WHERE id=?").run(body.assigned_to, id);
    return { task: db.prepare('SELECT * FROM tasks WHERE id=?').get(id) };
  });

  app.delete('/api/kanban/tasks/:id', async (req) => {
    const { id } = req.params as any;
    getDb().prepare('DELETE FROM tasks WHERE id=?').run(id);
    return { ok: true };
  });

  // ═══ Collaboration ══════════════════════════════════
  app.post('/api/collaboration/sessions', async (req) => {
    const body = req.body as any;
    const id = createSessionId();
    const db = getDb();
    db.prepare(`INSERT INTO discussions (id, topic, mode, status, participants_json, initiator) VALUES (?, ?, 'discussion', 'active', ?, ?)`)
      .run(id, body.title || body.description || '', JSON.stringify(body.participants || []), 'user');
    return { session: { id, session_id: id } };
  });

  app.post('/api/collaboration/message', async (req) => {
    const body = req.body as any;
    const db = getDb();
    db.prepare(`INSERT INTO agent_messages (id, from_agent, to_agent, content, message_type, session_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(createMessageId(), body.from, body.to, body.message, body.type || 'direct', body.session_id);
    return { ok: true };
  });

  app.post('/api/collaboration/sessions/:id/complete', async (req) => {
    const { id } = req.params as any;
    const body = req.body as any;
    getDb().prepare("UPDATE discussions SET status='completed', report=?, ended_at=datetime('now') WHERE id=?")
      .run(body.summary || '', id);
    return { ok: true };
  });

  app.get('/api/collaboration/sessions', async () => {
    return { sessions: getDb().prepare('SELECT * FROM discussions ORDER BY created_at DESC LIMIT 50').all() };
  });

  // ═══ Realtime Sessions ══════════════════════════════
  app.get('/api/realtime-sessions', async () => {
    return { sessions: getDb().prepare("SELECT * FROM discussions WHERE mode IN ('realtime','discussion','consensus','hive') ORDER BY created_at DESC LIMIT 50").all() };
  });

  app.get('/api/realtime-sessions/:id', async (req, reply) => {
    const { id } = req.params as any;
    const session = getDb().prepare('SELECT * FROM discussions WHERE id=?').get(id);
    if (!session) { reply.code(404); return { error: 'Not found' }; }
    return { session };
  });

  app.get('/api/realtime-sessions/:id/messages', async (req) => {
    const { id } = req.params as any;
    return { messages: getDb().prepare('SELECT * FROM discussion_messages WHERE discussion_id=? ORDER BY created_at').all(id) };
  });

  // ═══ Plans ══════════════════════════════════════════
  app.get('/api/plans', async () => {
    // Plans table not yet created — return empty for now
    return { plans: [] };
  });

  app.post('/api/plans', async (req) => {
    return { plan: { id: createSessionId(), ...(req.body as any) } };
  });

  // ═══ Rate Limits (extended) ═════════════════════════
  app.get('/api/rate-limits/state', async () => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM rate_limit_state').all() as any[];
    const providers: Record<string, any> = {};
    for (const r of rows) providers[r.agent_id] = r;

    const allIds = agentManager.listEnabledIds();
    const available = allIds.filter(id => !providers[id]?.is_limited);
    const limited = allIds.filter(id => providers[id]?.is_limited);

    return {
      success: true,
      state: {
        providers,
        availableProviders: available,
        limitedProviders: limited,
        lastUpdated: Date.now(),
        systemStatus: limited.length > allIds.length / 2 ? 'degraded' : 'healthy',
      },
    };
  });

  app.post('/api/rate-limits/state', async (req) => {
    const body = req.body as any;
    if (body.provider) {
      const db = getDb();
      db.prepare(`INSERT OR REPLACE INTO rate_limit_state (agent_id, is_limited, reason, limited_at, reset_at, updated_at) VALUES (?, ?, ?, datetime('now'), ?, datetime('now'))`)
        .run(body.provider, body.isLimited ? 1 : 0, body.reason || null, body.resetTime || null);
    }
    return { ok: true };
  });

  // ═══ Daemons (extended) ═════════════════════════════
  app.get('/api/daemons/by-workspace', async (req) => {
    const workspaceId = (req.query as any).workspaceId || 'default';
    const states = await sharedState.getAllAgentStates();
    const db = getDb();
    const taskCounts = db.prepare('SELECT assigned_to, COUNT(*) as c FROM tasks WHERE workspace_id=? GROUP BY assigned_to').all(workspaceId) as any[];
    const countMap: Record<string, number> = {};
    for (const r of taskCounts) countMap[r.assigned_to] = r.c;

    const daemons = agentManager.listProviders().map(p => {
      const status = states[p.id]?.status || 'offline';
      return {
        id: p.id, name: p.id, status,
        ai_status: status,
        running: status !== 'offline', role: p.role,
        tasks: { active: countMap[p.id] || 0 },
      };
    });
    return { success: true, data: { workspaceId, daemons } };
  });

  app.post('/api/daemons/:name/start', async (req) => {
    const { name } = req.params as any;
    await sharedState.setAgentState(name, { status: 'idle' });
    await eventBus.publish({ type: 'agent:online', agentId: name });
    return { ok: true, message: `${name} started` };
  });

  app.post('/api/daemons/:name/stop', async (req) => {
    const { name } = req.params as any;
    await sharedState.setAgentState(name, { status: 'offline' });
    await eventBus.publish({ type: 'agent:offline', agentId: name });
    return { ok: true, message: `${name} stopped` };
  });

  app.post('/api/daemons/:name/restart', async (req) => {
    const { name } = req.params as any;
    await sharedState.setAgentState(name, { status: 'idle' });
    return { ok: true, message: `${name} restarted` };
  });

  app.post('/api/daemons/start-all', async () => {
    for (const id of agentManager.listEnabledIds()) {
      await sharedState.setAgentState(id, { status: 'idle' });
    }
    return { ok: true };
  });

  app.post('/api/daemons/stop-all', async () => {
    for (const id of agentManager.listEnabledIds()) {
      await sharedState.setAgentState(id, { status: 'offline' });
    }
    return { ok: true };
  });

  app.post('/api/daemons/restart-all', async () => {
    for (const id of agentManager.listEnabledIds()) {
      await sharedState.setAgentState(id, { status: 'idle' });
    }
    return { ok: true };
  });

  // ═══ Chat (extended) ════════════════════════════════
  app.get('/api/chat/messages', async (req) => {
    const db = getDb();
    const workspaceId = (req.query as any).workspaceId || 'default';
    return { workspaceId, messages: db.prepare("SELECT * FROM tasks WHERE workspace_id=? AND mode LIKE 'chat%' ORDER BY created_at DESC LIMIT 100").all(workspaceId) };
  });

  app.delete('/api/chat/messages', async (req) => {
    const workspaceId = (req.query as any).workspaceId || 'default';
    getDb().prepare("DELETE FROM tasks WHERE workspace_id=? AND mode LIKE 'chat%'").run(workspaceId);
    return { ok: true };
  });

  app.get('/api/chat/workspaces', async () => {
    const rows = getDb().prepare('SELECT DISTINCT workspace_id FROM tasks').all() as any[];
    return { workspaces: rows.map(r => r.workspace_id) };
  });

  // ═══ Agent API — moved to gateway.ts ════════════════

  // ═══ Workspace ══════════════════════════════════════
  app.get('/api/workspace', async () => {
    return { workspace: { id: 'default', projectDir: env.PROJECT_DIR } };
  });

  // ═══ Features ═══════════════════════════════════════
  app.get('/api/features/sync', async () => {
    return { features: {} };
  });

  app.post('/api/features/sync', async () => {
    return { ok: true };
  });

  // ═══ Learning ═══════════════════════════════════════
  app.get('/api/learn/search', async (req) => {
    try {
      const { knowledgeBase } = await import('../../core/knowledge-base.js');
      const { q, keywords, project, limit } = req.query as any;
      const searchTerms = q || keywords;
      if (!searchTerms) return { data: [], message: 'q or keywords parameter required' };
      return { data: knowledgeBase.query(searchTerms, project, Number(limit) || 10) };
    } catch {
      return { data: [] };
    }
  });

  app.get('/api/learning', async () => {
    try {
      const { knowledgeBase } = await import('../../core/knowledge-base.js');
      const entries = knowledgeBase.getContext(process.cwd(), 20);
      return { data: entries };
    } catch {
      return { data: [] };
    }
  });

  app.get('/api/history', async () => {
    return { history: [] };
  });

  // ═══ Checkpoints ════════════════════════════════════
  app.get('/api/checkpoints', async () => {
    return { checkpoints: [] };
  });

  // ═══ File API ═══════════════════════════════════════
  app.get('/api/file-api/tree', async (req) => {
    const targetPath = (req.query as any).path || env.PROJECT_DIR;
    try {
      const { readdirSync, statSync } = await import('fs');
      const entries = readdirSync(targetPath, { withFileTypes: true }).slice(0, 100);
      const tree = entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
      }));
      return { tree, path: targetPath };
    } catch {
      return { tree: [], path: targetPath, error: 'Cannot read directory' };
    }
  });

  // ═══ Mesh ═══════════════════════════════════════════
  app.get('/api/mesh/status', async () => {
    return { nodes: [], status: 'inactive' };
  });

  app.get('/api/mesh/team', async () => {
    const states = await sharedState.getAllAgentStates();
    const nodes = Object.entries(states).map(([id, s]) => ({
      id, role: agentManager.getProvider(id)?.role, status: s.status,
    }));
    return { nodes };
  });

  // ═══ Session Notes (맥락노트 + 개선노트) ══════════════
  app.get('/api/notes', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const home = os.homedir();

    // 맥락노트 읽기
    const ctxPath = path.join(home, 'projects', 'context_note.md');
    let contextNote = { exists: false, content: '', mtime: '' };
    try {
      const stat = fs.statSync(ctxPath);
      contextNote = {
        exists: true,
        content: fs.readFileSync(ctxPath, 'utf-8'),
        mtime: stat.mtime.toISOString(),
      };
    } catch {}

    // 개선노트 목록 읽기 (최근 20개)
    const impDir = path.join(home, '.claude', 'improvements');
    const improvementNotes: any[] = [];
    try {
      const files = fs.readdirSync(impDir)
        .filter((f: string) => f.endsWith('.md') && !f.includes('INDEX'))
        .sort()
        .reverse()
        .slice(0, 20);
      for (const f of files) {
        const fpath = path.join(impDir, f);
        const stat = fs.statSync(fpath);
        const content = fs.readFileSync(fpath, 'utf-8');
        // before→after 테이블 추출
        const baMatch = content.match(/Before\s*→\s*After.*?\n(\|[\s\S]*?)(?=\n###|$)/);
        const baTable = baMatch ? baMatch[1].trim() : '';
        // 권장 개선사항 추출
        const nextMatch = content.match(/권장 개선사항[^\n]*\n((?:\d+\..*\n?){1,5})/);
        const nextItems = nextMatch ? nextMatch[1].trim() : '';
        // 점수 추출
        const scoreMatch = content.match(/점수:\s*(\S+)/);
        improvementNotes.push({
          filename: f,
          mtime: stat.mtime.toISOString(),
          content,
          baTable,
          nextItems,
          score: scoreMatch ? scoreMatch[1] : '-',
        });
      }
    } catch {}

    // 맥락노트 이전 세션 히스토리 읽기
    const histDir = path.join(home, 'projects', 'context_history');
    const contextHistory: any[] = [];
    try {
      const files = fs.readdirSync(histDir)
        .filter((f: string) => f.endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, 50);
      for (const f of files) {
        const fpath = path.join(histDir, f);
        const stat = fs.statSync(fpath);
        const content = fs.readFileSync(fpath, 'utf-8');
        // 세션 제목 추출 (첫 줄 또는 SESSION_START 이후)
        const titleMatch = content.match(/##\s*(.+)/);
        const title = titleMatch ? titleMatch[1].trim() : f;
        contextHistory.push({
          filename: f,
          mtime: stat.mtime.toISOString(),
          size: stat.size,
          content,
          title,
        });
      }
    } catch {}

    return { contextNote, improvementNotes, contextHistory };
  });

  // ═══ Agents API ═════════════════════════════════════
  app.get('/api/agents', async () => {
    const db = getDb();
    const providers = agentManager.listProviders()
      .filter(p => p.enabled !== false); // 비활성 에이전트 제외

    const states = await sharedState.getAllAgentStates();

    // 전체 태스크 통계 (완료 수 + 평균 소요시간 — completed_at-created_at 기반)
    const taskRows = db.prepare(
      `SELECT assigned_to,
              COUNT(*) as total,
              SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
              AVG(CASE WHEN status='completed' AND completed_at IS NOT NULL
                       THEN (strftime('%s', completed_at) - strftime('%s', created_at)) * 1000
                       ELSE NULL END) as avg_ms
       FROM tasks GROUP BY assigned_to`
    ).all() as any[];
    const taskMap = new Map(taskRows.map((r: any) => [r.assigned_to, r]));

    // 에이전트별 마지막 실패 이유 (response 컬럼에서 추출)
    const lastFailRows = db.prepare(
      `SELECT assigned_to, response FROM tasks WHERE status='failed' AND response IS NOT NULL
       GROUP BY assigned_to HAVING MAX(created_at)`
    ).all() as any[];
    const lastFailMap = new Map(lastFailRows.map((r: any) => [r.assigned_to, r.response as string]));

    // 에이전트별 24h 실패 건수
    const fail24hRows = db.prepare(
      `SELECT assigned_to, COUNT(*) as cnt FROM tasks
       WHERE status='failed' AND created_at >= datetime('now', '-24 hours')
       GROUP BY assigned_to`
    ).all() as any[];
    const fail24hMap = new Map(fail24hRows.map((r: any) => [r.assigned_to, r.cnt as number]));

    // 실제 실행 중인 태스크 조회 (running, streaming, assigned)
    const activeTasks = db.prepare(
      "SELECT assigned_to, id, prompt, status FROM tasks WHERE status IN ('running','streaming','assigned') ORDER BY created_at DESC"
    ).all() as any[];
    const activeMap = new Map<string, { id: string; prompt: string; status: string }>();
    for (const t of activeTasks) {
      if (t.assigned_to && !activeMap.has(t.assigned_to)) {
        activeMap.set(t.assigned_to, { id: t.id, prompt: t.prompt, status: t.status });
      }
    }

    const agents = providers.map(p => {
      const state = states[p.id] as any || {};
      const activeTask = activeMap.get(p.id);

      // 우선순위: DB 실행중 태스크 > sharedState > 기본값
      let agentStatus: string;
      let currentTask: string | null = null;
      if (activeTask) {
        agentStatus = 'working';
        currentTask = activeTask.prompt?.slice(0, 80) ?? null;
      } else {
        const rawStatus = state.status as string | undefined;
        agentStatus = rawStatus === 'working' ? 'working'
          : rawStatus === 'idle' ? 'idle'
          : 'online'; // enabled 에이전트는 online
        currentTask = state.currentTask ?? null;
      }

      const stats = taskMap.get(p.id) as any;
      const taskCount = stats?.total || 0;
      const successCount = stats?.completed || 0;
      const successRate = taskCount > 0 ? Math.round((successCount / taskCount) * 100) : 0;
      const avgDurationMs = stats?.avg_ms ? Math.round(stats.avg_ms) : 0;
      // CircuitBreaker 상태 수집
      const sandbox = agentManager.getSandbox(p.id);
      const cbJson = sandbox?.circuitBreaker?.toJSON() as any;
      // 마지막 실패 이유: DB 태스크 response에서 추출
      const rawLastError = lastFailMap.get(p.id) ?? null;
      const lastError = rawLastError
        ? rawLastError.slice(0, 120)
        : (cbJson?.lastFailureAt ? `마지막 실패: ${new Date(cbJson.lastFailureAt).toLocaleTimeString('ko-KR')}` : null);
      const circuitState: string = cbJson?.state ?? 'closed';
      const health = {
        circuitState,
        consecutiveFailures: cbJson?.failures ?? 0,
        lastError,
      };

      // CB=OPEN 시 status를 'error'로 오버라이드 (kangnote-claude-1 버그 보고 반영)
      if (circuitState === 'open' && agentStatus !== 'working') {
        agentStatus = 'error';
      }

      const p95LatencyMs = agentManager.getP95Latency(p.id);

      return {
        id: p.id,
        name: p.name || p.id,
        role: p.role || 'Agent',
        score: (p as any).score ?? 80,
        running: true,
        currentTask,
        enabled: true,
        taskCount,
        successRate,
        avgDurationMs,
        p95LatencyMs,
        failedLast24h: fail24hMap.get(p.id) ?? 0,
        status: agentStatus,
        health,
      };
    });

    return { agents };
  });

  // ── MLX 실시간 레이턴시 핑 (kangnote 요청) ──────────────────────
  app.get('/api/mlx/latency', async () => {
    const LOCAL_URL  = 'http://localhost:8000/v1/models';
    const REMOTE_URL = 'http://100.88.88.69:8000/v1/models';
    const ping = async (url: string): Promise<{ latencyMs: number; online: boolean }> => {
      const t0 = Date.now();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        return { latencyMs: Date.now() - t0, online: res.ok };
      } catch {
        return { latencyMs: -1, online: false };
      }
    };
    const [local, remote] = await Promise.all([ping(LOCAL_URL), ping(REMOTE_URL)]);

    // mlx-keepalive 마지막 폴링 시각 읽기
    let lastKeepaliveAt: string | null = null;
    try {
      const { stdout } = await execFileAsync('tail', ['-1', '/Users/nova-ai/.pm2/logs/mlx-keepalive-out-12.log']);
      const m = stdout.match(/\[mlx-keepalive\]\s+(\d{2}:\d{2}:\d{2})/);
      if (m) lastKeepaliveAt = m[1];
    } catch {}

    return { local, remote, checkedAt: new Date().toISOString(), lastKeepaliveAt };
  });

  // ── 24h 실패 히트맵 (nova-macstudio-claude-2 제안) ─────────────
  app.get('/api/tasks/heatmap', async () => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT assigned_to,
             CAST(strftime('%H', datetime(created_at, 'localtime')) AS INTEGER) as hour,
             COUNT(*) as cnt
      FROM tasks
      WHERE status='failed' AND created_at >= datetime('now', '-24 hours')
      GROUP BY assigned_to, hour
      ORDER BY assigned_to, hour
    `).all() as any[];

    const byAgent = new Map<string, number[]>();
    for (const r of rows) {
      if (!byAgent.has(r.assigned_to)) byAgent.set(r.assigned_to, new Array(24).fill(0));
      byAgent.get(r.assigned_to)![r.hour] = r.cnt;
    }

    const sorted = Array.from(byAgent.entries())
      .map(([id, hours]) => ({ id, hours, total: (hours as number[]).reduce((a: number, b: number) => a + b, 0) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);

    return { agents: sorted, updatedAt: new Date().toISOString() };
  });

  // inter-session 메시지 피드 (최근 20개)
  app.get('/api/inter-session/messages', async () => {
    const logPath = `${process.env.HOME}/.claude/data/inter-session/messages.log`;
    try {
      const { stdout } = await execFileAsync('tail', ['-40', logPath]);
      const messages = stdout.trim().split('\n')
        .filter(Boolean)
        .map(line => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean)
        .slice(-20)
        .map((m: any) => ({
          id:       m.msg_id ?? '',
          from:     m.from_name ?? m.from ?? '?',
          to:       m.to_session_id ? 'broadcast' : (m.to ?? '?'),
          text:     (m.text ?? '').slice(0, 120),
          ts:       m.ts ?? '',
        }))
        .reverse();
      return { messages };
    } catch {
      return { messages: [] };
    }
  });

  // P95 latency per agent (in-memory sliding window, 100 samples)
  app.get('/api/agents/:id/latency', async (req, reply) => {
    const { id } = req.params as any;
    const provider = agentManager.listProviders().find(p => p.id === id);
    if (!provider) { reply.code(404); return { error: 'Agent not found' }; }
    const p95 = agentManager.getP95Latency(id);
    return { agentId: id, p95LatencyMs: p95 };
  });

  // ═══ Dashboard Graph API ════════════════════════════
  app.get('/api/dashboard/graph', async () => {
    const db = getDb();
    // 비활성(disabled) 에이전트 제외
    const agents = agentManager.listProviders().filter(p => p.enabled !== false);

    const taskRows = db.prepare(
      'SELECT assigned_to, status FROM tasks ORDER BY created_at DESC LIMIT 500'
    ).all() as any[];

    // 실행 중인 태스크 맵
    const activeTasks = db.prepare(
      "SELECT assigned_to, prompt FROM tasks WHERE status IN ('running','streaming','assigned') ORDER BY created_at DESC"
    ).all() as any[];
    const activeMap = new Map<string, string>();
    for (const t of activeTasks) {
      if (t.assigned_to && !activeMap.has(t.assigned_to)) {
        activeMap.set(t.assigned_to, t.prompt?.slice(0, 80) ?? '');
      }
    }

    // sharedState도 참조
    const states = await sharedState.getAllAgentStates();

    // 노드 생성
    const nodes = agents.map((p, i) => {
      const agentTasks = taskRows.filter(t => t.assigned_to === p.id);
      const successCount = agentTasks.filter(t => t.status === 'completed').length;
      const successRate = agentTasks.length > 0 ? successCount / agentTasks.length : 0;
      const angle = (i / agents.length) * 2 * Math.PI;
      const radius = 300;

      // 실제 상태 결정
      const activePrompt = activeMap.get(p.id);
      const sharedSt = (states[p.id] as any)?.status;
      const nodeStatus = activePrompt
        ? 'working'
        : sharedSt === 'working' ? 'working'
        : sharedSt === 'idle' ? 'idle'
        : 'online';

      return {
        id: p.id,
        type: 'provider',
        position: { x: Math.cos(angle) * radius + 400, y: Math.sin(angle) * radius + 300 },
        data: {
          label: p.name || p.id,
          role: p.role || 'Agent',
          status: nodeStatus,
          score: (p as any).score || 80,
          enabled: true,
          taskCount: agentTasks.length,
          successRate: Math.round(successRate * 100),
          avgDurationMs: 0,
          currentTask: activePrompt ?? (states[p.id] as any)?.currentTask ?? null,
        },
      };
    });

    // 엣지 생성: 같은 태스크에 등장한 provider 조합 (discussion/parallel)
    const collabMap = new Map<string, number>();
    const parallelRows = db.prepare(
      "SELECT assigned_to FROM tasks WHERE mode IN ('parallel','discussion','hive') LIMIT 200"
    ).all() as any[];
    for (const t of parallelRows) {
      const a = t.assigned_to;
      if (!a) continue;
      // discussion mode: count self-edges as signal of participation
      for (const b of agents.map(p => p.id)) {
        if (a === b) continue;
        const key = [a, b].sort().join('::');
        collabMap.set(key, (collabMap.get(key) || 0) + 1);
      }
    }

    const nodeIds = new Set(nodes.map((n: any) => n.id));
    const edges: any[] = [];
    for (const [key, count] of collabMap.entries()) {
      const [src, tgt] = key.split('::');
      // 양쪽 모두 실제 노드인 경우만 엣지 생성
      if (!nodeIds.has(src) || !nodeIds.has(tgt)) continue;
      if (count < 2) continue;
      edges.push({
        id: `e-${src}-${tgt}`,
        source: src,
        target: tgt,
        animated: false,
        data: { collaborationCount: count },
        style: { strokeWidth: Math.min(1 + Math.floor(count / 3), 5) },
      });
    }

    // ── 세션 노드 추가 (inter-session list.py — 전체 피어, nco-* 제외) ──
    try {
      const allPeers = await listInterSessions();
      const humanPeers = allPeers.filter(p => !p.isNco);
      const ncoPeers   = allPeers.filter(p => p.isNco);

      const sessionRadius = 520;
      const sessionNodeIds: string[] = [];

      // 사람/피어 세션 → 큰 다이아몬드 노드 (외부 링)
      humanPeers.forEach((peer, si) => {
        const angle = (si / Math.max(humanPeers.length, 4)) * 2 * Math.PI;
        sessionNodeIds.push(`session:${peer.name}`);
        (nodes as any[]).push({
          id: `session:${peer.name}`,
          type: 'session',
          position: { x: Math.cos(angle) * sessionRadius + 400, y: Math.sin(angle) * sessionRadius + 300 },
          data: {
            label: peer.name,
            host: peer.host,
            status: 'online',
            connectedSince: peer.since,
            cwd: peer.cwd,
            isRemote: !peer.name.startsWith('nova-macstudio-'),
          },
        });
      });

      // nco-* 세션 → 작은 위성 노드: 대응 provider에 연결
      ncoPeers.forEach((peer, ni) => {
        // nco-codex → codex, nco-opencode → opencode, nco-claude-code → claude-code
        const providerMatch = peer.name.replace(/^nco-/, '');
        const linkedProvider = nodeIds.has(providerMatch) ? providerMatch : null;
        const angleOffset = (ni / Math.max(ncoPeers.length, 1)) * 2 * Math.PI;
        const baseRadius = 150;
        const refNode = linkedProvider
          ? (nodes as any[]).find(n => n.id === linkedProvider)
          : null;
        const baseX = refNode?.position.x ?? (Math.cos(angleOffset) * 380 + 400);
        const baseY = refNode?.position.y ?? (Math.sin(angleOffset) * 380 + 300);
        const orbitAngle = (ni % 4) * (Math.PI / 2);
        (nodes as any[]).push({
          id: `nco-session:${peer.name}`,
          type: 'nco-session',
          position: {
            x: baseX + Math.cos(orbitAngle) * 55,
            y: baseY + Math.sin(orbitAngle) * 55,
          },
          data: {
            label: peer.name,
            host: peer.host,
            provider: linkedProvider,
            status: 'online',
            connectedSince: peer.since,
            cwd: peer.cwd,
          },
        });
        // nco 세션 → provider 엣지
        if (linkedProvider) {
          (edges as any[]).push({
            id: `e-nco-${peer.name}-${linkedProvider}`,
            source: `nco-session:${peer.name}`,
            target: linkedProvider,
            animated: false,
            data: { collaborationCount: 1, type: 'nco-session' },
            style: { strokeWidth: 1, opacity: 0.4 },
          });
        }
      });

      // 사람 세션 → claude-code 엣지 (기본 연결)
      for (const sid of sessionNodeIds) {
        if (nodeIds.has('claude-code')) {
          (edges as any[]).push({
            id: `e-${sid}-claude-code`,
            source: sid,
            target: 'claude-code',
            animated: false,
            data: { collaborationCount: 1, type: 'session' },
            style: { strokeWidth: 1 },
          });
        }
      }
    } catch {}

    return { nodes, edges, updatedAt: new Date().toISOString() };
  });

  // ═══ Sessions API (inter-session list.py 호출) ══════
  app.get('/api/sessions', async () => {
    try {
      const peers = await listInterSessions();
      const all = peers.map(p => ({
        id: p.id,
        name: p.name,
        label: p.label,
        host: p.host,
        connectedSince: p.since,
        cwd: p.cwd,
        isNco: p.isNco,
      }));
      const sessions = all.filter(p => !p.isNco);
      const ncoSessions = all.filter(p => p.isNco);
      sessions.sort((a, b) => a.name.localeCompare(b.name));
      return { sessions, ncoSessions, count: sessions.length, totalPeers: all.length };
    } catch (err: any) {
      return { sessions: [], ncoSessions: [], count: 0, totalPeers: 0, error: String(err?.message ?? err) };
    }
  });

  // ═══ Agent Evaluations API ══════════════════════════
  app.get('/api/dashboard/evaluations', async (req) => {
    const db = getDb();
    const { agent_id, limit = '50' } = req.query as any;
    try {
      const rows = agent_id
        ? db.prepare('SELECT * FROM agent_evaluations WHERE agent_id=? ORDER BY evaluated_at DESC LIMIT ?').all(agent_id, Number(limit))
        : db.prepare('SELECT * FROM agent_evaluations ORDER BY evaluated_at DESC LIMIT ?').all(Number(limit));
      return { evaluations: rows };
    } catch {
      return { evaluations: [], message: 'agent_evaluations table not yet migrated' };
    }
  });

  app.post('/api/dashboard/evaluations', async (req) => {
    const db = getDb();
    const body = req.body as any;
    try {
      db.prepare(`INSERT INTO agent_evaluations (agent_id, task_id, score, success, duration_ms, error_type, improvement_note)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(body.agent_id, body.task_id, body.score, body.success ? 1 : 0, body.duration_ms, body.error_type, body.improvement_note);
      return { ok: true };
    } catch {
      return { ok: false, message: 'agent_evaluations table not yet migrated' };
    }
  });

  // ═══ Circuit Breaker 수동 리셋 API ══════════════════
  app.post('/api/agents/:id/reset-circuit', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const sandbox = agentManager.getSandbox(id);
      if (!sandbox) {
        reply.code(404);
        return { ok: false, error: `Agent '${id}' not found` };
      }
      sandbox.circuitBreaker.reset();
      // shared-state도 초기화
      const { sharedState } = await import('../../core/shared-state.js');
      await sharedState.setAgentState(id, {
        health: { consecutiveFailures: 0, circuitState: 'closed', lastError: null },
        status: 'online',
      });
      return { ok: true, agentId: id, message: 'Circuit breaker reset — agent is now available' };
    } catch (err: any) {
      reply.code(500);
      return { ok: false, error: String(err?.message ?? err) };
    }
  });

  // ═══ Fleet-Wide Agent 집계 API (inter-session 메시지 기반) ═════
  app.get('/api/fleet/agents', async () => {
    try {
      const logPath = join(process.env.HOME ?? '/Users/nova-ai', '.claude', 'data', 'inter-session', 'messages.log');
      let lines: string[] = [];
      try {
        const txt = readFileSync(logPath, 'utf-8');
        lines = txt.trim().split('\n').slice(-1000);
      } catch { /* log not available */ }

      // host → 최신 fleet 응답
      const hostMap = new Map<string, { host: string; agents: any[]; from: string; ts: string }>();
      const STALE_MS = 2 * 60 * 60 * 1000; // 2시간 이상 오래된 응답은 제외
      const now = Date.now();

      // inter-session 세션명 → 호스트명 추출 (nova-macstudio-claude-1 → nova-macstudio)
      const extractHost = (name: string): string => {
        const m = name.match(/^(.+?)-claude-\d+$/);
        return m ? m[1] : name;
      };

      // 텍스트 포맷 providers 파싱
      const parseTextProviders = (txt: string): any[] | null => {
        // done: providers=[a,b,c] health=ok  (대괄호 포함)
        const arrMatch = txt.match(/providers=\[([^\]]+)\]/);
        if (arrMatch) {
          return arrMatch[1].split(',').map(id => id.trim()).filter(Boolean).map(id => ({
            id, name: id, status: 'idle' as const, currentTask: null,
          }));
        }
        // done: providers=a,b,c health=ok  (대괄호 없음, 공백/| 전까지)
        const bareMatch = txt.match(/providers=([a-z0-9\-_,]+)/);
        if (bareMatch && !bareMatch[1].includes('all-ok') && !bareMatch[1].includes('enabled')) {
          return bareMatch[1].split(',').map(id => id.trim()).filter(Boolean).map(id => ({
            id, name: id, status: 'idle' as const, currentTask: null,
          }));
        }
        // status: host=X ... providers=all-ok — 호스트 존재 표시만
        if (/providers=all-ok/.test(txt)) return [];
        return null;
      };

      for (const line of lines) {
        try {
          const m = JSON.parse(line);
          const txt: string = m.text ?? '';
          const fromName: string = m.from_name ?? m.name ?? '';
          const ts: string = m.ts ?? m.timestamp ?? '';

          // 자기 자신(nova-macstudio) 제외
          if (fromName.startsWith('nova-macstudio') || fromName.startsWith('nco-')) continue;

          const tsMs = ts ? new Date(ts).getTime() : 0;
          if (tsMs > 0 && now - tsMs > STALE_MS) continue;

          // ── 방법 1: status: <JSON> 포맷 ──────────────────────
          if (txt.startsWith('status:')) {
            const payload = txt.slice(7).trim();
            try {
              const data = JSON.parse(payload);
              if (data?.host && Array.isArray(data.agents)) {
                const key = (data.host as string).toLowerCase();
                const existing = hostMap.get(key);
                const existTs = existing?.ts ? new Date(existing.ts).getTime() : 0;
                if (!existing || (tsMs > 0 && tsMs > existTs)) {
                  hostMap.set(key, { host: (data.host as string).toLowerCase(), agents: data.agents, from: fromName, ts });
                }
                continue;
              }
            } catch { /* not JSON, fall through */ }

            // status: host=X ts=... providers=all-ok 텍스트 포맷
            const hostMatch = txt.match(/host=([^\s|]+)/);
            if (hostMatch) {
              const hostName = hostMatch[1];
              const key = hostName.toLowerCase();
              const existing = hostMap.get(key);
              const existTs = existing?.ts ? new Date(existing.ts).getTime() : 0;
              if (!existing || (tsMs > 0 && tsMs > existTs)) {
                const parsed = parseTextProviders(txt);
                // providers=all-ok → empty list이면 기존 에이전트 목록 유지
                const agents = (parsed && parsed.length > 0) ? parsed : (existing?.agents ?? []);
                hostMap.set(key, { host: hostName, agents, from: fromName, ts });
              }
              continue;
            }
          }

          // ── 방법 2: done:/status: providers=[...] or providers=a,b,c ──
          if ((txt.startsWith('done:') || txt.startsWith('status:')) && /providers=/.test(txt)) {
            if (!fromName) continue;
            // from_name에서 호스트 추출 (kangnote-claude-2 → kangnote)
            // 또는 메시지 내 [hostname] 패턴 (done: [kangnote-claude-2] providers=...)
            let hostName = extractHost(fromName);
            const bracketMatch = txt.match(/(?:done:|status:)\s*\[([^\]]+)\]/);
            if (bracketMatch) {
              const inner = bracketMatch[1]; // "kangnote-claude-2" or "kangnote"
              hostName = extractHost(inner);
            }
            if (!hostName || hostName === 'nco' || hostName === 'cli') continue;
            const key = hostName.toLowerCase();
            const agents = parseTextProviders(txt);
            if (agents && agents.length > 0) {
              const existing = hostMap.get(key);
              const existTs = existing?.ts ? new Date(existing.ts).getTime() : 0;
              if (!existing || (tsMs > 0 && tsMs > existTs)) {
                hostMap.set(key, { host: hostName, agents, from: fromName, ts });
              }
            }
          }
        } catch { /* skip malformed */ }
      }

      const hosts = Array.from(hostMap.values());
      const totalAgents = hosts.reduce((s, h) => s + h.agents.length, 0);
      return { hosts, totalAgents, hostCount: hosts.length, updatedAt: new Date().toISOString() };
    } catch (err: any) {
      return { hosts: [], totalAgents: 0, hostCount: 0, error: String(err?.message ?? err) };
    }
  });

  // ═══ Fleet 브로드캐스트 트리거 (강제 갱신) ═════════════════
  app.post('/api/fleet/refresh', async () => {
    try {
      const IS_BIN = join(process.env.HOME ?? '/Users/nova-ai', '.claude', 'plugins', 'cache', 'inter-session', 'inter-session', '0.1.2', 'skills', 'inter-session', 'bin');
      const msg = 'fleet-status-request: respond with JSON {"host":"<pc-name>","agents":[{"id":"<id>","name":"<name>","status":"idle|working|error","currentTask":"<task or null>"},...]} for all your NCO providers. Use status: prefix.';
      await execFileAsync('python3', [join(IS_BIN, 'send.py'), '--all', '--text', msg], { timeout: 5000 });
      return { ok: true, message: 'Fleet status request broadcast sent' };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });

  // ═══ 실시간 도구 활동 API ═════════════════════════════
  // PreToolUse/PostToolUse 훅에서 POST → 대시보드에서 GET으로 폴링
  const activityStore = new Map<string, {
    session: string; tool: string; action: string; file: string; project: string;
    ts: number; done: boolean;
  }[]>();
  const ACTIVITY_TTL_MS = 30_000; // 30초 후 자동 만료

  // 만료 정리 (10초마다)
  setInterval(() => {
    const now = Date.now();
    for (const [session, acts] of activityStore.entries()) {
      const alive = acts.filter(a => now - a.ts < ACTIVITY_TTL_MS && !a.done);
      if (alive.length === 0) activityStore.delete(session);
      else activityStore.set(session, alive);
    }
  }, 10_000);

  app.post('/api/activity', async (req) => {
    const body = req.body as any;
    const session = body?.session ?? 'unknown';
    const tool    = body?.tool ?? '';
    const action  = body?.action ?? '';
    const file    = body?.file ?? '';
    const project = body?.project ?? '';
    const event   = body?.event ?? 'PreToolUse';
    const isDone  = event === 'PostToolUse' || action.endsWith(':done');

    if (!session || !tool) return { ok: false };

    const existing = activityStore.get(session) ?? [];
    if (isDone) {
      // 완료: 해당 도구 항목 제거
      activityStore.set(session, existing.filter(a => a.tool !== tool || a.file !== file));
    } else {
      // 시작: 같은 도구+파일 중복 제거 후 추가
      const filtered = existing.filter(a => !(a.tool === tool && a.file === file));
      filtered.push({ session, tool, action, file, project, ts: Date.now(), done: false });
      activityStore.set(session, filtered.slice(-5)); // 세션당 최대 5개 활동
    }

    // WebSocket 브로드캐스트 (activity:update 이벤트)
    try { eventBus.publish({ type: 'activity:update' as any, data: { session, tool, action, file, project, done: isDone } }); } catch {}
    return { ok: true };
  });

  app.get('/api/activity', async () => {
    const now = Date.now();
    const result: Record<string, any[]> = {};
    for (const [session, acts] of activityStore.entries()) {
      const alive = acts.filter(a => now - a.ts < ACTIVITY_TTL_MS && !a.done);
      if (alive.length > 0) result[session] = alive;
    }
    return { activities: result, ts: new Date().toISOString() };
  });

  // ═══ 프로젝트 집계 API ═══════════════════════════════
  app.get('/api/projects', async (req) => {
    const db = getDb();
    const { limit = 20 } = req.query as any;
    // 태스크에서 프로젝트 정보 추출 (prompt + assigned_to 기반)
    const rows = db.prepare(`
      SELECT assigned_to, status, prompt, created_at, completed_at
      FROM tasks ORDER BY created_at DESC LIMIT 300
    `).all() as any[];

    // 프로젝트명 추출 함수
    const extractProject = (prompt: string): string => {
      if (!prompt) return 'unknown';
      // 파일 경로 패턴 추출
      const m = prompt.match(/\/(?:project|projects|Users\/[^/]+\/(?:project|work))\/([^/\s]+)/);
      if (m) return m[1];
      // NCO 프로젝트명 패턴
      const nm = prompt.match(/\b(nco[-\w]+|nco_[\w]+)\b/i);
      if (nm) return nm[1].toLowerCase();
      // 첫 10단어 요약
      return prompt.split(/\s+/).slice(0, 4).join(' ').slice(0, 40);
    };

    const projectMap = new Map<string, { done: number; fail: number; run: number; pending: number; lastAt: string; agents: Set<string> }>();
    for (const r of rows) {
      const pname = extractProject(r.prompt ?? '');
      if (!projectMap.has(pname)) projectMap.set(pname, { done: 0, fail: 0, run: 0, pending: 0, lastAt: r.created_at ?? '', agents: new Set() });
      const p = projectMap.get(pname)!;
      if (r.assigned_to) p.agents.add(r.assigned_to);
      if (r.status === 'completed') p.done++;
      else if (r.status === 'failed') p.fail++;
      else if (r.status === 'running' || r.status === 'assigned') p.run++;
      else p.pending++;
      if ((r.completed_at ?? r.created_at) > p.lastAt) p.lastAt = r.completed_at ?? r.created_at;
    }

    const projects = [...projectMap.entries()]
      .sort((a, b) => b[1].lastAt.localeCompare(a[1].lastAt))
      .slice(0, Number(limit))
      .map(([name, s]) => ({
        name,
        done: s.done, fail: s.fail, running: s.run, pending: s.pending,
        total: s.done + s.fail + s.run + s.pending,
        agents: [...s.agents],
        lastAt: s.lastAt,
        successPct: s.done + s.fail > 0 ? Math.round(s.done / (s.done + s.fail) * 100) : null,
      }));

    return { projects, updatedAt: new Date().toISOString() };
  });

  // ═══ Catch-all for unimplemented routes ═════════════
  // Note: This must be the LAST route registered. Routes added in gateway.ts
  // before registerDashboardRoutes() take priority via Fastify's route matching.
  app.all('/api/*', async (req, reply) => {
    // Handle /api/learn/search inline (catch-all overrides specific routes in Fastify)
    const urlPath = req.url.split('?')[0];
    if (urlPath === '/api/learn/search' && req.method === 'GET') {
      const { knowledgeBase } = await import('../../core/knowledge-base.js');
      const { q, keywords, project, limit } = req.query as any;
      const searchTerms = q || keywords;
      if (!searchTerms) return { data: [], message: 'q or keywords parameter required' };
      return { data: knowledgeBase.query(searchTerms, project, Number(limit) || 10) };
    }

    // ── HNSW Vector Memory routes (/api/memory/*) ────────────────────────
    const vmMatch = urlPath.match(/^\/api\/memory\/([^/]+)(?:\/(.+))?$/);
    if (vmMatch) {
      const { vectorMemory } = await import('../../core/vector-memory.js');
      const agentId = decodeURIComponent(vmMatch[1]);
      const action = vmMatch[2];

      if (req.method === 'POST' && action === 'add') {
        const body = req.body as any;
        if (!body?.content) { reply.code(400); return { error: 'content required' }; }
        const id = await vectorMemory.add(agentId, body.content, body.importance ?? 1.0);
        reply.code(201);
        return { stored: true, id };
      }
      if (req.method === 'POST' && action === 'search') {
        const body = req.body as any;
        if (!body?.query) { reply.code(400); return { error: 'query required' }; }
        const results = await vectorMemory.search(agentId, body.query, body.k ?? 5);
        return { agentId, query: body.query, count: results.length, results };
      }
      if (req.method === 'GET' && action === 'stats') {
        return vectorMemory.stats(agentId);
      }
      if (req.method === 'GET' && !action) {
        const entries = vectorMemory.list(agentId, 200);
        return { agentId, count: entries.length, entries };
      }
      if (req.method === 'DELETE' && !action) {
        const deleted = await vectorMemory.delete(agentId);
        return { agentId, deleted };
      }
      if (req.method === 'POST' && action === 'rebuild') {
        const rebuilt = await vectorMemory.rebuildIndex(agentId);
        return { agentId, rebuilt };
      }
    }

    // ── Sleep Consolidation endpoint (/api/memory/consolidate) ──────────
    if (urlPath === '/api/memory/consolidate' && req.method === 'POST') {
      const { sleepConsolidator } = await import('../../core/sleep-consolidator.js');
      const body = req.body as any;
      const report = await sleepConsolidator.consolidate(body?.agentId);
      return { ok: true, reports: report };
    }

    // ── mem0 legacy routes (backward compat) ────────────────────────────
    const mem0Match = urlPath.match(/^\/api\/mem0\/([^/]+)(?:\/(.+))?$/);
    if (mem0Match) {
      const { vectorMemory: vm } = await import('../../core/vector-memory.js');
      const agentId = decodeURIComponent(mem0Match[1]);
      const action = mem0Match[2];
      if (req.method === 'POST' && action === 'add') {
        const body = req.body as any;
        if (!body?.content) { reply.code(400); return { error: 'content required' }; }
        const id = await vm.add(agentId, body.content);
        reply.code(201);
        return { stored: true, id, embedded: true };
      }
      if (req.method === 'POST' && action === 'search') {
        const body = req.body as any;
        if (!body?.query) { reply.code(400); return { error: 'query required' }; }
        const results = await vm.search(agentId, body.query, body.limit ?? 5);
        return { mode: 'hnsw-semantic', query: body.query, results };
      }
      if (req.method === 'GET' && !action) {
        const entries = vm.list(agentId, 100);
        return { agentId, count: entries.length, entries };
      }
      if (req.method === 'DELETE' && !action) {
        const deleted = await vm.delete(agentId);
        return { agentId, deleted };
      }
    }

    // ── AgentEvolver stats endpoint ──────────────────────
    const evolverMatch = urlPath.match(/^\/api\/evolver\/([^/]+)\/stats$/);
    if (evolverMatch && req.method === 'GET') {
      const { agentEvolver } = await import('../../core/agent-evolver.js');
      const agentId = decodeURIComponent(evolverMatch[1]);
      return agentEvolver.getStats(agentId);
    }

    reply.code(200);
    return { data: [], message: `Route ${req.method} ${req.url} — pending implementation` };
  });
}
