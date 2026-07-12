/**
 * fleet-ops 라우트 — push 기반 fleet 텔레메트리 + 파일 edit-lease
 *
 * 배경 (2026-07-02): 원격 상태를 LLM autoresponder 회신(T4)으로 pull하던 구조는
 * 응답 누락·2시간 stale 문제를 낳았다. 이 모듈은:
 *  1. POST /api/fleet/report   — 원격 NCO가 자기 상태를 직접 push (T1 데이터)
 *  2. GET  /api/fleet/reports  — push 수신 현황 (디버그/검증용)
 *  3. POST /api/lease          — 파일 edit-lease 등록/갱신 (세션 간 충돌 방지)
 *  4. GET  /api/lease?file=    — 활성 lease 조회
 *  5. FLEET_CENTRAL_URL 설정 시 60초마다 자기 상태를 중앙에 push (원격 머신용)
 *
 * dashboard-compat.ts의 GET /api/fleet/agents가 getPushReports()를 병합해
 * push 데이터(신선)가 메시지 파싱 데이터(stale)보다 우선하도록 한다.
 */

import type { FastifyInstance } from 'fastify';
import { hostname } from 'os';
import { agentManager } from '../../agent/agent-manager.js';
import { circuitBreakerRegistry } from '../../security/circuit-breaker-registry.js';
import { eventBus } from '../../core/event-bus.js';
import { sharedState } from '../../core/shared-state.js';
import { getDb } from '../../storage/database.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('fleet-ops');

export interface FleetReportAgent {
  id: string;
  name?: string;
  status?: string;
  currentTask?: string | null;
  taskId?: string;
  since?: string;
  // 리밋/서킷 상세 (2026-07-12): 원격 프로바이더 리밋을 대시보드가 정확히 표시하도록 push에 포함.
  circuitState?: 'closed' | 'half-open' | 'open';
  limited?: boolean;                  // gate.available === false (statusline과 동일한 리밋 신호)
  lastError?: string | null;
  gate?: { status?: string; reason?: string | null; available?: boolean; cooldownUntil?: string | null };
}
export interface FleetReportActivitySummary {
  taskCount: number;
  recentCompletedAt: string | null;
  agentCounts: Record<string, number>;
}
export interface FleetReportSession {
  name: string;
  working: boolean;
  lastToolTs: number;
  currentTool: string | null;
}
export interface FleetReport {
  host: string;
  agents: FleetReportAgent[];
  activity?: FleetReportActivitySummary;
  sessions?: FleetReportSession[];
  // 구버전 push(body.sessions 부재)와 세션 미보고(빈 배열)를 구분 — 프론트 ⚠구버전 배지 판별용
  sessionsCapable?: boolean;
  from?: string;
  ts: string;
}

// ── push 수신 저장소 (메모리, 호스트당 최신 1건) ───────────────────────
// codex 리뷰 반영: 크기 상한(메모리 DoS 방지) + TTL 소거(push 끊긴 호스트가
// 영구히 hostMap을 덮지 않도록 — 10분 지나면 메시지 파싱 데이터로 자연 폴백)
const pushReports = new Map<string, FleetReport>();
const PUSH_MAX_HOSTS = 50;
const PUSH_TTL_MS = 10 * 60_000;

function deletePersistedPushReport(host: string): void {
  getDb().prepare('DELETE FROM fleet_push_reports WHERE host=?').run(host);
}

function persistPushReport(report: FleetReport): void {
  getDb().prepare(`
    INSERT INTO fleet_push_reports (host, payload, ts)
    VALUES (?, ?, ?)
    ON CONFLICT(host) DO UPDATE SET payload=excluded.payload, ts=excluded.ts
  `).run(report.host, JSON.stringify(report), report.ts);
}

function evictExpiredPushReports(now = Date.now()): void {
  for (const [host, report] of pushReports) {
    if (now - new Date(report.ts).getTime() > PUSH_TTL_MS) {
      pushReports.delete(host);
      deletePersistedPushReport(host);
    }
  }
}

export function getPushReports(): FleetReport[] {
  evictExpiredPushReports();
  return Array.from(pushReports.values());
}

function normalizeActivitySummary(value: unknown): FleetReportActivitySummary | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as {
    taskCount?: unknown;
    recentCompletedAt?: unknown;
    agentCounts?: unknown;
  };
  const taskCount = Number(raw.taskCount);
  const recentCompletedAt = typeof raw.recentCompletedAt === 'string' && raw.recentCompletedAt.length > 0
    ? raw.recentCompletedAt
    : null;
  const agentCounts: Record<string, number> = {};
  if (raw.agentCounts && typeof raw.agentCounts === 'object') {
    for (const [agentId, count] of Object.entries(raw.agentCounts as Record<string, unknown>)) {
      const parsed = Number(count);
      if (agentId && Number.isFinite(parsed) && parsed >= 0) {
        agentCounts[agentId] = Math.floor(parsed);
      }
    }
  }
  return {
    taskCount: Number.isFinite(taskCount) && taskCount >= 0 ? Math.floor(taskCount) : 0,
    recentCompletedAt,
    agentCounts,
  };
}

// push body.sessions 검증 — 통과 항목만 정규화 (없으면 빈 배열)
function normalizeSessions(value: unknown): FleetReportSession[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((s): s is Record<string, unknown> =>
      !!s && typeof s === 'object'
      && typeof (s as Record<string, unknown>).name === 'string'
      && ((s as Record<string, unknown>).name as string).length > 0
      && ((s as Record<string, unknown>).name as string).length < 100)
    .map((s) => {
      const lastToolTs = Number(s.lastToolTs);
      return {
        name: s.name as string,
        working: s.working === true,
        lastToolTs: Number.isFinite(lastToolTs) && lastToolTs >= 0 ? lastToolTs : 0,
        currentTool: typeof s.currentTool === 'string' && (s.currentTool as string).length > 0
          ? (s.currentTool as string)
          : null,
      };
    })
    .slice(0, 100);
}

function collectRecentActivitySummary(): FleetReportActivitySummary {
  const rows = getDb().prepare(`
    SELECT assigned_to, completed_at
    FROM tasks
    WHERE assigned_to IS NOT NULL
      AND assigned_to != ''
      AND julianday('now') - julianday(COALESCE(last_activity_at, completed_at, updated_at, created_at)) <= 1
    ORDER BY COALESCE(last_activity_at, completed_at, updated_at, created_at) DESC
    LIMIT 200
  `).all() as Array<{ assigned_to: string; completed_at: string | null }>;

  let recentCompletedAt: string | null = null;
  const agentCounts: Record<string, number> = {};
  for (const row of rows) {
    agentCounts[row.assigned_to] = (agentCounts[row.assigned_to] ?? 0) + 1;
    if (row.completed_at && (!recentCompletedAt || row.completed_at > recentCompletedAt)) {
      recentCompletedAt = row.completed_at;
    }
  }

  return {
    taskCount: rows.length,
    recentCompletedAt,
    agentCounts,
  };
}

export async function collectAgentSnapshots(): Promise<FleetReportAgent[]> {
  const db = getDb();
  const providers = agentManager.listProviders().filter(p => p.enabled !== false);
  const states = await sharedState.getAllAgentStates();
  const activeTasks = db.prepare(
    "SELECT assigned_to, id, prompt, status, created_at FROM tasks WHERE status IN ('running','streaming','assigned') ORDER BY created_at DESC"
  ).all() as Array<{ assigned_to: string | null; id: string; prompt: string | null; status: string; created_at: string | null }>;

  const activeMap = new Map<string, { id: string; prompt: string | null; status: string; created_at: string | null }>();
  for (const task of activeTasks) {
    if (task.assigned_to && !activeMap.has(task.assigned_to)) {
      activeMap.set(task.assigned_to, task);
    }
  }

  return providers.map((provider) => {
    const state = states[provider.id] as any || {};
    const activeTask = activeMap.get(provider.id);
    let status: string;
    let currentTask: string | null = null;
    let taskId: string | undefined;
    let since: string | undefined;

    if (activeTask) {
      status = 'working';
      currentTask = activeTask.prompt?.slice(0, 120) ?? null;
      taskId = activeTask.id;
      since = activeTask.created_at ?? undefined;
    } else {
      const rawStatus = state.status as string | undefined;
      status = rawStatus === 'working' ? 'working'
        : rawStatus === 'idle' ? 'idle'
        : 'online';
      currentTask = typeof state.currentTask === 'string'
        ? state.currentTask.slice(0, 120)
        : state.currentTask ?? null;
    }

    // registry가 단일 진실원 (구 sandbox breaker는 registry와 불일치, kangnote 2026-07-02 보고)
    const snap = circuitBreakerRegistry.getSnapshot(provider.id);
    const circuitState = snap.state;
    if (circuitState === 'open' && status !== 'working') {
      status = 'error';
    }
    // 리밋/서킷 상세 — 로컬 /api/agents(dashboard-compat)와 동일 포맷으로 push에 포함(원격 리밋 정확표시)
    const avail = circuitBreakerRegistry.getAvailability(provider.id);
    const lastError = typeof state.lastError === 'string'
      ? state.lastError.slice(0, 120)
      : (snap.openedAt ? `마지막 실패: ${new Date(snap.openedAt).toLocaleTimeString('ko-KR')}` : null);

    return {
      id: provider.id,
      name: provider.name ?? provider.id,
      status,
      currentTask,
      ...(taskId ? { taskId } : {}),
      ...(since ? { since } : {}),
      circuitState: circuitState as 'closed' | 'half-open' | 'open',
      limited: avail.available === false,
      lastError,
      gate: {
        status: avail.status,
        reason: avail.reason,
        available: avail.available,
        cooldownUntil: avail.cooldownUntil,
      },
    };
  });
}

// ── edit-lease 저장소 (파일 → lease) ──────────────────────────────────
interface Lease { file: string; session: string; expiresAt: number }
const leases = new Map<string, Lease>();
const LEASE_MAX_TTL_SEC = 120;
const LEASE_MAX_ENTRIES = 500; // codex 리뷰 반영: 무제한 key 생성 방지

function evictExpiredLeases(): void {
  const now = Date.now();
  for (const [k, l] of leases) { if (l.expiresAt <= now) leases.delete(k); }
}

function activeLease(file: string): Lease | null {
  const l = leases.get(file);
  if (!l) return null;
  if (l.expiresAt <= Date.now()) { leases.delete(file); return null; }
  return l;
}

export async function registerFleetOpsRoutes(app: FastifyInstance) {
  const db = getDb();
  const persistedReports = db.prepare(`
    SELECT host, payload, ts
    FROM fleet_push_reports
  `).all() as Array<{ host: string; payload: string; ts: string }>;
  const deleteExpiredPushReport = db.prepare('DELETE FROM fleet_push_reports WHERE host=?');
  const now = Date.now();
  for (const row of persistedReports) {
    if (now - new Date(row.ts).getTime() > PUSH_TTL_MS) {
      deleteExpiredPushReport.run(row.host);
      continue;
    }
    try {
      const parsed = JSON.parse(row.payload) as Partial<FleetReport>;
      const agents = Array.isArray(parsed.agents) ? parsed.agents : null;
      if (!agents) {
        deleteExpiredPushReport.run(row.host);
        continue;
      }
      pushReports.set(row.host, {
        host: row.host,
        agents: agents
          .filter(a => a && typeof a.id === 'string' && a.id.length > 0 && a.id.length < 50 && !a.id.includes('/'))
          .map(a => ({
            id: a.id,
            name: a.name ?? a.id,
            status: a.status ?? 'idle',
            currentTask: a.currentTask ?? null,
            taskId: typeof a.taskId === 'string' && a.taskId.length > 0 ? a.taskId : undefined,
            since: typeof a.since === 'string' && a.since.length > 0 ? a.since : undefined,
          })),
        activity: normalizeActivitySummary(parsed.activity),
        sessions: normalizeSessions(parsed.sessions),
        from: typeof parsed.from === 'string' ? parsed.from : undefined,
        ts: row.ts,
      });
    } catch {
      deleteExpiredPushReport.run(row.host);
    }
  }

  // ─── POST /api/fleet/report — 원격 NCO의 상태 push ───────────────────
  app.post('/api/fleet/report', async (req, reply) => {
    const body = req.body as Partial<FleetReport> | undefined;
    const host = (body?.host ?? '').toString().trim().toLowerCase();
    const agents = Array.isArray(body?.agents) ? body!.agents : null;
    if (!host || !agents) {
      reply.code(400);
      return { ok: false, error: 'host and agents[] required' };
    }
    // 유효 에이전트만 (id 필수, 경로형 문자열 배제 — 메시지 파서와 동일 기준)
    const valid = agents
      .filter(a => a && typeof a.id === 'string' && a.id.length > 0 && a.id.length < 50 && !a.id.includes('/'))
      .map(a => ({
        id: a.id,
        name: a.name ?? a.id,
        status: a.status ?? 'idle',
        currentTask: a.currentTask ?? null,
        taskId: typeof a.taskId === 'string' && a.taskId.length > 0 ? a.taskId : undefined,
        since: typeof a.since === 'string' && a.since.length > 0 ? a.since : undefined,
      }))
      .slice(0, 100);
    if (valid.length === 0) {
      reply.code(400);
      return { ok: false, error: 'no valid agents' };
    }
    evictExpiredPushReports();
    if (!pushReports.has(host) && pushReports.size >= PUSH_MAX_HOSTS) {
      reply.code(429);
      return { ok: false, error: 'too many hosts' };
    }
    const ts = new Date().toISOString();
    const report = {
      host,
      agents: valid,
      activity: normalizeActivitySummary(body?.activity),
      sessions: normalizeSessions(body?.sessions),
      // sessions 필드를 배열로 보낸 신버전인지 기록 — 부재 시 구버전 기기로 판별
      sessionsCapable: Array.isArray((body as any)?.sessions),
      from: (body?.from ?? `${host}-push`),
      ts,
    };
    pushReports.set(host, report);
    persistPushReport(report);
    await eventBus.publish({
      type: 'fleet:update',
      host,
      agents: valid.map((agent) => ({
        id: agent.id,
        status: agent.status ?? 'idle',
        currentTask: agent.currentTask ?? null,
        taskId: agent.taskId,
        since: agent.since,
      })),
      activity: report.activity,
      agentCount: valid.length,
      ts,
    });
    return { ok: true, host, agents: valid.length };
  });

  // ─── GET /api/fleet/reports — push 수신 현황 (검증용) ────────────────
  app.get('/api/fleet/reports', async () => {
    const now = Date.now();
    return {
      reports: getPushReports().map(r => ({
        host: r.host,
        agents: r.agents.length,
        ts: r.ts,
        ageSeconds: Math.round((now - new Date(r.ts).getTime()) / 1000),
      })),
    };
  });

  // ─── POST /api/lease — edit-lease 등록/갱신 ──────────────────────────
  // 응답에 현재 holder를 항상 포함 — 훅은 holder가 자기 자신이 아니면 경고.
  app.post('/api/lease', async (req, reply) => {
    const body = req.body as { file?: string; session?: string; ttlSec?: number } | undefined;
    const file = (body?.file ?? '').toString();
    const session = (body?.session ?? '').toString();
    if (!file || !session) {
      reply.code(400);
      return { ok: false, error: 'file and session required' };
    }
    const ttlSec = Math.min(Math.max(body?.ttlSec ?? 30, 5), LEASE_MAX_TTL_SEC);
    evictExpiredLeases();
    if (!leases.has(file) && leases.size >= LEASE_MAX_ENTRIES) {
      reply.code(429);
      return { ok: false, error: 'too many leases' };
    }
    const existing = activeLease(file);
    if (existing && existing.session !== session) {
      // 다른 세션이 보유 중 — 뺏지 않고 충돌만 보고 (soft lease)
      return {
        ok: true, acquired: false,
        holder: existing.session,
        holderExpiresInSec: Math.round((existing.expiresAt - Date.now()) / 1000),
      };
    }
    leases.set(file, { file, session, expiresAt: Date.now() + ttlSec * 1000 });
    return { ok: true, acquired: true, holder: session, ttlSec };
  });

  // ─── GET /api/lease?file= — 활성 lease 조회 ──────────────────────────
  app.get('/api/lease', async (req) => {
    const file = ((req.query as Record<string, string>)?.file ?? '').toString();
    if (file) {
      const l = activeLease(file);
      return { lease: l ? { ...l, expiresInSec: Math.round((l.expiresAt - Date.now()) / 1000) } : null };
    }
    const now = Date.now();
    const all = Array.from(leases.values())
      .filter(l => l.expiresAt > now)
      .map(l => ({ ...l, expiresInSec: Math.round((l.expiresAt - now) / 1000) }));
    return { leases: all };
  });

  // ─── 발신 클라이언트: FLEET_CENTRAL_URL 설정 시 60초마다 자기 상태 push ──
  // 원격 머신(.env: FLEET_CENTRAL_URL=http://<중앙 tailscale ip>:6200)에서만 활성.
  const central = (process.env.FLEET_CENTRAL_URL ?? '').replace(/\/$/, '');
  if (central) {
    const myHost = hostname().toLowerCase().replace(/\.local$/, '');
    // 자기 자신의 activityStore(GET /api/activity)를 세션 요약으로 변환 — push에 동봉
    const collectLocalSessions = async (): Promise<FleetReportSession[]> => {
      try {
        const res = await fetch('http://localhost:6200/api/activity', { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return [];
        const data = await res.json() as {
          activities?: Record<string, Array<{ tool?: unknown; ts?: unknown; done?: unknown }>>;
        };
        const activities = data?.activities ?? {};
        const sessions: FleetReportSession[] = [];
        for (const [name, acts] of Object.entries(activities)) {
          if (!Array.isArray(acts) || acts.length === 0) continue;
          const working = acts.some(a => a && a.done === false);
          let lastToolTs = 0;
          let currentTool: string | null = null;
          for (const a of acts) {
            const ts = Number(a?.ts);
            if (Number.isFinite(ts) && ts >= lastToolTs) {
              lastToolTs = ts;
              currentTool = typeof a?.tool === 'string' && a.tool.length > 0 ? a.tool : null;
            }
          }
          sessions.push({ name, working, lastToolTs, currentTool });
        }
        return sessions;
      } catch {
        return [];
      }
    };
    const pushOnce = async () => {
      try {
        const agents = await collectAgentSnapshots();
        const activity = collectRecentActivitySummary();
        const sessions = await collectLocalSessions();
        await fetch(`${central}/api/fleet/report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host: myHost, agents, activity, sessions, from: `${myHost}-nco-push` }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (err) {
        log.debug({ err: String(err) }, 'fleet push failed (central unreachable)');
      }
    };
    let pushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let firstPendingAt = 0; // 기아 방지: 이벤트 폭주로 디바운스가 계속 리셋돼도 최대 지연 보장
    const PUSH_DEBOUNCE_MS = 4000;
    const PUSH_MAX_DELAY_MS = 15_000;
    const schedulePush = () => {
      const now = Date.now();
      if (!firstPendingAt) firstPendingAt = now;
      if (now - firstPendingAt >= PUSH_MAX_DELAY_MS) {
        // 최대 지연 초과 — 디바운스 무시하고 즉시 push
        if (pushDebounceTimer) { clearTimeout(pushDebounceTimer); pushDebounceTimer = null; }
        firstPendingAt = 0;
        void pushOnce();
        return;
      }
      if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
      pushDebounceTimer = setTimeout(() => {
        pushDebounceTimer = null;
        firstPendingAt = 0;
        void pushOnce();
      }, PUSH_DEBOUNCE_MS);
      pushDebounceTimer.unref();
    };
    const handleFleetRelevantEvent = () => {
      schedulePush();
    };
    eventBus.on('task:created', handleFleetRelevantEvent);
    eventBus.on('task:completed', handleFleetRelevantEvent);
    eventBus.on('task:failed', handleFleetRelevantEvent);
    setInterval(pushOnce, 60_000).unref();
    void pushOnce();
    log.info({ central, myHost }, 'fleet push client enabled');
  }
}
