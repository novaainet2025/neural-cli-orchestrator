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
import { createLogger } from '../../utils/logger.js';

const log = createLogger('fleet-ops');

export interface FleetReportAgent {
  id: string;
  name?: string;
  status?: string;
  currentTask?: string | null;
}
export interface FleetReport {
  host: string;
  agents: FleetReportAgent[];
  from?: string;
  ts: string;
}

// ── push 수신 저장소 (메모리, 호스트당 최신 1건) ───────────────────────
// codex 리뷰 반영: 크기 상한(메모리 DoS 방지) + TTL 소거(push 끊긴 호스트가
// 영구히 hostMap을 덮지 않도록 — 10분 지나면 메시지 파싱 데이터로 자연 폴백)
const pushReports = new Map<string, FleetReport>();
const PUSH_MAX_HOSTS = 50;
const PUSH_TTL_MS = 10 * 60_000;

export function getPushReports(): FleetReport[] {
  const now = Date.now();
  for (const [k, r] of pushReports) {
    if (now - new Date(r.ts).getTime() > PUSH_TTL_MS) pushReports.delete(k);
  }
  return Array.from(pushReports.values());
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
      .map(a => ({ id: a.id, name: a.name ?? a.id, status: a.status ?? 'idle', currentTask: a.currentTask ?? null }));
    if (valid.length === 0) {
      reply.code(400);
      return { ok: false, error: 'no valid agents' };
    }
    if (valid.length > 100) valid.length = 100; // 호스트당 상한
    if (!pushReports.has(host) && pushReports.size >= PUSH_MAX_HOSTS) {
      reply.code(429);
      return { ok: false, error: 'too many hosts' };
    }
    pushReports.set(host, { host, agents: valid, from: (body?.from ?? `${host}-push`), ts: new Date().toISOString() });
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
    const pushOnce = async () => {
      try {
        const providers = agentManager.listProviders().filter(p => p.enabled !== false);
        const agents = providers.map(p => ({
          id: p.id, name: p.name ?? p.id,
          status: 'idle',
          currentTask: null,
        }));
        await fetch(`${central}/api/fleet/report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host: myHost, agents, from: `${myHost}-nco-push` }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (err) {
        log.debug({ err: String(err) }, 'fleet push failed (central unreachable)');
      }
    };
    setInterval(pushOnce, 60_000).unref();
    void pushOnce();
    log.info({ central, myHost }, 'fleet push client enabled');
  }
}
