import type Database from 'better-sqlite3';
import { eventBus, type NCOEvent } from './event-bus.js';
import { getCompanyRun } from './company-orchestrator.js';
import {
  computeTeamScores,
  TEAM_SCORE_MIN_ACTIONABLE_SAMPLE,
  TEAM_SCORE_TARGET,
  type TeamScore,
} from './team-scorer.js';
import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';
import { resolveInternalProjectDir, resolveTaskProjectDir } from '../utils/project-dir.js';

const log = createLogger('team-lifecycle');

export const TEAM_LIFECYCLE_JOB_ID = 'team-score-diagnostics';
export const TEAM_LIFECYCLE_SCHEDULE = '*/10 * * * *';
export const TEAM_LIFECYCLE_MAX_IMPROVEMENTS = 3;
export const TEAM_LIFECYCLE_MAX_PER_REVIEW = 5;
export const TEAM_LIFECYCLE_COOLDOWN_MS = 10 * 60 * 1000;
export const TEAM_LIFECYCLE_IMMEDIATE_MIN_SAMPLE = 10;
export const TEAM_LIFECYCLE_IMMEDIATE_MAX_COMPLETION = 20;
export const TEAM_LIFECYCLE_IMMEDIATE_MIN_FAILURES = 5;
export const TEAM_LIFECYCLE_IMMEDIATE_ORG_FAILURE_SHARE = 0.5;

const PROTECTED_TEAM_IDS = new Set(['team_hr-director', 'team_self-improvement']);
const ACTIVE_TASK_STATUSES = new Set([
  'pending',
  'queued',
  'assigned',
  'in_progress',
  'running',
  'streaming',
  'reviewing',
]);
const TERMINAL_COMPANY_STATUSES = new Set(['completed', 'partial', 'failed']);

export type TeamLifecycleSource = 'scheduled' | 'event' | 'manual' | 'system';
export type TeamLifecycleStatus = 'active' | 'improving' | 'probation' | 'retired';

export interface TeamLifecycleProfile {
  teamId: string;
  teamSlug: string;
  teamName: string;
  organizationId: string | null;
  status: TeamLifecycleStatus;
  improvementCount: number;
  successfulImprovementCount: number;
  failedImprovementCount: number;
  unresolvedImprovementCount: number;
  consecutiveLowChecks: number;
  lastScore: number | null;
  lastSampleSize: number;
  firstLowAt: string | null;
  lastCheckedAt: string | null;
  lastImprovementAt: string | null;
  activeRunId: string | null;
  retiredAt: string | null;
  retirementReason: string | null;
  protected: boolean;
}

interface LifecycleProfileRow {
  team_id: string;
  team_slug: string;
  team_name: string;
  organization_id: string | null;
  status: TeamLifecycleStatus;
  improvement_count: number;
  successful_improvement_count: number;
  failed_improvement_count: number;
  unresolved_improvement_count: number;
  consecutive_low_checks: number;
  last_score: number | null;
  last_sample_size: number;
  first_low_at: string | null;
  last_checked_at: string | null;
  last_improvement_at: string | null;
  active_run_id: string | null;
  retired_at: string | null;
  retirement_reason: string | null;
  protected: number;
}

export interface ImprovementDirective {
  team: TeamScore;
  improvementCount: number;
  consecutiveLowChecks: number;
  unresolvedImprovementCount: number;
  source: TeamLifecycleSource;
  goal: string;
}

export interface ImprovementTriggerResult {
  ok: boolean;
  runId?: string;
  error?: string;
}

export interface TeamLifecycleReviewOptions {
  database?: Database.Database;
  scores?: TeamScore[];
  source?: TeamLifecycleSource;
  teamId?: string;
  now?: Date;
  triggerImprovement?: (directive: ImprovementDirective) => Promise<ImprovementTriggerResult>;
}

export interface TeamLifecycleReviewResult {
  evaluated: number;
  unscored: number;
  insufficientSample: number;
  healthy: number;
  belowOrEqualTarget: number;
  improvementsStarted: number;
  improvementTriggerFailed: number;
  alreadyImproving: number;
  cooldown: number;
  probation: number;
  retiredPersistent: number;
  retiredImmediate: number;
  protectedFromRetirement: number;
}

export interface RetirementWatchlistResult {
  teamCandidates: number;
  organizationCandidates: number;
  added: number;
  refreshed: number;
  dismissed: number;
}

export interface WeeklyWorkforcePlanningResult {
  weekKey: string;
  alreadyCompleted: boolean;
  actionType?: 'team_created' | 'organization_created';
  subjectId?: string;
  subjectSlug?: string;
  basedOnGoalId?: string;
  performanceReportsReviewed: number;
  workReportsReviewed: number;
  watchlist: RetirementWatchlistResult;
}

interface BottleneckEvidence {
  immediate: boolean;
  teamFailures: number;
  organizationFailures: number;
  organizationFailureShare: number;
  reason: string;
}

let runningReview: Promise<TeamLifecycleReviewResult> | null = null;
let eventMonitorStop: (() => void) | null = null;

function mapProfile(row: LifecycleProfileRow): TeamLifecycleProfile {
  return {
    teamId: row.team_id,
    teamSlug: row.team_slug,
    teamName: row.team_name,
    organizationId: row.organization_id,
    status: row.status,
    improvementCount: row.improvement_count,
    successfulImprovementCount: row.successful_improvement_count,
    failedImprovementCount: row.failed_improvement_count,
    unresolvedImprovementCount: row.unresolved_improvement_count,
    consecutiveLowChecks: row.consecutive_low_checks,
    lastScore: row.last_score,
    lastSampleSize: row.last_sample_size,
    firstLowAt: row.first_low_at,
    lastCheckedAt: row.last_checked_at,
    lastImprovementAt: row.last_improvement_at,
    activeRunId: row.active_run_id,
    retiredAt: row.retired_at,
    retirementReason: row.retirement_reason,
    protected: row.protected === 1,
  };
}

export function listTeamLifecycleProfiles(
  database: Database.Database = getDb(),
): TeamLifecycleProfile[] {
  const rows = database.prepare(`
    SELECT
      p.team_id,
      t.slug AS team_slug,
      t.name AS team_name,
      t.organization_id,
      p.status,
      p.improvement_count,
      p.successful_improvement_count,
      p.failed_improvement_count,
      p.unresolved_improvement_count,
      p.consecutive_low_checks,
      p.last_score,
      p.last_sample_size,
      p.first_low_at,
      p.last_checked_at,
      p.last_improvement_at,
      p.active_run_id,
      p.retired_at,
      p.retirement_reason,
      p.protected
    FROM team_lifecycle_profiles p
    JOIN teams t ON t.id = p.team_id
    ORDER BY p.status DESC, p.last_score ASC, t.name ASC
  `).all() as LifecycleProfileRow[];
  return rows.map(mapProfile);
}

function readProfile(database: Database.Database, teamId: string): TeamLifecycleProfile {
  const row = database.prepare(`
    SELECT
      p.team_id,
      t.slug AS team_slug,
      t.name AS team_name,
      t.organization_id,
      p.status,
      p.improvement_count,
      p.successful_improvement_count,
      p.failed_improvement_count,
      p.unresolved_improvement_count,
      p.consecutive_low_checks,
      p.last_score,
      p.last_sample_size,
      p.first_low_at,
      p.last_checked_at,
      p.last_improvement_at,
      p.active_run_id,
      p.retired_at,
      p.retirement_reason,
      p.protected
    FROM team_lifecycle_profiles p
    JOIN teams t ON t.id = p.team_id
    WHERE p.team_id = ?
  `).get(teamId) as LifecycleProfileRow | undefined;
  if (!row) throw new Error(`team lifecycle profile not found: ${teamId}`);
  return mapProfile(row);
}

function ensureProfile(database: Database.Database, teamId: string): void {
  const team = database.prepare(`
    SELECT o.slug AS organization_slug
    FROM teams t
    LEFT JOIN organizations o ON o.id = t.organization_id
    WHERE t.id = ?
  `).get(teamId) as { organization_slug: string | null } | undefined;
  const protectedTeam = PROTECTED_TEAM_IDS.has(teamId) || team?.organization_slug === 'nco-self';
  database.prepare(`
    INSERT OR IGNORE INTO team_lifecycle_profiles (team_id, protected)
    VALUES (?, ?)
  `).run(teamId, protectedTeam ? 1 : 0);
  if (protectedTeam) {
    database.prepare(`
      UPDATE team_lifecycle_profiles SET protected = 1 WHERE team_id = ?
    `).run(teamId);
  }
}

function recordLifecycleEvent(
  database: Database.Database,
  input: {
    teamId: string;
    teamSlug: string;
    eventType:
      | 'score_checked'
      | 'score_recovered'
      | 'hr_directive'
      | 'improvement_started'
      | 'improvement_completed'
      | 'improvement_failed'
      | 'improvement_trigger_failed'
      | 'probation_started'
      | 'retired'
      | 'restored';
    score?: number;
    improvementCount?: number;
    reason?: string;
    companyRunId?: string;
    source: TeamLifecycleSource;
    metadata?: Record<string, unknown>;
  },
): void {
  database.prepare(`
    INSERT INTO team_lifecycle_events (
      id, team_id, team_slug, event_type, score, improvement_count,
      reason, company_run_id, source, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    createId('tle'),
    input.teamId,
    input.teamSlug,
    input.eventType,
    input.score ?? null,
    input.improvementCount ?? 0,
    input.reason ?? '',
    input.companyRunId ?? null,
    input.source,
    JSON.stringify(input.metadata ?? {}),
  );
}

function sampleTimePredicate(sample: TeamScore['sample'], alias: string): string {
  if (sample === '48h') return ` AND ${alias}.created_at >= datetime('now','-48 hours')`;
  if (sample === '7d') return ` AND ${alias}.created_at >= datetime('now','-7 days')`;
  return '';
}

function bottleneckEvidence(
  database: Database.Database,
  team: TeamScore,
): BottleneckEvidence {
  if (
    team.n < TEAM_LIFECYCLE_IMMEDIATE_MIN_SAMPLE
    || team.completion > TEAM_LIFECYCLE_IMMEDIATE_MAX_COMPLETION
    || !team.organizationId
  ) {
    return {
      immediate: false,
      teamFailures: 0,
      organizationFailures: 0,
      organizationFailureShare: 0,
      reason: 'critical bottleneck evidence threshold not met',
    };
  }

  const teamWindow = sampleTimePredicate(team.sample, 'k');
  const teamFailures = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM tasks k
    WHERE k.team_id = ?
      AND k.status IN ('failed', 'timed_out', 'lease_expired')
      ${teamWindow}
  `).get(team.teamId) as { count: number }).count;

  const organizationWindow = sampleTimePredicate(team.sample, 'k');
  const organizationFailures = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM tasks k
    JOIN teams t ON t.id = k.team_id
    WHERE t.organization_id = ?
      AND k.status IN ('failed', 'timed_out', 'lease_expired')
      ${organizationWindow}
  `).get(team.organizationId) as { count: number }).count;

  const organizationFailureShare = organizationFailures > 0
    ? teamFailures / organizationFailures
    : 0;
  const immediate = teamFailures >= TEAM_LIFECYCLE_IMMEDIATE_MIN_FAILURES
    && organizationFailureShare >= TEAM_LIFECYCLE_IMMEDIATE_ORG_FAILURE_SHARE;
  return {
    immediate,
    teamFailures,
    organizationFailures,
    organizationFailureShare,
    reason: immediate
      ? `company bottleneck: ${teamFailures}/${organizationFailures} failures `
        + `(${Math.round(organizationFailureShare * 100)}%), completion ${team.completion}%`
      : 'critical bottleneck evidence threshold not met',
  };
}

function hasActiveTeamTasks(database: Database.Database, teamId: string): boolean {
  const placeholders = [...ACTIVE_TASK_STATUSES].map(() => '?').join(', ');
  const row = database.prepare(`
    SELECT 1
    FROM tasks
    WHERE team_id = ?
      AND status IN (${placeholders})
    LIMIT 1
  `).get(teamId, ...ACTIVE_TASK_STATUSES);
  return Boolean(row);
}

function softRetireTeam(
  database: Database.Database,
  team: TeamScore,
  profile: TeamLifecycleProfile,
  reason: string,
  source: TeamLifecycleSource,
  immediate: boolean,
): void {
  const activeTasks = hasActiveTeamTasks(database, team.teamId);
  const finalReason = activeTasks
    ? `${reason}; existing in-flight tasks may drain, new lifecycle dispatch is blocked`
    : reason;
  const retire = database.transaction(() => {
    database.prepare(`
      UPDATE teams
      SET is_active = 0, is_always_on = 0, updated_at = datetime('now')
      WHERE id = ?
    `).run(team.teamId);
    database.prepare(`
      UPDATE team_lifecycle_profiles
      SET
        status = 'retired',
        active_run_id = NULL,
        retired_at = datetime('now'),
        retirement_reason = ?,
        updated_at = datetime('now')
      WHERE team_id = ?
    `).run(finalReason, team.teamId);
    recordLifecycleEvent(database, {
      teamId: team.teamId,
      teamSlug: team.slug,
      eventType: 'retired',
      score: team.score,
      improvementCount: profile.improvementCount,
      reason: finalReason,
      source,
      metadata: { immediate, activeTasks },
    });
  });
  retire();
  void eventBus.publish({
    type: 'team:retired',
    teamId: team.teamId,
    teamSlug: team.slug,
    score: team.score,
    reason: finalReason,
    immediate,
  });
}

function runStatusFromPersistedTasks(
  database: Database.Database,
  runId: string,
): 'active' | 'completed' | 'failed' | 'unknown' {
  const rows = database.prepare(`
    SELECT status
    FROM tasks
    WHERE metadata_json IS NOT NULL
      AND json_valid(metadata_json)
      AND json_extract(metadata_json, '$.companyRunId') = ?
  `).all(runId) as Array<{ status: string }>;
  if (rows.length === 0) return 'unknown';
  if (rows.some(row => ACTIVE_TASK_STATUSES.has(row.status))) return 'active';
  if (rows.some(row => row.status === 'completed')) return 'completed';
  return 'failed';
}

function reconcileImprovementRun(
  database: Database.Database,
  team: TeamScore,
  profile: TeamLifecycleProfile,
  source: TeamLifecycleSource,
  now: Date,
): void {
  if (!profile.activeRunId) return;

  const inMemoryRun = getCompanyRun(profile.activeRunId);
  let outcome: 'active' | 'completed' | 'failed' | 'unknown';
  if (inMemoryRun && !TERMINAL_COMPANY_STATUSES.has(inMemoryRun.status)) {
    outcome = 'active';
  } else if (inMemoryRun?.status === 'completed') {
    outcome = 'completed';
  } else if (inMemoryRun && TERMINAL_COMPANY_STATUSES.has(inMemoryRun.status)) {
    outcome = 'failed';
  } else {
    outcome = runStatusFromPersistedTasks(database, profile.activeRunId);
  }
  if (outcome === 'active') return;

  if (outcome === 'unknown') {
    const startedAt = profile.lastImprovementAt ? Date.parse(profile.lastImprovementAt) : Number.NaN;
    if (Number.isFinite(startedAt) && now.getTime() - startedAt < 30 * 60 * 1000) return;
    outcome = 'failed';
  }

  const hasActionableSample = team.n >= TEAM_SCORE_MIN_ACTIONABLE_SAMPLE;
  const remainsLow = hasActionableSample && team.score < TEAM_SCORE_TARGET;
  const changes = database.prepare(`
    UPDATE team_lifecycle_profiles
    SET
      active_run_id = NULL,
      successful_improvement_count = successful_improvement_count + ?,
      failed_improvement_count = failed_improvement_count + ?,
      unresolved_improvement_count = unresolved_improvement_count + ?,
      status = CASE WHEN improvement_count >= 2 THEN 'probation' ELSE 'improving' END,
      updated_at = datetime('now')
    WHERE team_id = ? AND active_run_id = ?
  `).run(
    outcome === 'completed' ? 1 : 0,
    outcome === 'failed' ? 1 : 0,
    remainsLow ? 1 : 0,
    team.teamId,
    profile.activeRunId,
  ).changes;
  if (changes === 0) return;

  recordLifecycleEvent(database, {
    teamId: team.teamId,
    teamSlug: team.slug,
    eventType: outcome === 'completed' ? 'improvement_completed' : 'improvement_failed',
    score: team.score,
    improvementCount: profile.improvementCount,
    companyRunId: profile.activeRunId,
    reason: !hasActionableSample
      ? `improvement run ${outcome}; score evaluation deferred with sample `
        + `${team.n}/${TEAM_SCORE_MIN_ACTIONABLE_SAMPLE}`
      : remainsLow
        ? `improvement run ${outcome}, but score remains ${team.score}`
        : `improvement run ${outcome}; score recovered to ${team.score}`,
    source,
  });
}

function buildImprovementGoal(
  team: TeamScore,
  profile: TeamLifecycleProfile,
): string {
  return [
    `[HR DIRECTIVE] Improve team ${team.name} (${team.slug}, ${team.teamId}).`,
    `Current score=${team.score}, completion=${team.completion}%, sample=${team.sample}/${team.n}.`,
    `Improvement cycle=${profile.improvementCount + 1}/${TEAM_LIFECYCLE_MAX_IMPROVEMENTS}.`,
    'Use actual NCO task evidence to identify the root cause and implement a bounded, reversible fix.',
    'Run relevant tests/build, record evidence, and do not fabricate metrics.',
    'Do not delete or deactivate teams. HR alone owns lifecycle status and retirement decisions.',
  ].join(' ');
}

async function triggerSelfImprovementCompany(
  directive: ImprovementDirective,
): Promise<ImprovementTriggerResult> {
  const apiUrl = process.env.NCO_API_URL || 'http://127.0.0.1:6200';
  const token = process.env.NCO_API_TOKEN?.trim();
  try {
    const response = await fetch(`${apiUrl}/api/organizations/nco-self/orchestrate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        goal: directive.goal,
        mode: 'pipeline',
        dryRun: false,
        projectDir: resolveTaskProjectDir({
          teamId: directive.team.teamId,
          organizationId: directive.team.organizationId,
          requestedProjectDir: resolveInternalProjectDir(),
        }),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json() as { run?: { id?: string }; error?: string };
    const runId = body.run?.id;
    if (!response.ok || !runId) {
      return {
        ok: false,
        error: body.error ?? `nco-self orchestration returned HTTP ${response.status}`,
      };
    }
    return { ok: true, runId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function initialReviewResult(): TeamLifecycleReviewResult {
  return {
    evaluated: 0,
    unscored: 0,
    insufficientSample: 0,
    healthy: 0,
    belowOrEqualTarget: 0,
    improvementsStarted: 0,
    improvementTriggerFailed: 0,
    alreadyImproving: 0,
    cooldown: 0,
    probation: 0,
    retiredPersistent: 0,
    retiredImmediate: 0,
    protectedFromRetirement: 0,
  };
}

async function executeTeamLifecycleReview(
  options: TeamLifecycleReviewOptions,
): Promise<TeamLifecycleReviewResult> {
  const database = options.database ?? getDb();
  const source = options.source ?? 'scheduled';
  const now = options.now ?? new Date();
  const triggerImprovement = options.triggerImprovement ?? triggerSelfImprovementCompany;
  const allScores = options.scores ?? computeTeamScores(database);
  const scores = (options.teamId
    ? allScores.filter(team => team.teamId === options.teamId)
    : allScores)
    .sort((left, right) => left.score - right.score || left.teamId.localeCompare(right.teamId));
  const result = initialReviewResult();
  let activeImprovementRuns = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM team_lifecycle_profiles
    WHERE active_run_id IS NOT NULL
  `).get() as { count: number }).count;

  for (const team of scores) {
    result.evaluated += 1;
    ensureProfile(database, team.teamId);
    let profile = readProfile(database, team.teamId);
    if (profile.status === 'retired') continue;

    const hadActiveRun = Boolean(profile.activeRunId);
    reconcileImprovementRun(database, team, profile, source, now);
    profile = readProfile(database, team.teamId);
    if (hadActiveRun && !profile.activeRunId) {
      activeImprovementRuns = Math.max(0, activeImprovementRuns - 1);
    }

    if (team.n === 0) {
      result.unscored += 1;
      database.prepare(`
        UPDATE team_lifecycle_profiles
        SET last_score = ?, last_sample_size = 0, last_checked_at = ?, updated_at = datetime('now')
        WHERE team_id = ?
      `).run(team.score, now.toISOString(), team.teamId);
      recordLifecycleEvent(database, {
        teamId: team.teamId,
        teamSlug: team.slug,
        eventType: 'score_checked',
        score: team.score,
        improvementCount: profile.improvementCount,
        reason: 'no terminal task sample; lifecycle action deferred',
        source,
        metadata: { sample: team.sample, n: team.n, maxN: team.maxN },
      });
      continue;
    }

    if (team.n < TEAM_SCORE_MIN_ACTIONABLE_SAMPLE) {
      result.insufficientSample += 1;
      database.prepare(`
        UPDATE team_lifecycle_profiles
        SET last_score = ?, last_sample_size = ?, last_checked_at = ?, updated_at = datetime('now')
        WHERE team_id = ?
      `).run(team.score, team.n, now.toISOString(), team.teamId);
      recordLifecycleEvent(database, {
        teamId: team.teamId,
        teamSlug: team.slug,
        eventType: 'score_checked',
        score: team.score,
        improvementCount: profile.improvementCount,
        reason: `terminal task sample ${team.n} is below minimum `
          + `${TEAM_SCORE_MIN_ACTIONABLE_SAMPLE}; lifecycle action deferred`,
        source,
        metadata: { sample: team.sample, n: team.n, maxN: team.maxN },
      });
      continue;
    }

    if (team.score >= TEAM_SCORE_TARGET) {
      result.healthy += 1;
      const recovered = profile.consecutiveLowChecks > 0 || profile.status !== 'active';
      database.prepare(`
        UPDATE team_lifecycle_profiles
        SET
          status = 'active',
          consecutive_low_checks = 0,
          unresolved_improvement_count = 0,
          first_low_at = NULL,
          active_run_id = NULL,
          last_score = ?,
          last_sample_size = ?,
          last_checked_at = ?,
          retirement_reason = NULL,
          retired_at = NULL,
          updated_at = datetime('now')
        WHERE team_id = ?
      `).run(team.score, team.n, now.toISOString(), team.teamId);
      recordLifecycleEvent(database, {
        teamId: team.teamId,
        teamSlug: team.slug,
        eventType: recovered ? 'score_recovered' : 'score_checked',
        score: team.score,
        improvementCount: profile.improvementCount,
        reason: `score ${team.score} is above HR target ${TEAM_SCORE_TARGET}`,
        source,
        metadata: { sample: team.sample, n: team.n, maxN: team.maxN },
      });
      continue;
    }

    result.belowOrEqualTarget += 1;
    database.prepare(`
      UPDATE team_lifecycle_profiles
      SET
        consecutive_low_checks = consecutive_low_checks + 1,
        first_low_at = COALESCE(first_low_at, ?),
        last_score = ?,
        last_sample_size = ?,
        last_checked_at = ?,
        status = CASE
          WHEN improvement_count >= 2 OR unresolved_improvement_count >= 1 THEN 'probation'
          WHEN active_run_id IS NOT NULL OR improvement_count >= 1 THEN 'improving'
          ELSE 'active'
        END,
        updated_at = datetime('now')
      WHERE team_id = ?
    `).run(now.toISOString(), team.score, team.n, now.toISOString(), team.teamId);
    profile = readProfile(database, team.teamId);

    recordLifecycleEvent(database, {
      teamId: team.teamId,
      teamSlug: team.slug,
      eventType: 'score_checked',
      score: team.score,
      improvementCount: profile.improvementCount,
      reason: `score ${team.score} is below HR target ${TEAM_SCORE_TARGET}`,
      source,
      metadata: {
        sample: team.sample,
        n: team.n,
        maxN: team.maxN,
        completion: team.completion,
        consecutiveLowChecks: profile.consecutiveLowChecks,
      },
    });

    if (team.organizationId === 'org_nco-self') {
      database.prepare(`
        UPDATE team_lifecycle_profiles
        SET
          status = 'active',
          active_run_id = NULL,
          updated_at = datetime('now')
        WHERE team_id = ?
      `).run(team.teamId);
      result.protectedFromRetirement += 1;
      continue;
    }

    const bottleneck = bottleneckEvidence(database, team);
    if (bottleneck.immediate) {
      if (profile.protected) {
        result.protectedFromRetirement += 1;
      } else {
        softRetireTeam(database, team, profile, bottleneck.reason, source, true);
        result.retiredImmediate += 1;
        continue;
      }
    }

    if (
      profile.unresolvedImprovementCount >= TEAM_LIFECYCLE_MAX_IMPROVEMENTS
      && !profile.activeRunId
    ) {
      if (profile.protected) {
        result.protectedFromRetirement += 1;
        continue;
      } else {
        softRetireTeam(
          database,
          team,
          profile,
          `${profile.unresolvedImprovementCount} completed improvement cycles did not raise `
            + `the score above ${TEAM_SCORE_TARGET}`,
          source,
          false,
        );
        result.retiredPersistent += 1;
        continue;
      }
    }

    if (profile.status === 'probation') result.probation += 1;
    if (profile.activeRunId) {
      result.alreadyImproving += 1;
      continue;
    }
    if (
      result.improvementsStarted >= TEAM_LIFECYCLE_MAX_PER_REVIEW
      || activeImprovementRuns + result.improvementsStarted >= TEAM_LIFECYCLE_MAX_PER_REVIEW
    ) continue;

    const lastImprovementAt = profile.lastImprovementAt
      ? Date.parse(profile.lastImprovementAt)
      : Number.NaN;
    if (
      Number.isFinite(lastImprovementAt)
      && now.getTime() - lastImprovementAt < TEAM_LIFECYCLE_COOLDOWN_MS
    ) {
      result.cooldown += 1;
      continue;
    }

    const goal = buildImprovementGoal(team, profile);
    recordLifecycleEvent(database, {
      teamId: team.teamId,
      teamSlug: team.slug,
      eventType: 'hr_directive',
      score: team.score,
      improvementCount: profile.improvementCount + 1,
      reason: goal,
      source,
      metadata: { organization: 'nco-self' },
    });
    const triggered = await triggerImprovement({
      team,
      improvementCount: profile.improvementCount + 1,
      consecutiveLowChecks: profile.consecutiveLowChecks,
      unresolvedImprovementCount: profile.unresolvedImprovementCount,
      source,
      goal,
    });
    if (!triggered.ok || !triggered.runId) {
      result.improvementTriggerFailed += 1;
      recordLifecycleEvent(database, {
        teamId: team.teamId,
        teamSlug: team.slug,
        eventType: 'improvement_trigger_failed',
        score: team.score,
        improvementCount: profile.improvementCount,
        reason: triggered.error ?? 'nco-self orchestration did not return a run id',
        source,
      });
      continue;
    }

    database.prepare(`
      UPDATE team_lifecycle_profiles
      SET
        improvement_count = improvement_count + 1,
        status = CASE WHEN improvement_count + 1 >= 2 THEN 'probation' ELSE 'improving' END,
        last_improvement_at = ?,
        active_run_id = ?,
        updated_at = datetime('now')
      WHERE team_id = ?
    `).run(now.toISOString(), triggered.runId, team.teamId);
    result.improvementsStarted += 1;
    recordLifecycleEvent(database, {
      teamId: team.teamId,
      teamSlug: team.slug,
      eventType: 'improvement_started',
      score: team.score,
      improvementCount: profile.improvementCount + 1,
      reason: 'HR directive accepted by nco-self improvement company',
      companyRunId: triggered.runId,
      source,
    });
  }

  return result;
}

export function runTeamLifecycleReview(
  options: TeamLifecycleReviewOptions = {},
): Promise<TeamLifecycleReviewResult> {
  if (runningReview) return runningReview;
  runningReview = executeTeamLifecycleReview(options)
    .finally(() => {
      runningReview = null;
    });
  return runningReview;
}

export function restoreRetiredTeam(
  teamId: string,
  reason: string,
  database: Database.Database = getDb(),
): TeamLifecycleProfile {
  const team = database.prepare(`
    SELECT id, slug FROM teams WHERE id = ?
  `).get(teamId) as { id: string; slug: string } | undefined;
  if (!team) throw new Error(`team not found: ${teamId}`);
  ensureProfile(database, teamId);
  const restore = database.transaction(() => {
    database.prepare(`
      UPDATE teams
      SET is_active = 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(teamId);
    database.prepare(`
      UPDATE team_lifecycle_profiles
      SET
        status = 'active',
        consecutive_low_checks = 0,
        unresolved_improvement_count = 0,
        active_run_id = NULL,
        first_low_at = NULL,
        retired_at = NULL,
        retirement_reason = NULL,
        updated_at = datetime('now')
      WHERE team_id = ?
    `).run(teamId);
    const profile = readProfile(database, teamId);
    recordLifecycleEvent(database, {
      teamId,
      teamSlug: team.slug,
      eventType: 'restored',
      score: profile.lastScore ?? undefined,
      improvementCount: profile.improvementCount,
      reason,
      source: 'manual',
    });
  });
  restore();
  void eventBus.publish({ type: 'team:restored', teamId, teamSlug: team.slug, reason });
  return readProfile(database, teamId);
}

function isoWeekKey(date: Date): string {
  const value = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((value.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function refreshRetirementWatchlist(
  database: Database.Database = getDb(),
  now: Date = new Date(),
): RetirementWatchlistResult {
  const nowIso = now.toISOString();
  const teamCandidates = database.prepare(`
    SELECT
      t.id,
      t.slug,
      COUNT(k.id) AS recent_tasks,
      MAX(k.created_at) AS last_task_at
    FROM teams t
    LEFT JOIN tasks k
      ON k.team_id = t.id
      AND k.created_at >= datetime(?, '-30 days')
    WHERE t.is_active = 1
      AND t.id NOT IN ('team_hr-director', 'team_self-improvement')
      AND t.created_at <= datetime(?, '-14 days')
    GROUP BY t.id, t.slug
    HAVING COUNT(k.id) < 2
  `).all(nowIso, nowIso) as Array<{
    id: string;
    slug: string;
    recent_tasks: number;
    last_task_at: string | null;
  }>;
  const organizationCandidates = database.prepare(`
    SELECT
      o.id,
      o.slug,
      COUNT(k.id) AS recent_tasks,
      MAX(k.created_at) AS last_task_at
    FROM organizations o
    LEFT JOIN teams t ON t.organization_id = o.id
    LEFT JOIN tasks k
      ON k.team_id = t.id
      AND k.created_at >= datetime(?, '-30 days')
    WHERE o.is_active = 1
      AND o.id NOT IN ('org_nova-ax', 'org_nco-self')
      AND o.created_at <= datetime(?, '-30 days')
    GROUP BY o.id, o.slug
    HAVING COUNT(k.id) < 2
  `).all(nowIso, nowIso) as Array<{
    id: string;
    slug: string;
    recent_tasks: number;
    last_task_at: string | null;
  }>;

  const activeKeys = new Set<string>();
  let added = 0;
  let refreshed = 0;
  const upsertCandidate = (
    subjectKind: 'organization' | 'team',
    candidate: { id: string; slug: string; recent_tasks: number; last_task_at: string | null },
  ): void => {
    activeKeys.add(`${subjectKind}:${candidate.id}`);
    const existing = database.prepare(`
      SELECT id
      FROM hr_retirement_watchlist
      WHERE subject_kind = ? AND subject_id = ? AND status = 'watchlisted'
    `).get(subjectKind, candidate.id) as { id: string } | undefined;
    const reason = `${candidate.recent_tasks} tasks in the last 30 days; minimum active-use threshold is 2`;
    const evidence = JSON.stringify({
      recentTasks: candidate.recent_tasks,
      lastTaskAt: candidate.last_task_at,
      windowDays: 30,
      threshold: 2,
    });
    if (existing) {
      database.prepare(`
        UPDATE hr_retirement_watchlist
        SET reason = ?, evidence_json = ?, last_seen_at = ?
        WHERE id = ?
      `).run(reason, evidence, nowIso, existing.id);
      refreshed += 1;
      return;
    }
    database.prepare(`
      INSERT INTO hr_retirement_watchlist (
        id, subject_kind, subject_id, subject_slug, reason,
        evidence_json, status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'watchlisted', ?, ?)
    `).run(
      createId('hrwl'),
      subjectKind,
      candidate.id,
      candidate.slug,
      reason,
      evidence,
      nowIso,
      nowIso,
    );
    added += 1;
  };

  for (const candidate of teamCandidates) upsertCandidate('team', candidate);
  for (const candidate of organizationCandidates) upsertCandidate('organization', candidate);

  const openRows = database.prepare(`
    SELECT id, subject_kind, subject_id
    FROM hr_retirement_watchlist
    WHERE status = 'watchlisted'
  `).all() as Array<{ id: string; subject_kind: 'organization' | 'team'; subject_id: string }>;
  let dismissed = 0;
  for (const row of openRows) {
    if (activeKeys.has(`${row.subject_kind}:${row.subject_id}`)) continue;
    database.prepare(`
      UPDATE hr_retirement_watchlist
      SET
        status = 'dismissed',
        reason = reason || '; removed automatically after activity recovered',
        reviewed_at = ?,
        reviewed_by = 'hr-lifecycle-policy'
      WHERE id = ?
    `).run(nowIso, row.id);
    dismissed += 1;
  }

  return {
    teamCandidates: teamCandidates.length,
    organizationCandidates: organizationCandidates.length,
    added,
    refreshed,
    dismissed,
  };
}

interface WeeklyGoalRow {
  id: string;
  subject_kind: 'organization' | 'team';
  subject_id: string;
  title: string;
  target_value: number | null;
  current_value: number;
  direction: 'increase' | 'decrease';
  status: string;
}

function goalAttainment(goal: WeeklyGoalRow): number {
  if (goal.status === 'missed') return -1;
  if (goal.direction === 'decrease') {
    if (goal.target_value == null) return goal.current_value <= 0 ? 100 : 0;
    if (goal.current_value <= goal.target_value) return 100;
    if (goal.target_value <= 0) return goal.current_value <= 0 ? 100 : 0;
    return Math.max(0, Math.min(100, (goal.target_value / goal.current_value) * 100));
  }
  if (goal.target_value == null || goal.target_value === 0) {
    return goal.current_value > 0 ? 100 : 0;
  }
  return Math.max(0, Math.min(100, (goal.current_value / goal.target_value) * 100));
}

function resolveGoalOrganization(
  database: Database.Database,
  goal: WeeklyGoalRow | undefined,
): string {
  if (!goal) return 'org_nova-ax';
  if (goal.subject_kind === 'organization') {
    const organization = database.prepare(`
      SELECT id FROM organizations WHERE id = ? AND is_active = 1
    `).get(goal.subject_id) as { id: string } | undefined;
    return organization?.id ?? 'org_nova-ax';
  }
  const team = database.prepare(`
    SELECT organization_id FROM teams WHERE id = ? AND is_active = 1
  `).get(goal.subject_id) as { organization_id: string | null } | undefined;
  return team?.organization_id ?? 'org_nova-ax';
}

export async function runWeeklyWorkforcePlanning(
  database: Database.Database = getDb(),
  now: Date = new Date(),
): Promise<WeeklyWorkforcePlanningResult> {
  const weekKey = isoWeekKey(now);
  const watchlist = refreshRetirementWatchlist(database, now);
  const performanceReportsReviewed = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM performance_reports
    WHERE created_at >= datetime(?, '-7 days')
  `).get(now.toISOString()) as { count: number }).count;
  const workReportsReviewed = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM work_reports
    WHERE created_at >= datetime(?, '-7 days')
      AND report_kind IN ('work', 'performance', 'goal')
  `).get(now.toISOString()) as { count: number }).count;

  const existing = database.prepare(`
    SELECT action_type, subject_id, subject_slug, based_on_goal_id
    FROM hr_weekly_org_actions
    WHERE week_key = ?
  `).get(weekKey) as {
    action_type: 'team_created' | 'organization_created';
    subject_id: string;
    subject_slug: string;
    based_on_goal_id: string | null;
  } | undefined;
  if (existing) {
    return {
      weekKey,
      alreadyCompleted: true,
      actionType: existing.action_type,
      subjectId: existing.subject_id,
      subjectSlug: existing.subject_slug,
      ...(existing.based_on_goal_id ? { basedOnGoalId: existing.based_on_goal_id } : {}),
      performanceReportsReviewed,
      workReportsReviewed,
      watchlist,
    };
  }

  const goals = database.prepare(`
    SELECT
      id, subject_kind, subject_id, title, target_value,
      current_value, direction, status
    FROM team_goals
    WHERE status IN ('active', 'missed')
    ORDER BY updated_at DESC, created_at DESC
  `).all() as WeeklyGoalRow[];
  const goal = goals
    .map(row => ({ row, attainment: goalAttainment(row) }))
    .sort((left, right) => left.attainment - right.attainment || left.row.id.localeCompare(right.row.id))[0]?.row;
  const organizationId = resolveGoalOrganization(database, goal);
  const slug = `hr-incubator-${weekKey.toLowerCase()}`;
  const teamId = `team_${slug}`;
  const goalTitle = goal?.title?.trim() || 'organization-wide capability gap identified by HR';
  const charter = [
    `HR weekly incubation team for ${weekKey}.`,
    `Evidence basis: ${goalTitle}.`,
    'Validate the need with actual performance reports and goal data, deliver a bounded improvement,',
    'and produce evidence for promotion or retirement. This team is reactive and subject to the normal lifecycle policy.',
  ].join(' ').slice(0, 2_000);

  const create = database.transaction(() => {
    database.prepare(`
      INSERT INTO teams (
        id, organization_id, name, slug, description, color,
        lead, charter, is_always_on, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, 'hermes', ?, 0, 1)
    `).run(
      teamId,
      organizationId,
      `HR Incubator ${weekKey}`,
      slug,
      `Weekly HR-created incubation team based on goals and performance evidence for ${weekKey}`,
      '#8b5cf6',
      charter,
    );
    database.prepare(`
      INSERT INTO team_members (id, team_id, member_type, member_ref)
      VALUES (?, ?, 'provider', 'hermes')
    `).run(`tm_${slug}_hermes`, teamId);
    database.prepare(`
      INSERT INTO team_lifecycle_profiles (team_id)
      VALUES (?)
    `).run(teamId);
    database.prepare(`
      INSERT INTO hr_weekly_org_actions (
        id, week_key, action_type, subject_id, subject_slug,
        based_on_goal_id, performance_reports_reviewed,
        work_reports_reviewed, evidence_json
      ) VALUES (?, ?, 'team_created', ?, ?, ?, ?, ?, ?)
    `).run(
      createId('hrwa'),
      weekKey,
      teamId,
      slug,
      goal?.id ?? null,
      performanceReportsReviewed,
      workReportsReviewed,
      JSON.stringify({
        goalTitle,
        organizationId,
        goalAttainment: goal ? goalAttainment(goal) : null,
        watchlist,
      }),
    );
  });
  create();
  await eventBus.publish({
    type: 'team:created',
    teamId,
    organizationId,
    source: 'hr-weekly-workforce-planning',
    weekKey,
    basedOnGoalId: goal?.id,
  });

  return {
    weekKey,
    alreadyCompleted: false,
    actionType: 'team_created',
    subjectId: teamId,
    subjectSlug: slug,
    ...(goal ? { basedOnGoalId: goal.id } : {}),
    performanceReportsReviewed,
    workReportsReviewed,
    watchlist,
  };
}

export function startTeamLifecycleEventMonitor(
  database: Database.Database = getDb(),
): () => void {
  if (eventMonitorStop) return eventMonitorStop;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const handler = (event: NCOEvent): void => {
    if (typeof event.taskId !== 'string') return;
    const row = database.prepare(`
      SELECT k.team_id, o.slug AS organization_slug
      FROM tasks k
      LEFT JOIN teams t ON t.id = k.team_id
      LEFT JOIN organizations o ON o.id = t.organization_id
      WHERE k.id = ?
    `).get(event.taskId) as {
      team_id: string | null;
      organization_slug: string | null;
    } | undefined;
    const teamId = row?.team_id;
    if (!teamId || row?.organization_slug === 'nco-self') return;
    const existing = timers.get(teamId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(teamId);
      void runTeamLifecycleReview({ database, source: 'event', teamId }).catch(error => {
        log.error(
          { teamId, err: error instanceof Error ? error.message : String(error) },
          'Event-triggered HR lifecycle review failed',
        );
      });
    }, 1_000);
    timers.set(teamId, timer);
  };
  eventBus.on('task:completed', handler);
  eventBus.on('task:failed', handler);
  eventMonitorStop = () => {
    eventBus.off('task:completed', handler);
    eventBus.off('task:failed', handler);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    eventMonitorStop = null;
  };
  return eventMonitorStop;
}
