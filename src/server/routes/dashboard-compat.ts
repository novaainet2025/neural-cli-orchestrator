/**
 * Dashboard compatibility routes — NCO-Dashboard 프론트엔드 계약 호환
 * Vite 플러그인이 처리하던 180+ 라우트 중 핵심만 구현
 */
import type { FastifyInstance } from 'fastify';
import { getDb } from '../../storage/database.js';
import { getRedis } from '../../storage/redis.js';
import { sharedState } from '../../core/shared-state.js';
import { agentManager } from '../../agent/agent-manager.js';
import { circuitBreakerRegistry } from '../../security/circuit-breaker-registry.js';
import { eventBus } from '../../core/event-bus.js';
import { discussionEngine } from '../../core/discussion-engine.js';
import { createTaskId, createSessionId, createMessageId } from '../../utils/id.js';
import { env } from '../../utils/config.js';
import { getPushReports } from './fleet-ops.js';
import type { FleetReportActivitySummary, FleetReportSession } from './fleet-ops.js';
import { summarizeTeamWorkflow } from './teams.js';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const IS_CLIENTS_DIR = join(process.env.HOME ?? '/Users/nova-ai', '.claude', 'data', 'inter-session', 'clients');

// inter-session 세션별 활동/working 분석 (passive + explicit-status detection).
// messages.log(from_name 기준)를 tail 하여 세션 이름 → 상태를 계산한다.
// /api/inter-session/activity 와 /api/dashboard/graph(원격 세션 working 표시)에서 공용.
type SessionActivityInfo = {
  name: string;
  msgCount1m: number;
  msgCount5m: number;
  lastMsgTs: string;
  lastMsgAge: number;
  lastMsgText: string;
  status: 'working' | 'idle' | 'online';
  statusSource: string;
};

async function analyzeSessionActivity(): Promise<Map<string, SessionActivityInfo>> {
  const logPath = `${process.env.HOME}/.claude/data/inter-session/messages.log`;
  const sessionActivity = new Map<string, SessionActivityInfo>();
  try {
    const { stdout } = await execFileAsync('tail', ['-500', logPath]);
    const now = Date.now();
    const entries = stdout.trim().split('\n')
      .filter(Boolean)
      .map((line: string) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);

    for (const m of entries as any[]) {
      const name = m.from_name ?? m.from ?? '';
      if (!name) continue;
      const ts = m.ts ?? '';
      const msgTime = ts ? new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z').getTime() : 0;
      const age = now - msgTime;
      const text = (m.text ?? '').slice(0, 200);

      let entry = sessionActivity.get(name);
      if (!entry) {
        entry = { name, msgCount1m: 0, msgCount5m: 0, lastMsgTs: '', lastMsgAge: Infinity, lastMsgText: '', status: 'online', statusSource: '' };
        sessionActivity.set(name, entry);
      }

      if (age < 60_000) entry.msgCount1m++;
      if (age < 300_000) entry.msgCount5m++;

      if (age < entry.lastMsgAge) {
        entry.lastMsgAge = age;
        entry.lastMsgTs = ts;
        entry.lastMsgText = text;
      }
    }

    for (const [, entry] of sessionActivity) {
      // 명시적 status 메시지 우선 (Emit half: 세션이 broadcast 하는 'status: working|idle')
      // working은 5분 age 가드: 갱신 없는 stale working을 online으로 강등해 stuck-working 방지.
      // (idle emit이 꺼져 있으면 마지막 working 메시지가 영구히 남아 고착되는 것을 막음)
      if (/^status:\s*working/i.test(entry.lastMsgText) && entry.lastMsgAge < 300_000) {
        entry.status = 'working';
        entry.statusSource = 'explicit-status';
      } else if (/^status:\s*working/i.test(entry.lastMsgText)) {
        entry.status = 'online';
        entry.statusSource = 'explicit-working-stale';
      } else if (/^status:\s*idle/i.test(entry.lastMsgText)) {
        entry.status = entry.lastMsgAge < 120_000 ? 'idle' : 'online';
        entry.statusSource = 'explicit-status';
      } else if (/^(done:|answer:)/i.test(entry.lastMsgText) && entry.lastMsgAge < 120_000) {
        entry.status = 'working';
        entry.statusSource = 'done/answer-recent';
      } else if (/^question:/i.test(entry.lastMsgText) && entry.lastMsgAge < 120_000) {
        entry.status = 'working';
        entry.statusSource = 'question-active';
      } else if (entry.msgCount1m >= 2) {
        entry.status = 'working';
        entry.statusSource = `frequency:${entry.msgCount1m}msg/1m`;
      } else if (entry.msgCount5m >= 3) {
        entry.status = 'working';
        entry.statusSource = `frequency:${entry.msgCount5m}msg/5m`;
      } else if (entry.lastMsgAge < 60_000) {
        entry.status = 'idle';
        entry.statusSource = 'recent-but-quiet';
      } else if (entry.lastMsgAge < 300_000) {
        entry.status = 'online';
        entry.statusSource = 'seen-5m';
      } else {
        entry.status = 'online';
        entry.statusSource = 'stale';
      }
    }
  } catch {
    // messages.log 없음/read 실패 → 빈 맵
  }
  return sessionActivity;
}

// 살아있는 .session 파일 후보 — 최신(mtime) 우선 정렬으로 전부 수집
// (기존 버그: readdir 임의 순서로 첫 살아있는 pid를 골랐는데, pid는 살아있어도
//  registry에 미등록된 stale 세션을 집으면 제어 auth가 op:error("no listener")로
//  거부되어 listInterSessions가 빈 배열을 반환했다 → 대시보드에 세션 노드 0개.
//  최신 세션부터 순회하고, listInterSessions에서 성공(list_ok)할 때까지 재시도한다.)
function findActiveSessionStates(): any[] {
  const out: Array<{ state: any; mtime: number }> = [];
  try {
    const files = readdirSync(IS_CLIENTS_DIR).filter(f => f.endsWith('.session'));
    for (const f of files) {
      try {
        const full = join(IS_CLIENTS_DIR, f);
        const state = JSON.parse(readFileSync(full, 'utf-8'));
        const pid = state?.listener_pid;
        if (!pid) continue;
        try { process.kill(Number(pid), 0); } catch { continue; } // 죽은 pid 제외
        out.push({ state, mtime: statSync(full).mtimeMs });
      } catch {}
    }
  } catch {}
  out.sort((a, b) => b.mtime - a.mtime); // 최신 세션 우선
  return out.map(o => o.state);
}

// 단일 세션 state로 registry에 list 요청 — 성공 시 피어 배열, 실패/거부 시 null
function queryRegistry(state: any): Promise<Array<{
  name: string; label: string; cwd: string; since: string; id: string;
  isNco: boolean; host: string;
}> | null> {
  const host = state.host ?? '127.0.0.1';
  const port = state.port ?? 9473;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: any) => { if (!done) { done = true; resolve(v); } };
    const ws = new WebSocket(`ws://${host}:${port}/`);
    const timer = setTimeout(() => { try { ws.terminate(); } catch {} finish(null); }, 6000);

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
            let h = hostMatch ? hostMatch[1] : name.startsWith('nco-') ? 'nco' : name;
            if (name === 'agy-1' || name === 'agy') h = 'nova-macstudio';
            const sinceMs = s.since ? Date.now() - new Date(s.since).getTime() : 0;
            const sinceSec = Math.floor(sinceMs / 1000);
            const sinceStr = sinceSec < 60 ? `${sinceSec}s` : sinceSec < 3600 ? `${Math.floor(sinceSec/60)}m` : `${Math.floor(sinceSec/3600)}h`;
            return { name, label: s.label ?? '', cwd: s.cwd ?? '', since: sinceStr, id: (s.session_id ?? '').slice(0, 8), isNco: name.startsWith('nco-'), host: h };
          });
          finish(sessions);
        } else if (msg.op === 'error') {
          // stale/미등록 세션 → 이 후보 포기, 다음 후보로
          clearTimeout(timer);
          ws.close();
          finish(null);
        }
      } catch {}
    });

    ws.on('error', () => { clearTimeout(timer); finish(null); });
    ws.on('close', () => { clearTimeout(timer); finish(null); });
  });
}

// inter-session 서버에 ws 모듈로 list 요청
async function listInterSessions(): Promise<Array<{
  name: string; label: string; cwd: string; since: string; id: string;
  isNco: boolean; host: string;
}>> {
  try {
    const states = findActiveSessionStates();
    // 최신 세션부터 최대 8개까지 시도 — 첫 list_ok(정상 등록된 세션)를 반환.
    // stale 세션(op:error)이나 연결 실패는 null → 다음 후보로 폴백한다.
    for (const state of states.slice(0, 8)) {
      const peers = await queryRegistry(state);
      if (peers !== null) return peers;
    }
    return [];
  } catch {
    return [];
  }
}

// ── 원격 세션 flicker 완화 캐시 (2026-07-12 claude-2): snt/subnote-claude 등 원격 세션이
//    inter-session 재연결 깜빡임(fleet-status-request disconnect 등)으로 세션노드가 사라졌다
//    나타나는 문제 → 최근 본 원격 피어를 TTL 동안 유지해 노드가 안정적으로 표시되게 한다.
const _recentRemotePeers = new Map<string, { peer: any; lastSeen: number }>();
const REMOTE_PEER_TTL_MS = 5 * 60_000;
function mergeRecentRemotePeers(livePeers: any[]): any[] {
  const now = Date.now();
  for (const p of livePeers) {
    // 원격(비-로컬) 사람 피어만 유지 대상 — 로컬 세션은 항상 안정적이라 캐시 불필요
    if (!p.isNco && p.name && !String(p.name).startsWith('nova-macstudio-')) {
      _recentRemotePeers.set(p.name, { peer: { ...p }, lastSeen: now });
    }
  }
  for (const [k, v] of _recentRemotePeers) {
    if (now - v.lastSeen > REMOTE_PEER_TTL_MS) _recentRemotePeers.delete(k);
  }
  const liveNames = new Set(livePeers.map(p => p.name));
  const merged = [...livePeers];
  for (const [name, v] of _recentRemotePeers) {
    if (!liveNames.has(name)) merged.push({ ...v.peer, _stale: true }); // 잠시 끊긴 원격 세션도 유지
  }
  return merged;
}

// ═══ CB 자동 복구 타이머 (2분마다 open CB 헬스체크 후 리셋) ═══════
let cbAutoHealTimer: ReturnType<typeof setInterval> | null = null;

async function startCbAutoHeal() {
  if (cbAutoHealTimer) return; // 이미 실행 중
  cbAutoHealTimer = setInterval(async () => {
    try {
      for (const [id] of (agentManager as any).providers as Map<string, any>) {
        const sandbox = agentManager.getSandbox(id);
        if (!sandbox) continue;
        sandbox.circuitBreaker.canExecute();
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
      // CircuitBreaker 상태 수집 — registry가 단일 진실원 (구 sandbox breaker는 registry와 불일치, kangnote 2026-07-02 보고)
      const cb = circuitBreakerRegistry.getSnapshot(p.id);
      const availability = circuitBreakerRegistry.getAvailability(p.id);
      // 마지막 실패 이유: DB 태스크 response에서 추출
      const rawLastError = lastFailMap.get(p.id) ?? null;
      const lastError = rawLastError
        ? rawLastError.slice(0, 120)
        : (cb.openedAt ? `마지막 실패: ${new Date(cb.openedAt).toLocaleTimeString('ko-KR')}` : null);
      const circuitState: string = cb.state;
      const health = {
        circuitState,
        consecutiveFailures: cb.failureCount,
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
        gate: {
          status: availability.status,
          reason: availability.reason,
          available: availability.available,
          cooldownUntil: availability.cooldownUntil,
        },
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

  // inter-session 메시지 피드 (최근 100개)
  app.get('/api/inter-session/messages', async () => {
    const logPath = `${process.env.HOME}/.claude/data/inter-session/messages.log`;
    try {
      const { stdout } = await execFileAsync('tail', ['-200', logPath]);
      const messages = stdout.trim().split('\n')
        .filter(Boolean)
        .map((line: string) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean)
        .slice(-100)
        .map((m: any) => ({
          id:       m.msg_id ?? '',
          from:     m.from_name ?? m.from ?? '?',
          to:       m.to_session_id ? 'broadcast' : (m.to ?? '?'),
          text:     (m.text ?? '').slice(0, 200),
          ts:       m.ts ?? '',
        }))
        .reverse();
      return { messages };
    } catch {
      return { messages: [] };
    }
  });

  // inter-session 세션별 활동 분석 (passive working detection)
  app.get('/api/inter-session/activity', async () => {
    const sessionActivity = await analyzeSessionActivity();
    const sessions = Array.from(sessionActivity.values())
      .filter(s => !s.name.startsWith('nco-'))  // NCO 프로바이더 제외
      .sort((a, b) => a.lastMsgAge - b.lastMsgAge);
    return { sessions, count: sessions.length, analyzedAt: new Date().toISOString() };
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

    // 실행 중 + 최근 완료(잔광 10초) 태스크 맵 — 빠른 작업 가시성(afterglow):
    // 폴 주기(5~15초) 사이에 끝난 hermes/mlx 검증도 잠깐 working 으로 보이게 한다.
    const activeTasks = db.prepare(
      `SELECT assigned_to, prompt, status FROM tasks
       WHERE status IN ('running','streaming','assigned')
          OR (status='completed' AND completed_at IS NOT NULL AND completed_at > datetime('now','-10 seconds'))
       ORDER BY created_at DESC`
    ).all() as any[];
    const activeMap = new Map<string, string>();
    for (const t of activeTasks) {
      if (t.assigned_to && !activeMap.has(t.assigned_to)) {
        activeMap.set(t.assigned_to, t.prompt?.slice(0, 80) ?? '');
      }
    }
    // CLI 세션 → 대상 provider 위임 집계 (spawned_by_cli 귀속) — 최근 30분
    const delegRows = db.prepare(
      `SELECT spawned_by_cli, assigned_to, status FROM tasks
       WHERE spawned_by_cli IS NOT NULL AND assigned_to IS NOT NULL
         AND created_at > datetime('now','-30 minutes')
       ORDER BY created_at DESC LIMIT 500`
    ).all() as any[];

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
      // 원격 세션 flicker 완화: live 피어 + 최근-seen 원격 피어(TTL) 병합해 깜빡임 방지
      const allPeers = mergeRecentRemotePeers(await listInterSessions());
      const humanPeers = allPeers.filter(p => !p.isNco);
      const ncoPeers   = allPeers.filter(p => p.isNco);

      const sessionRadius = 520;
      const sessionNodeIds: string[] = [];

      // fleet 프로바이더 노드: 클라이언트 mergedGraphData에서 /api/fleet/agents 기반으로 단일 생성
      // (서버 graph에서는 세션 노드만 생성, 프로바이더 노드는 생성하지 않음)

      // 사람/피어 세션 → 큰 다이아몬드 노드 (외부 링)
      humanPeers.forEach((peer, si) => {
        const angle = (si / Math.max(humanPeers.length, 4)) * 2 * Math.PI;
        sessionNodeIds.push(`session:${peer.name}`);
        const isLocal = peer.name.startsWith('nova-macstudio-');
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
            isRemote: !isLocal,
          },
        });

        // 원격 세션 fleet 프로바이더: 클라이언트 mergedGraphData에서 /api/fleet/agents 기반으로 생성
        // (서버 + 클라이언트 이중 생성 → 중복 24개 문제 방지)
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

      // 세션 → 실제 위임 대상 provider 엣지 (spawned_by_cli 귀속).
      // spawned_by_cli(예: 'claude-1')를 session 노드로 해석:
      //   inter-session 이름은 <device>-claude-N, NCO_NAME은 claude-N 이므로
      //   'claude-1' → session:claude-1 (직접) 또는 session:<device>-claude-1 (suffix) 매칭.
      const resolveSessionNode = (cli: string): string | null => {
        if (!cli) return null;
        const direct = `session:${cli}`;
        if (sessionNodeIds.includes(direct)) return direct;
        return sessionNodeIds.find(id => id.endsWith(`-${cli}`)) ?? null;
      };
      // (세션,provider) → {count, active}
      const delegAgg = new Map<string, { src: string; tgt: string; count: number; active: boolean }>();
      const workingSessions = new Set<string>();
      for (const d of delegRows) {
        const src = resolveSessionNode(String(d.spawned_by_cli));
        const tgt = String(d.assigned_to);
        if (!src || !nodeIds.has(tgt)) continue;
        const isActive = d.status === 'running' || d.status === 'streaming' || d.status === 'assigned';
        const key = `${src}::${tgt}`;
        const cur = delegAgg.get(key) ?? { src, tgt, count: 0, active: false };
        cur.count += 1;
        cur.active = cur.active || isActive;
        delegAgg.set(key, cur);
        if (isActive) workingSessions.add(src);
      }
      // 위임 엣지 추가 — 실제 오케스트레이션(누가 무엇에 위임했는지) 표시
      for (const { src, tgt, count, active } of delegAgg.values()) {
        (edges as any[]).push({
          id: `e-spawn-${src}-${tgt}`,
          source: src,
          target: tgt,
          animated: active,
          data: { collaborationCount: count, type: 'spawn', active },
          style: { strokeWidth: Math.min(1 + Math.floor(count / 2), 5), stroke: '#a78bfa' },
        });
      }
      // 세션 working 상태 반영 + claude-code fallback 엣지(위임 이력 없는 세션만 — 무분별한 붕괴 방지)
      // working 판정 소스 2가지:
      //  (1) 로컬 위임 테이블(workingSessions) — 이 기기 NCO로 위임한 세션
      //  (2) inter-session 활동 분석(remoteActivity) — 원격 세션이 broadcast한 'status: working'
      //      또는 최근 done/answer/question·메시지 빈도. 기기 경계를 넘어 원격 작업을 표시하는 핵심.
      const remoteActivity = await analyzeSessionActivity();
      const sessionsWithDeleg = new Set([...delegAgg.values()].map(d => d.src));
      for (const sid of sessionNodeIds) {
        const peerName = sid.startsWith('session:') ? sid.slice('session:'.length) : sid;
        const act = remoteActivity.get(peerName);
        if (workingSessions.has(sid) || act?.status === 'working') {
          const sn = (nodes as any[]).find(n => n.id === sid);
          if (sn) {
            sn.data.status = 'working';
            sn.data.workingSource = workingSessions.has(sid) ? 'local-delegation' : (act?.statusSource ?? 'remote-activity');
          }
        }
        if (!sessionsWithDeleg.has(sid) && nodeIds.has('claude-code')) {
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

    try {
      const organizationRows = db.prepare(`
        SELECT
          o.id,
          o.name,
          o.graph_type,
          o.parent_id,
          COUNT(t.id) AS teamCount
        FROM organizations o
        LEFT JOIN teams t ON t.organization_id = o.id
        GROUP BY o.id, o.name, o.graph_type, o.parent_id
        ORDER BY o.created_at ASC, o.name ASC
      `).all() as Array<{
        id: string;
        name: string;
        graph_type: string;
        parent_id: string | null;
        teamCount: number;
      }>;
      const teamRows = db.prepare(`
        SELECT id, organization_id, name, color, created_at
        FROM teams
        ORDER BY created_at ASC, name ASC
      `).all() as Array<{
        id: string;
        organization_id: string | null;
        name: string;
        color: string | null;
        created_at: string | null;
      }>;
      const memberRows = db.prepare(`
        SELECT team_id, member_type, member_ref
        FROM team_members
        ORDER BY created_at ASC, id ASC
      `).all() as Array<{
        team_id: string;
        member_type: 'provider' | 'session' | 'nco-session';
        member_ref: string;
      }>;
      const teamTaskRows = db.prepare(`
        SELECT team_id, mode, status, prompt, created_at
        FROM tasks
        WHERE team_id IS NOT NULL
        ORDER BY created_at DESC
      `).all() as Array<{
        team_id: string | null;
        mode: string | null;
        status: string | null;
        prompt: string | null;
        created_at: string | null;
      }>;

      const membersByTeam = new Map<string, Array<{ member_type: 'provider' | 'session' | 'nco-session'; member_ref: string }>>();
      for (const row of memberRows) {
        const list = membersByTeam.get(row.team_id) ?? [];
        list.push({ member_type: row.member_type, member_ref: row.member_ref });
        membersByTeam.set(row.team_id, list);
      }

      const tasksByTeam = new Map<string, Array<{
        team_id: string | null;
        mode: string | null;
        status: string | null;
        prompt: string | null;
        created_at: string | null;
      }>>();
      for (const row of teamTaskRows) {
        if (!row.team_id) continue;
        const list = tasksByTeam.get(row.team_id) ?? [];
        list.push(row);
        tasksByTeam.set(row.team_id, list);
      }

      const activeTeamsByOrg = new Map<string, number>();
      const graphNodeIds = new Set((nodes as any[]).map((node: any) => node.id));

      organizationRows.forEach((org, i) => {
        const x = 400 + (i - ((organizationRows.length - 1) / 2)) * 240;
        (nodes as any[]).push({
          id: `org:${org.id}`,
          type: org.graph_type || 'nova-ax',
          position: { x, y: 80 },
          data: {
            label: org.name,
            teamCount: org.teamCount,
            activeTeams: 0,
          },
        });
      });

      // 팀 초기배치: org별 컴팩트 그리드 (기존 단일 행 x=200+i*220 = 폭 5500px 과확산 →
      // 클라 force가 다 못 당겨와 그룹이 멀리 생성됨. org를 2열 격자, org 내 팀을 3열 미니격자로 묶어
      // 초기 스프레드를 ~800px대로 축소 → 세션 등 다른 그룹이 가까이 배치된다.)
      const _teamOrgIds = [...new Set(teamRows.map((t: any) => String(t.organization_id ?? 'none')))];
      const _teamWithinOrg = new Map<string, number>();
      const _teamOrgCounts = new Map<string, number>();
      teamRows.forEach((t: any) => {
        const o = String(t.organization_id ?? 'none');
        _teamOrgCounts.set(o, (_teamOrgCounts.get(o) ?? 0) + 1);
      });
      teamRows.forEach((team, i) => {
        const relatedTasks = tasksByTeam.get(team.id) ?? [];
        const workflow = summarizeTeamWorkflow(relatedTasks);
        const activeTask = relatedTasks.find(t => ['assigned', 'running', 'streaming', 'reviewing'].includes(String(t.status ?? '')))?.prompt?.slice(0, 60) ?? null;
        const isWorking = activeTask !== null;
        if (isWorking && team.organization_id) {
          activeTeamsByOrg.set(team.organization_id, (activeTeamsByOrg.get(team.organization_id) ?? 0) + 1);
        }

        (nodes as any[]).push({
          id: `team:${team.id}`,
          type: 'team',
          position: (() => {
            const _oid = String(team.organization_id ?? 'none');
            const _oi = Math.max(_teamOrgIds.indexOf(_oid), 0);
            const _w = _teamWithinOrg.get(_oid) ?? 0; _teamWithinOrg.set(_oid, _w + 1);
            const _ocx = _oi % 2, _ocy = Math.floor(_oi / 2);
            // within-org 열 수 = √(팀 수) → 큰 org가 세로로만 쌓이지 않고 정사각형에 가깝게
            const _cnt = _teamOrgCounts.get(_oid) ?? 1;
            const _cols = Math.max(2, Math.ceil(Math.sqrt(_cnt)));
            const _wx = _w % _cols, _wy = Math.floor(_w / _cols);
            return { x: 350 + _ocx * 620 + _wx * 130, y: 240 + _ocy * 430 + _wy * 120 };
          })(),
          data: {
            label: team.name,
            color: team.color,
            members: (membersByTeam.get(team.id) ?? []).map(member => member.member_ref),
            organizationId: team.organization_id,
            workflow,
            activeTask,
            status: isWorking ? 'working' : 'idle',
          },
        });
      });

      for (const org of organizationRows) {
        const node = (nodes as any[]).find((entry: any) => entry.id === `org:${org.id}`);
        if (node) node.data.activeTeams = activeTeamsByOrg.get(org.id) ?? 0;

        if (org.parent_id) {
          (edges as any[]).push({
            id: `e-org-parent-${org.parent_id}-${org.id}`,
            source: `org:${org.parent_id}`,
            target: `org:${org.id}`,
            animated: false,
            data: { type: 'org-parent-child', collaborationCount: 1 },
            style: { strokeWidth: 3, stroke: '#6366f1', strokeDasharray: '4,4', opacity: 0.8 },
          });
        }
      }

      const postTeamNodeIds = new Set((nodes as any[]).map((node: any) => node.id));
      for (const team of teamRows) {
        if (team.organization_id) {
          (edges as any[]).push({
            id: `e-org-${team.organization_id}-${team.id}`,
            source: `org:${team.organization_id}`,
            target: `team:${team.id}`,
            animated: false,
            data: { type: 'ax', collaborationCount: 1 },
            style: { strokeWidth: 2, opacity: 0.5 },
          });
        }

        const teamNode = (nodes as any[]).find((entry: any) => entry.id === `team:${team.id}`);
        const teamWorking = teamNode?.data?.status === 'working';
        for (const member of membersByTeam.get(team.id) ?? []) {
          const memberNodeId = member.member_type === 'provider'
            ? member.member_ref
            : member.member_type === 'session'
              ? `session:${member.member_ref}`
              : `nco-session:${member.member_ref}`;
          if (!postTeamNodeIds.has(memberNodeId)) continue;
          if (!graphNodeIds.has(memberNodeId) && !memberNodeId.startsWith('session:') && !memberNodeId.startsWith('nco-session:')) continue;
          (edges as any[]).push({
            id: `e-team-${team.id}-${member.member_type}-${member.member_ref}`,
            source: `team:${team.id}`,
            target: memberNodeId,
            animated: Boolean(teamWorking),
            data: { type: 'team', collaborationCount: 1 },
            style: { strokeWidth: 1.5, opacity: 0.6 },
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

  // ═══ Dashboard Context Notes (맥락노트 + 개선노트) ══════════════
  app.get('/api/dashboard/context-notes', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const home = os.homedir();

    // 맥락노트
    const ctxPath = path.join(home, 'projects', 'context_note.md');
    let contextNote = { exists: false, content: '', mtime: '' };
    try {
      const stat = fs.statSync(ctxPath);
      contextNote = { exists: true, content: fs.readFileSync(ctxPath, 'utf-8').slice(0, 4000), mtime: stat.mtime.toISOString() };
    } catch {}

    // 개선노트 (최근 10개 — score + nextItems만 경량 반환)
    const impDir = path.join(home, '.claude', 'improvements');
    const improvementNotes: any[] = [];
    try {
      const files = fs.readdirSync(impDir)
        .filter((f: string) => f.endsWith('.md') && !f.includes('INDEX'))
        .sort().reverse().slice(0, 10);
      for (const f of files) {
        const fpath = path.join(impDir, f);
        const stat = fs.statSync(fpath);
        const content = fs.readFileSync(fpath, 'utf-8');
        const scoreMatch = content.match(/점수:\s*(\S+)/);
        const nextMatch = content.match(/권장 개선사항[^\n]*\n((?:\d+\..*\n?){1,5})/);
        improvementNotes.push({
          filename: f,
          mtime: stat.mtime.toISOString(),
          score: scoreMatch ? scoreMatch[1] : '-',
          nextItems: nextMatch ? nextMatch[1].trim() : '',
        });
      }
    } catch {}

    return { contextNote, improvementNotes };
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
      const hostMap = new Map<string, {
        host: string;
        agents: any[];
        activity?: FleetReportActivitySummary;
        sessions?: FleetReportSession[];
        sessionsCapable?: boolean;
        from: string;
        ts: string;
      }>();
      const STALE_MS = 2 * 60 * 60 * 1000; // 2시간 이상 오래된 응답은 제외
      const now = Date.now();

      // inter-session 세션명 → 호스트명 추출 (nova-macstudio-claude-1 → nova-macstudio)
      // claude-N-M 패턴 (충돌 회피 suffix) 도 처리: subnote-claude-2-2 → subnote
      const extractHost = (name: string): string => {
        const m = name.match(/^(.+?)-claude-\d+(?:-\d+)*$/);
        return m ? m[1] : name;
      };

      // 텍스트 포맷 providers 파싱
      // 실제 프로바이더 ID: claude-code, opencode, codex, agy 등 (하이픈 포함 소문자)
      // 비 프로바이더: ok, healthy, all-ok, none, 11 등 (상태 표현 또는 숫자)
      const PROVIDER_STATUS_WORDS = /^(ok|all-ok|healthy|enabled|yes|no|true|false|none|disabled|up-to-date|idle|working|error|online|offline|done)$/i;
      const isRealProvider = (id: string) => id && !/^\d+$/.test(id) && !PROVIDER_STATUS_WORDS.test(id);

      const parseTextProviders = (txt: string): any[] | null => {
        // done: providers=[a,b,c] health=ok  (대괄호 포함)
        const arrMatch = txt.match(/providers=\[([^\]]+)\]/);
        if (arrMatch) {
          const ids = arrMatch[1].split(',').map(id => id.trim()).filter(isRealProvider);
          if (ids.length === 0) return null;
          return ids.map(id => ({ id, name: id, status: 'idle' as const, currentTask: null }));
        }
        // done: providers=a,b,c health=ok  (대괄호 없음, 공백/| 전까지)
        const bareMatch = txt.match(/providers=([a-z0-9\-_,]+)/);
        if (bareMatch && !bareMatch[1].includes('all-ok') && !bareMatch[1].includes('enabled')) {
          // 순수 숫자(카운트) 또는 상태 단어 필터링 — 실제 프로바이더 명칭만 허용
          const ids = bareMatch[1].split(',').map(id => id.trim()).filter(isRealProvider);
          if (ids.length === 0) return null;
          return ids.map(id => ({ id, name: id, status: 'idle' as const, currentTask: null }));
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
                  hostMap.set(key, {
                    host: (data.host as string).toLowerCase(),
                    agents: data.agents,
                    activity: data.activity,
                    from: fromName,
                    ts,
                  });
                }
                continue;
              }
            } catch { /* not JSON, fall through */ }

            // status: host=X ts=... providers=all-ok 텍스트 포맷
            const hostMatch = txt.match(/host=([^\s|]+)/);
            if (hostMatch) {
              // host=kangnote-claude-1 같은 세션명도 extractHost로 정규화
              const hostName = extractHost(hostMatch[1]);
              const key = hostName.toLowerCase();
              const existing = hostMap.get(key);
              const existTs = existing?.ts ? new Date(existing.ts).getTime() : 0;
              if (!existing || (tsMs > 0 && tsMs > existTs)) {
                const parsed = parseTextProviders(txt);
                // providers=all-ok → empty list이면 기존 에이전트 목록 유지
                const agents = (parsed && parsed.length > 0) ? parsed : (existing?.agents ?? []);
                hostMap.set(key, { host: hostName, agents, activity: existing?.activity, from: fromName, ts });
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
                hostMap.set(key, { host: hostName, agents, activity: existing?.activity, from: fromName, ts });
              }
            }
          }
        } catch { /* skip malformed */ }
      }

      // push 텔레메트리 병합 — 원격 NCO가 직접 push한 보고(T1)가
      // 메시지 파싱 보고(T4)보다 신선하면 우선한다 (fleet-ops.ts)
      for (const pr of getPushReports()) {
        const key = pr.host.toLowerCase();
        const existing = hostMap.get(key);
        const existTs = existing?.ts ? new Date(existing.ts).getTime() : 0;
        const prTs = new Date(pr.ts).getTime();
        if (!existing || prTs > existTs) {
          hostMap.set(key, {
            host: pr.host,
            agents: pr.agents as any,
            activity: pr.activity,
            sessions: pr.sessions ?? [],
            sessionsCapable: pr.sessionsCapable ?? false,
            from: pr.from ?? `${pr.host}-push`,
            ts: pr.ts,
          });
        }
      }

      // 주: 로컬 호스트(nova-macstudio)는 fleet/agents에 넣지 않는다.
      // 대시보드 클라이언트는 로컬 머신을 provider 노드 + localHostNode로 이미 대표하며,
      // fleet/agents에 로컬이 섞이면 sessionOnlyHosts 경로(App.tsx)가 중복 호스트 노드를
      // 만든다(validFleetHostList는 로컬 제외하지만 sessionOnlyHosts는 미제외).

      // agents=0인 호스트 제거 — 오래된 IS 메시지에서 유래한 빈 호스트 엔트리 방지
      const hosts = Array.from(hostMap.values())
        .filter(h => h.agents.length > 0)
        .map(h => {
          // 신선도: 마지막 보고 경과초 — 프론트가 stale 호스트를 회색/경과표시할 수 있게 제공
          let staleSeconds: number | null = null;
          const tsMs = h.ts ? new Date(h.ts).getTime() : 0;
          if (tsMs > 0) staleSeconds = Math.max(0, Math.round((Date.now() - tsMs) / 1000));
          return { ...h, sessions: h.sessions ?? [], sessionsCapable: h.sessionsCapable ?? false, staleSeconds };
        });
      const totalAgents = hosts.reduce((s, h) => s + h.agents.length, 0);
      return { hosts, totalAgents, hostCount: hosts.length, updatedAt: new Date().toISOString() };
    } catch (err: any) {
      return { hosts: [], totalAgents: 0, hostCount: 0, error: String(err?.message ?? err) };
    }
  });

  // ═══ Fleet 브로드캐스트 트리거 (강제 갱신) ═════════════════
  // 쿨다운: 대시보드 다중 탭/30초 타이머가 겹치면 같은 요청이 원격에 분당 수회
  // 중복 도착 → 원격 세션들이 "재시도 루프"로 판단하고 응답을 거부함 (T1: 12회 중복 항의).
  // 실브로드캐스트는 최소 90초 간격으로 1회만 나간다.
  let lastFleetBroadcastAt = 0;
  const FLEET_BROADCAST_COOLDOWN_MS = 90_000;
  const FLEET_BROADCAST_COOLDOWN_KEY = 'nco:fleet:last-broadcast';
  app.post('/api/fleet/refresh', async () => {
    try {
      const now = Date.now();
      let cooldownRemainingMs: number | null = null;
      let usedRedisCooldown = false;

      try {
        const redis = await getRedis();
        const setResult = await redis.set(
          FLEET_BROADCAST_COOLDOWN_KEY,
          String(now),
          'PX',
          FLEET_BROADCAST_COOLDOWN_MS,
          'NX',
        );
        if (setResult === 'OK') {
          usedRedisCooldown = true;
          lastFleetBroadcastAt = now;
        } else {
          const ttlMs = await redis.pttl(FLEET_BROADCAST_COOLDOWN_KEY);
          if (ttlMs > 0) {
            cooldownRemainingMs = ttlMs;
            usedRedisCooldown = true;
          } else {
            const previousValue = await redis.get(FLEET_BROADCAST_COOLDOWN_KEY);
            const previousTs = previousValue ? Number(previousValue) : NaN;
            if (Number.isFinite(previousTs)) {
              const sinceLast = now - previousTs;
              if (sinceLast < FLEET_BROADCAST_COOLDOWN_MS) {
                cooldownRemainingMs = FLEET_BROADCAST_COOLDOWN_MS - sinceLast;
                usedRedisCooldown = true;
              }
            }
            if (!usedRedisCooldown) {
              const retrySetResult = await redis.set(
                FLEET_BROADCAST_COOLDOWN_KEY,
                String(now),
                'PX',
                FLEET_BROADCAST_COOLDOWN_MS,
              );
              if (retrySetResult === 'OK') {
                usedRedisCooldown = true;
                lastFleetBroadcastAt = now;
              }
            }
          }
        }
      } catch {
        usedRedisCooldown = false;
      }

      if (!usedRedisCooldown) {
        const sinceLast = now - lastFleetBroadcastAt;
        if (sinceLast < FLEET_BROADCAST_COOLDOWN_MS) {
          cooldownRemainingMs = FLEET_BROADCAST_COOLDOWN_MS - sinceLast;
        } else {
          lastFleetBroadcastAt = now;
        }
      }

      if (cooldownRemainingMs !== null && cooldownRemainingMs > 0) {
        return { ok: true, skipped: true, message: `Cooldown: ${Math.round(cooldownRemainingMs / 1000)}s 후 재시도 가능` };
      }
      const IS_BIN = join(process.env.HOME ?? '/Users/nova-ai', '.claude', 'plugins', 'cache', 'inter-session', 'inter-session', '0.1.2', 'skills', 'inter-session', 'bin');
      const msg = 'fleet-status-request: respond with JSON {"host":"<pc-name>","agents":[{"id":"<id>","name":"<name>","status":"idle|working|error","currentTask":"<task or null>"},...]} for all your NCO providers. Use status: prefix.';
      // PM2 프로세스 트리에는 inter-session listener가 없으므로 send.py의 identity
      // discovery가 실패한다("not connected"). 살아있는 세션 키를 PPID_OVERRIDE로
      // 빌려 전송한다 (inter-session.ts runSendPy와 동일 메커니즘, shared.py:565).
      const clientsDir = join(process.env.HOME ?? '/Users/nova-ai', '.claude', 'data', 'inter-session', 'clients');
      let ppidKey: string | null = null;
      try {
        for (const f of readdirSync(clientsDir)) {
          if (!f.endsWith('.session')) continue;
          const pid = parseInt(f, 10);
          if (!Number.isFinite(pid)) continue;
          try { process.kill(pid, 0); } catch { continue; } // stale 세션 제외
          ppidKey = f.replace('.session', '');
          break;
        }
      } catch { /* clients dir 없음 → override 없이 시도 */ }
      const sendEnv = ppidKey ? { ...process.env, INTER_SESSION_PPID_OVERRIDE: ppidKey } : process.env;

      // push 모델(POST /api/fleet/report)로 3분 내 신선한 보고를 보낸 호스트는
      // 브로드캐스트 대상에서 제외한다 (snt 항의 반영: 중복 요청 = 쿼터 낭비 + 노이즈).
      // 대상 산출 실패 시에만 기존 --all 폴백.
      const FRESH_PUSH_MS = 3 * 60_000;
      const freshHosts = new Set(
        getPushReports()
          .filter(r => Date.now() - new Date(r.ts).getTime() < FRESH_PUSH_MS)
          .map(r => r.host.toLowerCase())
      );
      const extractPeerHost = (name: string): string => {
        const m = name.match(/^(.+?)-claude-\d+(?:-\d+)*$/);
        return m ? m[1].toLowerCase() : name.toLowerCase();
      };
      const myHostName = (process.env.HOSTNAME ?? 'nova-macstudio').toLowerCase().replace(/\.local$/, '');
      // 자기 호스트 판정: 완전 일치 또는 inter-session 40자 이름 절단 케이스만
      // (짧은 prefix 우연 일치로 타 호스트를 self로 오탐하지 않도록 최소 8자 요구)
      const isSelfHost = (peerHost: string): boolean =>
        peerHost === myHostName || (myHostName.startsWith(peerHost) && peerHost.length >= 8);
      let targets: string[] | null = null;
      try {
        const { stdout } = await execFileAsync('python3', [join(IS_BIN, 'list.py')], { timeout: 5000, env: sendEnv });
        targets = stdout.split('\n').slice(1)
          .map((l: string) => l.trim().split(/\s+/)[0])
          .filter((n: string) => n && /-claude-\d+(-\d+)*$/.test(n))
          .filter((n: string) => !isSelfHost(extractPeerHost(n)))
          .filter((n: string) => !freshHosts.has(extractPeerHost(n)));
      } catch { targets = null; }

      if (targets === null) {
        await execFileAsync('python3', [join(IS_BIN, 'send.py'), '--all', '--text', msg], { timeout: 5000, env: sendEnv });
        return { ok: true, message: 'Fleet status request broadcast sent (fallback --all)' };
      }
      if (targets.length === 0) {
        return { ok: true, skipped: true, message: `All remote hosts fresh via push (${freshHosts.size} hosts) — broadcast unnecessary` };
      }
      for (const t of targets) {
        try {
          await execFileAsync('python3', [join(IS_BIN, 'send.py'), '--to', t, '--text', msg], { timeout: 5000, env: sendEnv });
        } catch { /* 개별 대상 실패는 무시 */ }
      }
      return { ok: true, message: `Fleet status request sent to ${targets.length} host(s) (excluded ${freshHosts.size} fresh-push)` };
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
  const ACTIVITY_TTL_MS = 180_000;      // Claude 도구 호출 간 생성 침묵(30~120s)을 브리지 - 세션 작업표시 유지
  const ACTIVITY_DONE_TTL_MS = 90_000; // Claude 도구 호출 간 생성 침묵(30~120s)을 브리지 - 세션 작업표시 유지

  // 만료 정리 (10초마다)
  setInterval(() => {
    const now = Date.now();
    for (const [session, acts] of activityStore.entries()) {
      const alive = acts.filter(a =>
        a.done ? now - a.ts < ACTIVITY_DONE_TTL_MS : now - a.ts < ACTIVITY_TTL_MS
      );
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
      // 완료: 삭제 대신 done=true + ts갱신 (12초간 "최근 완료" 표시)
      const updated = existing.map(a =>
        (a.tool === tool && a.file === file) ? { ...a, done: true, ts: Date.now() } : a
      );
      activityStore.set(session, updated);
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
      const alive = acts.filter(a =>
        a.done ? now - a.ts < ACTIVITY_DONE_TTL_MS : now - a.ts < ACTIVITY_TTL_MS
      );
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

    // 프로젝트명 추출 함수 (우선순위: 파일경로 > nco-* > 알려진키워드 > 첫단어)
    const extractProject = (prompt: string): string => {
      if (!prompt) return 'unknown';
      // 1) 파일 경로 패턴: /project/xxx/ 또는 /Users/xxx/project/xxx/
      const pathM = prompt.match(/\/(?:project|projects)\/([a-zA-Z0-9_-]+)/);
      if (pathM) return pathM[1];
      // 2) NCO 대시보드 키워드
      if (/nco.?dashboard/i.test(prompt)) return 'nco-dashboard';
      if (/fleet.?sync|fleet.?감독|fleet.?check/i.test(prompt)) return 'fleet-ops';
      if (/inter.?session/i.test(prompt)) return 'inter-session';
      if (/bootstrap|nova.?fleet/i.test(prompt)) return 'nova-fleet-config';
      // 3) nco-xxx 패턴
      const ncoM = prompt.match(/\b(nco[-_][a-z0-9]+)\b/i);
      if (ncoM) return ncoM[1].toLowerCase();
      // 4) done:/status:/answer: 접두사 → 감독 작업으로 분류
      if (/^(done:|status:|answer:|fleet-)/i.test(prompt.trimStart())) return 'fleet-ops';
      // 5) 첫 의미있는 단어 (조사/접속사 제외)
      const words = prompt.split(/\s+/).filter(w => w.length > 2 && !/^(the|and|for|with|from|this|that|한|의|을|를|이|가|에|서)$/i.test(w));
      return words.slice(0, 2).join(' ').slice(0, 35) || 'unknown';
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

    // 테스트 아티팩트 이름 패턴
    const TEST_PATTERN = /^(race-test-|stress-test-|bench-test-|load-test-|test-task-|debug-|tmp-)/i;
    const projects = [...projectMap.entries()]
      .filter(([name, s]) => {
        const total = s.done + s.fail + s.run + s.pending;
        if (total === 0) return false;                          // 빈 프로젝트 제거
        if (TEST_PATTERN.test(name) && s.done === 0 && s.fail === 0) return false; // 완료 없는 test 제거
        return true;
      })
      .sort((a, b) => {
        // running 먼저, 그 다음 lastAt 내림차순
        const aRun = a[1].run > 0 ? 1 : 0;
        const bRun = b[1].run > 0 ? 1 : 0;
        if (bRun !== aRun) return bRun - aRun;
        return b[1].lastAt.localeCompare(a[1].lastAt);
      })
      .slice(0, Number(limit))
      .map(([name, s]) => ({
        // 프로젝트명 후처리: 트레일링 콜론/마침표/줄바꿈 제거
        name: name.replace(/[:\.\s]+$/, '').trim(),
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
    const urlPath = req.url.split('?')[0];

    // gateway.ts에서 이미 등록된 라우트는 catch-all에서 제외 — Fastify wildcard 우선순위 문제 우회
    const gatewayRoutes = [
      /^\/api\/acquisitions(\/|$)/,
      /^\/api\/invocations(\/|$)/,
      /^\/api\/safety\//,
    ];
    if (gatewayRoutes.some(r => r.test(urlPath))) {
      reply.callNotFound();
      return;
    }

    // Handle /api/learn/search inline
    if (urlPath === '/api/learn/search' && req.method === 'GET') {
      const { knowledgeBase } = await import('../../core/knowledge-base.js');
      const { q, keywords, project, limit } = req.query as any;
      const searchTerms = q || keywords;
      if (!searchTerms) return { data: [], message: 'q or keywords parameter required' };
      return { data: knowledgeBase.query(searchTerms, project, Number(limit) || 10) };
    }

    // ── /api/memory/overview — 전체 에이전트 메모리 요약 ────────────────
    if (urlPath === '/api/memory/overview' && req.method === 'GET') {
      const { vectorMemory } = await import('../../core/vector-memory.js');
      const agentIds = ['agy','claude-2','claude-code','codex','copilot','cursor-agent',
                        'hermes','mlx','nvidia','openclaw','opencode','openrouter'];
      const byAgent = agentIds.map(id => {
        try { return { agentId: id, ...(vectorMemory.stats(id) ?? {}) }; }
        catch { return { agentId: id, total: 0, semantic_count: 0, indexLoaded: false }; }
      }).filter(a => a.total > 0);
      const totalMemories = byAgent.reduce((s, a) => s + (a.total ?? 0), 0);
      return { totalMemories, totalAgents: byAgent.length, lastConsolidatedAt: new Date().toISOString(), byAgent };
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
