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

export async function registerDashboardRoutes(app: FastifyInstance) {

  // ═══ Attendance / 직원 출퇴근 기록 ════════════════════
  app.get('/api/attendance/records', async (req) => {
    const db = getDb();
    const query = req.query as any;
    const rawLimit = Number(query.limit || 100);
    const limit = Math.min(Number.isFinite(rawLimit) ? rawLimit : 100, 500);

    const conditions: string[] = [];
    const params: any[] = [];

    if (query.employeeId) {
      conditions.push('employee_id = ?');
      params.push(String(query.employeeId));
    }
    if (query.employeeName) {
      conditions.push('employee_name LIKE ?');
      params.push(`%${String(query.employeeName)}%`);
    }
    if (query.department) {
      conditions.push('department = ?');
      params.push(String(query.department));
    }
    if (query.status) {
      conditions.push('status = ?');
      params.push(String(query.status));
    }
    if (query.from) {
      conditions.push('work_date >= ?');
      params.push(String(query.from));
    }
    if (query.to) {
      conditions.push('work_date <= ?');
      params.push(String(query.to));
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const totalRow = db.prepare(`SELECT COUNT(*) as c FROM attendance_records ${whereClause}`).get(...params) as { c: number };
    const records = db.prepare(`
      SELECT
        id,
        employee_id as employeeId,
        employee_name as employeeName,
        department,
        work_date as workDate,
        check_in_at as checkInAt,
        check_out_at as checkOutAt,
        status,
        note,
        created_at as createdAt,
        updated_at as updatedAt
      FROM attendance_records
      ${whereClause}
      ORDER BY work_date DESC, employee_name ASC
      LIMIT ?
    `).all(...params, limit);

    return {
      records,
      total: totalRow?.c || 0,
      filters: {
        employeeId: query.employeeId || null,
        employeeName: query.employeeName || null,
        department: query.department || null,
        status: query.status || null,
        from: query.from || null,
        to: query.to || null,
        limit,
      },
    };
  });

  app.get('/api/employees/:employeeId/attendance', async (req) => {
    const { employeeId } = req.params as any;
    const query = req.query as any;
    const qs = new URLSearchParams();
    qs.set('employeeId', String(employeeId));
    if (query.from) qs.set('from', String(query.from));
    if (query.to) qs.set('to', String(query.to));
    if (query.status) qs.set('status', String(query.status));
    if (query.limit) qs.set('limit', String(query.limit));
    return app.inject({ method: 'GET', url: `/api/attendance/records?${qs.toString()}` });
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

  // ═══ Catch-all for unimplemented routes ═════════════
  // Note: This must be the LAST route registered. Routes added in gateway.ts
  // before registerDashboardRoutes() take priority via Fastify's route matching.
  app.all('/api/*', async (req, reply) => {
    const urlPath = req.url.split('?')[0];

    // GET /api/learn/search
    if (urlPath === '/api/learn/search' && req.method === 'GET') {
      const { knowledgeBase } = await import('../../core/knowledge-base.js');
      const { q, keywords, project, limit } = req.query as any;
      const searchTerms = q || keywords;
      if (!searchTerms) return { data: [], message: 'q or keywords parameter required' };
      return { data: knowledgeBase.query(searchTerms, project, Number(limit) || 10) };
    }

    // GET /api/memory — 메모리 통계 + 최근 항목 요약
    if (urlPath === '/api/memory' && req.method === 'GET') {
      const { semanticMemory } = await import('../../core/semantic-memory.js');
      const stats = semanticMemory.getStats();
      const recent = semanticMemory.search('', { limit: 5 });
      return { data: recent, stats, message: 'ok' };
    }

    // GET /api/knowledge — 지식 베이스 요약
    if (urlPath === '/api/knowledge' && req.method === 'GET') {
      const { knowledgeBase } = await import('../../core/knowledge-base.js');
      const { getDb } = await import('../../storage/database.js');
      const db = getDb();
      const queryParam = (req.query as any)?.q || '';
      const context = knowledgeBase.getContext('default');
      // When no query: return all entries ordered by recency
      const all = queryParam
        ? knowledgeBase.query(queryParam, undefined, 20)
        : db.prepare('SELECT * FROM knowledge_base ORDER BY updated_at DESC LIMIT 20').all();
      const stats = {
        total: (db.prepare('SELECT COUNT(*) as c FROM knowledge_base').get() as any)?.c ?? 0,
        byCategory: db.prepare(`SELECT category, COUNT(*) as count FROM knowledge_base GROUP BY category`).all(),
      };
      return { data: all, context, stats, message: 'ok' };
    }

    reply.code(200);
    return { data: [], message: `Route ${req.method} ${req.url} — pending implementation` };
  });
}
