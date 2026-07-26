import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { computeOrganizationScores, computeTeamScores } from '../../core/team-scorer.js';
import {
  listTeamLifecycleProfiles,
  refreshRetirementWatchlist,
  restoreRetiredTeam,
  runTeamLifecycleReview,
  runWeeklyWorkforcePlanning,
} from '../../core/team-lifecycle.js';
import { runHourlyRoleAudit } from '../../core/hourly-role-oversight.js';
import { getDb } from '../../storage/database.js';

// [이벤트루프 보호 2026-07-26] computeTeamScores는 호출당 ~340-450ms 동기 CPU(73팀,
// tasks 27k 조인 6중 CASE 집계). 대시보드 다중 클라이언트 폴링이 겹치면 호출이 적체되어
// 이벤트 루프가 재포화됨(CDP 프로파일 82% 점유 실측). 점수는 48h/7d 윈도 집계라
// 15초 staleness는 무해 → 라우트 레벨 TTL 캐시. cron/lifecycle 등 내부 호출은 비캐시 유지.
const SCORE_CACHE_TTL_MS = 15_000;

export async function registerTeamScoreRoutes(
  app: FastifyInstance,
  database: Database.Database = getDb(),
): Promise<void> {
  let teamScoresCache: { at: number; data: unknown } | null = null;
  let orgScoresCache: { at: number; data: unknown } | null = null;

  app.get('/api/teams/scores', async () => {
    if (teamScoresCache && Date.now() - teamScoresCache.at < SCORE_CACHE_TTL_MS) {
      return teamScoresCache.data;
    }
    const data = computeTeamScores(database);
    teamScoresCache = { at: Date.now(), data };
    return data;
  });
  app.get('/api/org/scores', async () => {
    if (orgScoresCache && Date.now() - orgScoresCache.at < SCORE_CACHE_TTL_MS) {
      return orgScoresCache.data;
    }
    const data = computeOrganizationScores(database);
    orgScoresCache = { at: Date.now(), data };
    return data;
  });

  app.get('/api/hr/lifecycle', async (request) => {
    const rawLimit = Number((request.query as { eventLimit?: string }).eventLimit ?? 100);
    const eventLimit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100, 500);
    const events = database.prepare(`
      SELECT
        id, team_id AS teamId, team_slug AS teamSlug, event_type AS eventType,
        score, improvement_count AS improvementCount, reason,
        company_run_id AS companyRunId, source, metadata_json AS metadataJson,
        created_at AS createdAt
      FROM team_lifecycle_events
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(eventLimit);
    return {
      policy: {
        reviewSchedule: '*/10 * * * *',
        threshold: 90,
        comparison: '<=',
        persistentRetirementAfterUnresolvedImprovements: 3,
        retirementMode: 'soft',
      },
      profiles: listTeamLifecycleProfiles(database),
      events,
    };
  });

  app.post('/api/hr/lifecycle/check', async (request, reply) => {
    const body = (request.body as { teamId?: unknown } | null) ?? {};
    const teamId = typeof body.teamId === 'string' && body.teamId.trim()
      ? body.teamId.trim()
      : undefined;
    if (teamId) {
      const team = database.prepare('SELECT id FROM teams WHERE id = ?').get(teamId);
      if (!team) return reply.code(404).send({ error: `team not found: ${teamId}` });
    }
    return {
      result: await runTeamLifecycleReview({
        database,
        source: 'manual',
        ...(teamId ? { teamId } : {}),
      }),
    };
  });

  app.post<{ Params: { id: string } }>('/api/hr/lifecycle/teams/:id/restore', async (request, reply) => {
    const body = (request.body as { reason?: unknown } | null) ?? {};
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 3 || reason.length > 500) {
      return reply.code(400).send({ error: 'reason required (3-500 chars)' });
    }
    try {
      return { profile: restoreRetiredTeam(request.params.id, reason, database) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.startsWith('team not found:') ? 404 : 400).send({ error: message });
    }
  });

  app.get('/api/hr/retirement-watchlist', async (request) => {
    const query = request.query as { status?: string };
    const allowed = new Set(['watchlisted', 'approved', 'dismissed', 'retired']);
    const status = query.status && allowed.has(query.status) ? query.status : 'watchlisted';
    const rows = database.prepare(`
      SELECT
        id, subject_kind AS subjectKind, subject_id AS subjectId,
        subject_slug AS subjectSlug, reason, evidence_json AS evidenceJson,
        status, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
        reviewed_at AS reviewedAt, reviewed_by AS reviewedBy
      FROM hr_retirement_watchlist
      WHERE status = ?
      ORDER BY last_seen_at DESC, id DESC
    `).all(status);
    return { status, candidates: rows };
  });

  app.post('/api/hr/retirement-watchlist/refresh', async () => ({
    result: refreshRetirementWatchlist(database),
  }));

  app.get('/api/hr/weekly-actions', async () => ({
    actions: database.prepare(`
      SELECT
        id, week_key AS weekKey, action_type AS actionType,
        subject_id AS subjectId, subject_slug AS subjectSlug,
        based_on_goal_id AS basedOnGoalId,
        performance_reports_reviewed AS performanceReportsReviewed,
        work_reports_reviewed AS workReportsReviewed,
        evidence_json AS evidenceJson, created_at AS createdAt
      FROM hr_weekly_org_actions
      ORDER BY week_key DESC
    `).all(),
  }));

  app.post('/api/hr/weekly-actions/run', async () => ({
    result: await runWeeklyWorkforcePlanning(database),
  }));

  app.get('/api/hr/hourly-audits', async (request) => {
    const rawLimit = Number((request.query as { limit?: string }).limit ?? 100);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100, 500);
    return {
      audits: database.prepare(`
        SELECT
          id, subject_kind AS subjectKind, subject_id AS subjectId,
          status, checks_json AS checksJson, evidence_json AS evidenceJson,
          source, created_at AS createdAt
        FROM hourly_role_audits
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(limit),
    };
  });

  app.post('/api/hr/hourly-audits/run', async () => ({
    result: runHourlyRoleAudit({ database, source: 'manual' }),
  }));
}
