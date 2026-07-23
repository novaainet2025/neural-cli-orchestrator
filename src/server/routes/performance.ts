import type { FastifyInstance } from 'fastify';
import { getDb } from '../../storage/database.js';
import { createId } from '../../utils/id.js';

// 성과보고 = 자동 지표(태스크 성공률·건수 + 목표 달성률) + 서술(반성·개선).
// 자동 지표는 tasks/team_goals에서 실시간 산정(T1), 서술은 performance_reports에 기록.

interface SubjectResolve { kind: 'organization' | 'team'; teamIds: string[] }

function resolveSubject(subjectId: string): SubjectResolve | null {
  const db = getDb();
  const org = db.prepare('SELECT id FROM organizations WHERE id = ?').get(subjectId) as { id: string } | undefined;
  if (org) {
    const teams = db.prepare('SELECT id FROM teams WHERE organization_id = ?').all(subjectId) as Array<{ id: string }>;
    return { kind: 'organization', teamIds: teams.map(t => t.id) };
  }
  const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(subjectId) as { id: string } | undefined;
  if (team) return { kind: 'team', teamIds: [subjectId] };
  return null;
}

function taskMetrics(teamIds: string[]): { taskCount: number; completed: number; failed: number; successRate: number } {
  if (!teamIds.length) return { taskCount: 0, completed: 0, failed: 0, successRate: 0 };
  const ph = teamIds.map(() => '?').join(',');
  const db = getDb();
  const rows = db.prepare(
    `SELECT status, COUNT(*) c FROM tasks WHERE team_id IN (${ph}) AND created_at >= datetime('now','-14 days') GROUP BY status`
  ).all(...teamIds) as Array<{ status: string; c: number }>;
  let completed = 0, failed = 0, total = 0;
  for (const r of rows) {
    total += r.c;
    if (r.status === 'completed') completed += r.c;
    else if (['failed', 'timed_out', 'lease_expired'].includes(r.status)) failed += r.c;
  }
  const denom = completed + failed;
  return { taskCount: total, completed, failed, successRate: denom ? Math.round((completed / denom) * 100) : 0 };
}

function goalAttainment(subjectId: string): { count: number; attainment: number } {
  const rows = getDb().prepare(
    `SELECT current_value, target_value, direction FROM team_goals WHERE subject_id = ? AND status = 'active'`
  ).all(subjectId) as Array<{ current_value: number; target_value: number | null; direction: string }>;
  if (!rows.length) return { count: 0, attainment: 0 };
  const att = (cur: number, tgt: number | null, dir: string): number => {
    if (dir === 'decrease') {
      if (tgt == null) return cur <= 0 ? 100 : 0;
      if (cur <= tgt) return 100;
      if (tgt <= 0) return cur <= 0 ? 100 : 0;
      return Math.max(0, Math.min(100, Math.round((tgt / cur) * 100)));
    }
    if (tgt == null || tgt === 0) return cur > 0 ? 100 : 0;
    return Math.max(0, Math.min(100, Math.round((cur / tgt) * 100)));
  };
  const sum = rows.reduce((s, r) => s + att(r.current_value, r.target_value, r.direction ?? 'increase'), 0);
  return { count: rows.length, attainment: Math.round(sum / rows.length) };
}

export function registerPerformanceRoutes(app: FastifyInstance): void {
  // 자동 성과 지표 — 태스크 성공률 + 목표 달성률 (14일 창)
  app.get('/api/performance', async (req, reply) => {
    const q = (req.query as { subjectId?: string }) ?? {};
    if (!q.subjectId) return reply.code(400).send({ error: 'subjectId required' });
    const resolved = resolveSubject(q.subjectId);
    if (!resolved) return reply.code(404).send({ error: `subject not found: ${q.subjectId}` });
    const tasks = taskMetrics(resolved.teamIds);
    const goals = goalAttainment(q.subjectId);
    // 종합 성과 점수: 태스크 성공률 60% + 목표 달성률 40% (목표 없으면 성공률만)
    const composite = goals.count > 0
      ? Math.round(tasks.successRate * 0.6 + goals.attainment * 0.4)
      : tasks.successRate;
    return {
      subjectId: q.subjectId,
      subjectKind: resolved.kind,
      taskCount: tasks.taskCount,
      completed: tasks.completed,
      failed: tasks.failed,
      successRate: tasks.successRate,
      goalCount: goals.count,
      goalAttainment: goals.attainment,
      compositeScore: composite,
      window: '14d',
    };
  });

  // 성과보고(서술) 목록
  app.get('/api/performance/reports', async (req) => {
    const q = (req.query as { subjectId?: string }) ?? {};
    const where = q.subjectId ? 'WHERE subject_id = ?' : '';
    const params = q.subjectId ? [q.subjectId] : [];
    const rows = getDb().prepare(
      `SELECT * FROM performance_reports ${where} ORDER BY created_at DESC LIMIT 50`
    ).all(...params) as Array<Record<string, unknown>>;
    return {
      reports: rows.map(r => ({
        id: r.id, subjectKind: r.subject_kind, subjectId: r.subject_id,
        period: r.period, periodKey: r.period_key,
        metrics: r.metrics_json ? JSON.parse(String(r.metrics_json)) : null,
        reflection: r.reflection, improvement: r.improvement, createdAt: r.created_at,
      })),
    };
  });

  // 성과보고 기록 — 자동 지표 스냅샷 + 반성·개선
  app.post('/api/performance/reports', async (req, reply) => {
    const b = (req.body as Record<string, unknown>) ?? {};
    const subjectId = typeof b.subjectId === 'string' ? b.subjectId.trim() : '';
    if (!subjectId) return reply.code(400).send({ error: 'subjectId required' });
    const resolved = resolveSubject(subjectId);
    if (!resolved) return reply.code(404).send({ error: `subject not found: ${subjectId}` });
    const period = ['daily', 'weekly', 'monthly'].includes(String(b.period)) ? String(b.period) : 'daily';
    const periodKey = typeof b.periodKey === 'string' && b.periodKey.trim() ? b.periodKey.trim() : new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const tasks = taskMetrics(resolved.teamIds);
    const goals = goalAttainment(subjectId);
    const metrics = { ...tasks, goalCount: goals.count, goalAttainment: goals.attainment };
    const id = createId('perf');
    getDb().prepare(`
      INSERT INTO performance_reports (id, subject_kind, subject_id, period, period_key, metrics_json, reflection, improvement)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, resolved.kind, subjectId, period, periodKey, JSON.stringify(metrics),
      typeof b.reflection === 'string' ? b.reflection.slice(0, 2000) : null,
      typeof b.improvement === 'string' ? b.improvement.slice(0, 2000) : null);
    reply.code(201);
    return { id, subjectId, subjectKind: resolved.kind, period, periodKey, metrics };
  });
}
