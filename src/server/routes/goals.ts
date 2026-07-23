import type { FastifyInstance } from 'fastify';
import { getDb } from '../../storage/database.js';
import { createId } from '../../utils/id.js';

type GoalPeriod = 'daily' | 'weekly' | 'monthly';
type GoalStatus = 'active' | 'met' | 'missed' | 'archived';

type GoalDirection = 'increase' | 'decrease';

interface GoalRow {
  id: string;
  subject_kind: 'organization' | 'team';
  subject_id: string;
  period: GoalPeriod;
  period_key: string;
  title: string;
  metric: string | null;
  target_value: number | null;
  current_value: number;
  unit: string | null;
  status: GoalStatus;
  note: string | null;
  direction: GoalDirection;
  created_at: string;
  updated_at: string;
}

const PERIODS: GoalPeriod[] = ['daily', 'weekly', 'monthly'];
const STATUSES: GoalStatus[] = ['active', 'met', 'missed', 'archived'];

// target 대비 현재치 달성률(0~100). 방향 반영.
// increase: 높을수록 좋음(current/target). decrease: 낮을수록 좋음(target/current), current<=target이면 100%.
function attainment(current: number, target: number | null, direction: GoalDirection = 'increase'): number {
  if (direction === 'decrease') {
    if (target == null) return current <= 0 ? 100 : 0;
    if (current <= target) return 100;
    if (target <= 0) return current <= 0 ? 100 : 0;
    return Math.max(0, Math.min(100, Math.round((target / current) * 100)));
  }
  if (target == null || target === 0) return current > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((current / target) * 100)));
}

function serialize(row: GoalRow) {
  return {
    id: row.id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    period: row.period,
    periodKey: row.period_key,
    title: row.title,
    metric: row.metric,
    targetValue: row.target_value,
    currentValue: row.current_value,
    unit: row.unit,
    status: row.status,
    note: row.note,
    direction: row.direction ?? 'increase',
    attainment: attainment(row.current_value, row.target_value, row.direction ?? 'increase'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function str(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function registerGoalsRoutes(app: FastifyInstance): void {
  // 목록 — subjectId/period/periodKey로 선택 필터
  app.get('/api/goals', async (req) => {
    const q = (req.query as { subjectId?: string; period?: string; periodKey?: string; status?: string }) ?? {};
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.subjectId) { where.push('subject_id = ?'); params.push(q.subjectId); }
    if (q.period && PERIODS.includes(q.period as GoalPeriod)) { where.push('period = ?'); params.push(q.period); }
    if (q.periodKey) { where.push('period_key = ?'); params.push(q.periodKey); }
    if (q.status && STATUSES.includes(q.status as GoalStatus)) { where.push('status = ?'); params.push(q.status); }
    const sql = `SELECT * FROM team_goals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY period, period_key DESC, created_at DESC`;
    const rows = getDb().prepare(sql).all(...params) as GoalRow[];
    return { goals: rows.map(serialize) };
  });

  // 진척 요약 — subject의 활성 목표 평균 달성률 + 기간별 카운트
  app.get('/api/goals/progress', async (req) => {
    const q = (req.query as { subjectId?: string }) ?? {};
    if (!q.subjectId) return { subjectId: null, overall: 0, byPeriod: {}, goals: [] };
    const rows = getDb().prepare(
      `SELECT * FROM team_goals WHERE subject_id = ? AND status = 'active' ORDER BY period`
    ).all(q.subjectId) as GoalRow[];
    const scored = rows.map(serialize);
    const overall = scored.length ? Math.round(scored.reduce((s, g) => s + g.attainment, 0) / scored.length) : 0;
    const byPeriod: Record<string, { count: number; attainment: number }> = {};
    for (const p of PERIODS) {
      const g = scored.filter(x => x.period === p);
      byPeriod[p] = { count: g.length, attainment: g.length ? Math.round(g.reduce((s, x) => s + x.attainment, 0) / g.length) : 0 };
    }
    return { subjectId: q.subjectId, overall, byPeriod, goals: scored };
  });

  // 생성
  app.post('/api/goals', async (req, reply) => {
    const b = (req.body as Record<string, unknown>) ?? {};
    const title = str(b.title, 200);
    const subjectId = str(b.subjectId, 120);
    const subjectKind = b.subjectKind === 'organization' ? 'organization' : b.subjectKind === 'team' ? 'team' : null;
    const period = PERIODS.includes(b.period as GoalPeriod) ? (b.period as GoalPeriod) : null;
    const periodKey = str(b.periodKey, 20);
    if (!title) return reply.code(400).send({ error: 'title required' });
    if (!subjectId || !subjectKind) return reply.code(400).send({ error: 'subjectId and subjectKind(organization|team) required' });
    if (!period) return reply.code(400).send({ error: 'period must be daily|weekly|monthly' });
    if (!periodKey) return reply.code(400).send({ error: 'periodKey required (e.g. 2026-07-24 | 2026-W30 | 2026-07)' });
    const direction: GoalDirection = b.direction === 'decrease' ? 'decrease' : 'increase';
    const id = createId('goal');
    getDb().prepare(`
      INSERT INTO team_goals (id, subject_kind, subject_id, period, period_key, title, metric, target_value, current_value, unit, status, note, direction)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(id, subjectKind, subjectId, period, periodKey, title, str(b.metric, 120), num(b.targetValue), num(b.currentValue) ?? 0, str(b.unit, 20), str(b.note, 500), direction);
    const row = getDb().prepare('SELECT * FROM team_goals WHERE id = ?').get(id) as GoalRow;
    reply.code(201);
    return { goal: serialize(row) };
  });

  // 수정 — 진척치/상태/반성메모 등
  app.patch<{ Params: { id: string } }>('/api/goals/:id', async (req, reply) => {
    const { id } = req.params;
    const b = (req.body as Record<string, unknown>) ?? {};
    const existing = getDb().prepare('SELECT * FROM team_goals WHERE id = ?').get(id) as GoalRow | undefined;
    if (!existing) return reply.code(404).send({ error: `goal not found: ${id}` });
    const sets: string[] = [];
    const params: unknown[] = [];
    const put = (col: string, val: unknown) => { sets.push(`${col} = ?`); params.push(val); };
    if (b.title !== undefined) { const t = str(b.title, 200); if (t) put('title', t); }
    if (b.metric !== undefined) put('metric', str(b.metric, 120));
    if (b.targetValue !== undefined) put('target_value', num(b.targetValue));
    if (b.currentValue !== undefined) put('current_value', num(b.currentValue) ?? 0);
    if (b.unit !== undefined) put('unit', str(b.unit, 20));
    if (b.note !== undefined) put('note', str(b.note, 500));
    if (b.direction !== undefined) put('direction', b.direction === 'decrease' ? 'decrease' : 'increase');
    if (b.status !== undefined && STATUSES.includes(b.status as GoalStatus)) put('status', b.status);
    if (!sets.length) return { goal: serialize(existing) };
    sets.push("updated_at = datetime('now')");
    params.push(id);
    getDb().prepare(`UPDATE team_goals SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    const row = getDb().prepare('SELECT * FROM team_goals WHERE id = ?').get(id) as GoalRow;
    return { goal: serialize(row) };
  });

  // 삭제
  app.delete<{ Params: { id: string } }>('/api/goals/:id', async (req) => {
    getDb().prepare('DELETE FROM team_goals WHERE id = ?').run(req.params.id);
    return { ok: true };
  });
}
