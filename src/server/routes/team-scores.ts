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

// [이벤트루프 보호] computeTeamScores는 큰 tasks 테이블의 응답/메타데이터까지 검사하는
// 동기 SQLite 집계다. 대시보드는 teams/scores와 org/scores를 동시에 30초마다 요청하므로,
// 라우트별 독립 계산은 같은 집계를 연속 두 번 실행해 health/run 요청까지 막는다.
// 두 라우트가 하나의 팀 점수 스냅샷을 공유하고, 48h/7d 이동창의 표시 점수는 5분 TTL로
// 제한한다. cron/lifecycle의 명시적 내부 계산은 이 표시 캐시를 거치지 않는다.
const SCORE_CACHE_TTL_MS = 5 * 60_000;
type TeamScoresSnapshot = ReturnType<typeof computeTeamScores>;

export async function registerTeamScoreRoutes(
  app: FastifyInstance,
  database: Database.Database = getDb(),
): Promise<void> {
  let teamScoresCache: { at: number; data: TeamScoresSnapshot } | null = null;
  let orgScoresCache: { at: number; data: unknown } | null = null;

  const readTeamScores = (): TeamScoresSnapshot => {
    if (teamScoresCache && Date.now() - teamScoresCache.at < SCORE_CACHE_TTL_MS) {
      return teamScoresCache.data;
    }
    const data = computeTeamScores(database);
    teamScoresCache = { at: Date.now(), data };
    // 회사 점수는 이 팀 스냅샷에서 파생되므로 팀 스냅샷 갱신 시 함께 무효화한다.
    orgScoresCache = null;
    return data;
  };

  app.get('/api/teams/scores', async () => {
    return readTeamScores();
  });
  app.get('/api/org/scores', async () => {
    if (orgScoresCache && Date.now() - orgScoresCache.at < SCORE_CACHE_TTL_MS) {
      return orgScoresCache.data;
    }
    const data = computeOrganizationScores(database, readTeamScores());
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
