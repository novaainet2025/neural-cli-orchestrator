import type Database from 'better-sqlite3';
import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('workflow-gate');

export const WORKFLOW_STAGES = [
  'discussion',
  'design',
  'implementation',
  'review',
  'verification',
] as const;

export type WorkflowStage = typeof WORKFLOW_STAGES[number];
export type WorkflowStageStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';
export type WorkflowPolicy = 'required' | 'routine' | 'explicit';

const TERMINAL_STAGE_STATUSES = new Set<WorkflowStageStatus>([
  'completed',
  'failed',
  'skipped',
  'cancelled',
]);
const ROUTINE_PATTERN =
  /^\s*\[(?:업무보고 작성|성과보고·목표설정 입력 지시)\]|업무보고|daily report|heartbeat|health check|상태\s*확인|단순\s*반복/i;
const HIGH_RISK_PATTERN =
  /신규\s*기능|new\s*feature|아키텍처|architecture|schema|migration|마이그레이션|배포|deploy|release|보안|security|권한|permission|데이터\s*(?:삭제|이관)|destructive|high[- ]?risk|고위험|회귀|regression/i;
const CODE_CHANGE_PATTERN =
  /구현|수정|버그|리팩터|코드|implement|fix|bug|patch|refactor|code|build/i;

export interface WorkflowPolicyDecision {
  scoped: boolean;
  policy: WorkflowPolicy;
  required: boolean;
  requireReview: boolean;
  requireVerification: boolean;
  complexity: number;
  reason: string;
}

export interface CreateWorkflowRunInput {
  prompt: string;
  teamId?: string | null;
  teamIds?: Array<string | null>;
  companyRunId?: string | null;
  rootTaskId?: string | null;
  source?: string;
  metadata?: Record<string, unknown>;
  decision?: WorkflowPolicyDecision;
}

export interface WorkflowGateResult {
  allowed: boolean;
  workflowRunId?: string;
  workflowStage?: WorkflowStage;
  error?: 'workflow_prerequisites_required' | 'workflow_run_not_found' | 'workflow_context_mismatch';
  requiredStage?: WorkflowStage;
  detail?: string;
}

interface StageRow {
  id: string;
  stage: WorkflowStage;
  status: WorkflowStageStatus;
  required: number;
}

export function isWorkflowGateEnabled(): boolean {
  return !['0', 'false', 'off', 'disabled'].includes(
    String(process.env.NCO_WORKFLOW_GATE ?? 'on').toLowerCase(),
  );
}

function normalizedMetadata(metadata?: Record<string, unknown>): Record<string, unknown> {
  return metadata ?? {};
}

export function evaluateWorkflowPolicy(
  prompt: string,
  metadata?: Record<string, unknown>,
): WorkflowPolicyDecision {
  const meta = normalizedMetadata(metadata);
  const teamId = typeof meta.teamId === 'string' && meta.teamId.trim() ? meta.teamId.trim() : null;
  const companyRunId = typeof meta.companyRunId === 'string' && meta.companyRunId.trim()
    ? meta.companyRunId.trim()
    : null;
  const explicitRequired = meta.workflowRequired === true || meta.workflowPolicy === 'required';
  const explicitRoutine = meta.workflowIntent === 'routine' || meta.workflowPolicy === 'routine';
  const scoped = Boolean(teamId || companyRunId || explicitRequired || meta.workflowRunId);
  const routine = explicitRoutine
    || typeof meta.workReportId === 'string'
    || ROUTINE_PATTERN.test(prompt);
  const highRisk = HIGH_RISK_PATTERN.test(prompt);
  const codeChange = CODE_CHANGE_PATTERN.test(prompt);
  const required = scoped && (explicitRequired || !routine);
  const complexity = highRisk ? 8 : codeChange ? 6 : required ? 5 : routine ? 1 : 0;

  return {
    scoped,
    policy: explicitRequired ? 'explicit' : required ? 'required' : 'routine',
    required,
    requireReview: required && (highRisk || codeChange),
    requireVerification: required && (highRisk || codeChange),
    complexity,
    reason: explicitRequired
      ? 'metadata.workflowRequired'
      : routine
        ? 'routine_or_report'
        : highRisk
          ? 'high_risk_or_architecture'
          : required
            ? 'team_or_company_non_routine'
            : 'outside_team_workflow_scope',
  };
}

function stagePolicy(
  stage: WorkflowStage,
  decision: WorkflowPolicyDecision,
): { required: boolean; status: WorkflowStageStatus; skipReason: string | null } {
  if (stage === 'implementation') return { required: true, status: 'pending', skipReason: null };
  const required = decision.required && (
    stage === 'discussion'
    || stage === 'design'
    || (stage === 'review' && decision.requireReview)
    || (stage === 'verification' && decision.requireVerification)
  );
  if (required) return { required: true, status: 'pending', skipReason: null };
  return {
    required: false,
    status: 'skipped',
    skipReason: decision.required ? 'policy_not_required' : decision.reason,
  };
}

export function createWorkflowRun(
  input: CreateWorkflowRunInput,
  database: Database.Database = getDb(),
): string {
  const decision = input.decision ?? evaluateWorkflowPolicy(input.prompt, input.metadata);
  const runId = createId('wfr');
  const teamIds = [...new Set(
    (input.teamIds?.length ? input.teamIds : [input.teamId ?? null])
      .map(teamId => typeof teamId === 'string' && teamId.trim() ? teamId.trim() : null),
  )];
  const primaryTeamId = teamIds.length === 1 ? teamIds[0] : null;

  database.transaction(() => {
    database.prepare(`
      INSERT INTO workflow_runs (
        id, root_task_id, team_id, company_run_id, source, policy, status,
        prompt, complexity, policy_reason, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(
      runId,
      input.rootTaskId ?? null,
      primaryTeamId,
      input.companyRunId ?? null,
      input.source ?? 'task-intake',
      decision.policy,
      input.prompt,
      decision.complexity,
      decision.reason,
      JSON.stringify(input.metadata ?? {}),
    );

    const insertStage = database.prepare(`
      INSERT INTO workflow_stages (
        id, workflow_run_id, team_id, stage, ordinal, status, required,
        skip_reason, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ?='skipped' THEN datetime('now') END)
    `);
    for (const teamId of teamIds) {
      WORKFLOW_STAGES.forEach((stage, index) => {
        const policy = stagePolicy(stage, decision);
        insertStage.run(
          createId('wfs'),
          runId,
          teamId,
          stage,
          index + 1,
          policy.status,
          policy.required ? 1 : 0,
          policy.skipReason,
          policy.status,
        );
      });
    }
  }).immediate();

  return runId;
}

function selectStages(
  workflowRunId: string,
  teamId: string | null | undefined,
  database: Database.Database,
): StageRow[] {
  if (teamId) {
    return database.prepare(`
      SELECT id, stage, status, required
      FROM workflow_stages
      WHERE workflow_run_id=? AND team_id=?
      ORDER BY ordinal
    `).all(workflowRunId, teamId) as StageRow[];
  }
  return database.prepare(`
    SELECT id, stage, status, required
    FROM workflow_stages
    WHERE workflow_run_id=? AND team_id IS NULL
    ORDER BY ordinal
  `).all(workflowRunId) as StageRow[];
}

export function enforceWorkflowPrerequisites(
  metadata: Record<string, unknown> | undefined,
  mode: string,
  prompt: string,
  database: Database.Database = getDb(),
): WorkflowGateResult {
  if (!isWorkflowGateEnabled()) return { allowed: true };
  const decision = evaluateWorkflowPolicy(prompt, metadata);
  if (!decision.scoped || mode !== 'task') return { allowed: true };

  const workflowRunId = typeof metadata?.workflowRunId === 'string'
    ? metadata.workflowRunId.trim()
    : '';
  const workflowStage = (
    typeof metadata?.workflowStage === 'string'
    && WORKFLOW_STAGES.includes(metadata.workflowStage as WorkflowStage)
      ? metadata.workflowStage
      : 'implementation'
  ) as WorkflowStage;
  if (!workflowRunId) {
    return decision.required
      ? {
        allowed: false,
        error: 'workflow_prerequisites_required',
        requiredStage: 'discussion',
        detail: 'Run the task through /api/conductor or provide a prepared workflowRunId.',
      }
      : { allowed: true, workflowStage };
  }

  const run = database.prepare('SELECT id FROM workflow_runs WHERE id=?')
    .get(workflowRunId) as { id: string } | undefined;
  if (!run) {
    return { allowed: false, error: 'workflow_run_not_found', workflowRunId, workflowStage };
  }
  const teamId = typeof metadata?.teamId === 'string' && metadata.teamId.trim()
    ? metadata.teamId.trim()
    : null;
  const stages = selectStages(workflowRunId, teamId, database);
  if (stages.length === 0) {
    return {
      allowed: false,
      error: 'workflow_context_mismatch',
      workflowRunId,
      workflowStage,
      detail: teamId ? `workflow has no stages for team ${teamId}` : 'workflow has no unscoped stages',
    };
  }

  const prerequisites: WorkflowStage[] = workflowStage === 'discussion'
    ? []
    : workflowStage === 'design'
      ? ['discussion']
      : ['discussion', 'design'];
  for (const requiredStage of prerequisites) {
    const stage = stages.find(candidate => candidate.stage === requiredStage);
    if (!stage || (stage.required === 1 && stage.status !== 'completed')) {
      return {
        allowed: false,
        error: 'workflow_prerequisites_required',
        workflowRunId,
        workflowStage,
        requiredStage,
        detail: `${requiredStage} must be completed before ${workflowStage}`,
      };
    }
  }
  return { allowed: true, workflowRunId, workflowStage };
}

function refreshWorkflowRun(workflowRunId: string, database: Database.Database): void {
  const rows = database.prepare(`
    SELECT status, required FROM workflow_stages WHERE workflow_run_id=?
  `).all(workflowRunId) as Array<{ status: WorkflowStageStatus; required: number }>;
  const requiredRows = rows.filter(row => row.required === 1);
  const failed = requiredRows.some(row => row.status === 'failed');
  const cancelled = requiredRows.some(row => row.status === 'cancelled');
  const completed = requiredRows.length > 0 && requiredRows.every(row => row.status === 'completed');
  const running = rows.some(row => row.status === 'running')
    || requiredRows.some(row => row.status === 'completed');
  const status = failed
    ? 'failed'
    : cancelled
      ? 'cancelled'
      : completed
        ? 'completed'
        : running
          ? 'running'
          : 'pending';
  database.prepare(`
    UPDATE workflow_runs
    SET status=?, updated_at=datetime('now'),
        completed_at=CASE WHEN ? IN ('completed','failed','cancelled') THEN datetime('now') ELSE NULL END
    WHERE id=?
  `).run(status, status, workflowRunId);
}

export function markWorkflowStage(
  workflowRunId: string,
  stage: WorkflowStage,
  status: WorkflowStageStatus,
  options: {
    teamId?: string | null;
    taskId?: string | null;
    discussionId?: string | null;
    executor?: string | null;
    skipReason?: string | null;
    error?: string | null;
    evidence?: unknown;
  } = {},
  database: Database.Database = getDb(),
): number {
  const whereTeam = options.teamId === undefined
    ? ''
    : options.teamId === null
      ? ' AND team_id IS NULL'
      : ' AND team_id=@teamId';
  const result = database.prepare(`
    UPDATE workflow_stages
    SET status=@status,
        task_id=COALESCE(@taskId, task_id),
        discussion_id=COALESCE(@discussionId, discussion_id),
        executor=COALESCE(@executor, executor),
        skip_reason=COALESCE(@skipReason, skip_reason),
        error=@error,
        evidence_json=CASE WHEN @evidenceJson IS NULL THEN evidence_json ELSE @evidenceJson END,
        started_at=CASE WHEN @status='running' THEN COALESCE(started_at, datetime('now')) ELSE started_at END,
        completed_at=CASE WHEN @terminal=1 THEN datetime('now') ELSE completed_at END,
        updated_at=datetime('now')
    WHERE workflow_run_id=@workflowRunId AND stage=@stage${whereTeam}
  `).run({
    workflowRunId,
    stage,
    status,
    teamId: options.teamId ?? null,
    taskId: options.taskId ?? null,
    discussionId: options.discussionId ?? null,
    executor: options.executor ?? null,
    skipReason: options.skipReason ?? null,
    error: options.error ?? null,
    evidenceJson: options.evidence === undefined ? null : JSON.stringify(options.evidence),
    terminal: TERMINAL_STAGE_STATUSES.has(status) ? 1 : 0,
  });
  refreshWorkflowRun(workflowRunId, database);
  return result.changes;
}

export function attachWorkflowTask(
  taskId: string,
  workflowRunId: string,
  workflowStage: WorkflowStage,
  teamId: string | null,
  executor: string | null,
  database: Database.Database = getDb(),
): void {
  database.transaction(() => {
    database.prepare(`
      UPDATE tasks
      SET workflow_run_id=?, workflow_stage=?, updated_at=datetime('now')
      WHERE id=?
    `).run(workflowRunId, workflowStage, taskId);
    database.prepare(`
      UPDATE workflow_runs
      SET root_task_id=COALESCE(root_task_id, ?), updated_at=datetime('now')
      WHERE id=?
    `).run(taskId, workflowRunId);
    markWorkflowStage(workflowRunId, workflowStage, 'running', {
      teamId,
      taskId,
      executor,
    }, database);
  }).immediate();
}

export function syncWorkflowTask(
  taskId: string,
  taskStatus: string,
  options: { error?: string | null; evidence?: unknown } = {},
  database: Database.Database = getDb(),
): void {
  const task = database.prepare(`
    SELECT workflow_run_id, workflow_stage, team_id, assigned_to
    FROM tasks WHERE id=?
  `).get(taskId) as {
    workflow_run_id: string | null;
    workflow_stage: WorkflowStage | null;
    team_id: string | null;
    assigned_to: string | null;
  } | undefined;
  if (!task?.workflow_run_id || !task.workflow_stage) return;
  const status: WorkflowStageStatus = taskStatus === 'completed'
    ? 'completed'
    : taskStatus === 'cancelled'
      ? 'cancelled'
      : 'failed';
  markWorkflowStage(task.workflow_run_id, task.workflow_stage, status, {
    teamId: task.team_id,
    taskId,
    executor: task.assigned_to,
    error: options.error,
    evidence: options.evidence,
  }, database);
}

/**
 * Restore the workflow/task invariant after an unplanned process restart.
 *
 * Task terminal state is durable and authoritative. A process may terminate
 * after persisting that state but before the async completion callback updates
 * workflow_stages/discussions, leaving the dashboard stuck on "running".
 */
export function reconcileTerminalWorkflowTasks(
  database: Database.Database = getDb(),
): number {
  const terminalTasks = database.prepare(`
    SELECT DISTINCT
      t.id,
      t.status,
      t.response,
      t.error,
      t.workflow_run_id,
      t.workflow_stage,
      t.team_id,
      t.assigned_to
    FROM tasks t
    JOIN workflow_stages s
      ON s.workflow_run_id=t.workflow_run_id
     AND s.stage=t.workflow_stage
     AND s.task_id=t.id
     AND (
       (s.team_id IS NULL AND t.team_id IS NULL)
       OR s.team_id=t.team_id
     )
    WHERE t.workflow_run_id IS NOT NULL
      AND t.workflow_stage IS NOT NULL
      AND t.status IN ('completed', 'failed', 'timeout', 'cancelled')
      AND (
        (t.status='completed' AND s.status!='completed')
        OR (t.status IN ('failed','timeout') AND s.status!='failed')
        OR (t.status='cancelled' AND s.status!='cancelled')
      )
  `).all() as Array<{
    id: string;
    status: string;
    response: string | null;
    error: string | null;
    workflow_run_id: string;
    workflow_stage: WorkflowStage;
    team_id: string | null;
    assigned_to: string | null;
  }>;

  if (terminalTasks.length === 0) return 0;

  database.transaction(() => {
    for (const task of terminalTasks) {
      syncWorkflowTask(task.id, task.status, {
        error: task.error,
        evidence: {
          source: 'startup_terminal_task_reconciliation',
          taskStatus: task.status,
        },
      }, database);

      if (task.workflow_stage !== 'discussion') continue;
      const discussionStatus = task.status === 'completed' ? 'completed' : 'failed';
      const report = task.status === 'completed'
        ? task.response
        : task.error ?? `linked_task_${task.status}`;
      database.prepare(`
        UPDATE discussions
        SET status=?,
            report=COALESCE(report, ?),
            ended_at=COALESCE(ended_at, datetime('now')),
            updated_at=datetime('now')
        WHERE workflow_run_id=? AND task_id=? AND status='active'
      `).run(discussionStatus, report, task.workflow_run_id, task.id);
    }
  }).immediate();

  log.warn(
    { count: terminalTasks.length },
    'Reconciled terminal tasks with workflow stages after startup',
  );
  return terminalTasks.length;
}

export function linkWorkflowDiscussion(
  discussionId: string,
  workflowRunId: string,
  options: {
    taskId?: string | null;
    teamId?: string | null;
    companyRunId?: string | null;
  } = {},
  database: Database.Database = getDb(),
): void {
  database.transaction(() => {
    database.prepare(`
      UPDATE discussions
      SET task_id=COALESCE(?, task_id),
          team_id=COALESCE(?, team_id),
          company_run_id=COALESCE(?, company_run_id),
          workflow_run_id=?,
          updated_at=datetime('now')
      WHERE id=?
    `).run(
      options.taskId ?? null,
      options.teamId ?? null,
      options.companyRunId ?? null,
      workflowRunId,
      discussionId,
    );
    markWorkflowStage(workflowRunId, 'discussion', 'running', {
      teamId: options.teamId,
      taskId: options.taskId,
      discussionId,
    }, database);
  }).immediate();
}

export function failStaleDiscussions(
  timeoutMs = Number(process.env.NCO_DISCUSSION_STALE_TIMEOUT_MS ?? 24 * 60 * 60 * 1000),
  database: Database.Database = getDb(),
): number {
  const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs >= 60_000
    ? timeoutMs
    : 24 * 60 * 60 * 1000;
  const modifier = `-${Math.ceil(safeTimeoutMs / 1000)} seconds`;
  const stale = database.prepare(`
    SELECT id, workflow_run_id
    FROM discussions
    WHERE status='active'
      AND datetime(COALESCE(updated_at, created_at)) <= datetime('now', ?)
  `).all(modifier) as Array<{ id: string; workflow_run_id: string | null }>;
  if (stale.length === 0) return 0;

  database.transaction(() => {
    const failDiscussion = database.prepare(`
      UPDATE discussions
      SET status='failed',
          report='discussion_stale_timeout',
          ended_at=datetime('now'),
          updated_at=datetime('now')
      WHERE id=? AND status='active'
    `);
    for (const row of stale) {
      failDiscussion.run(row.id);
      if (row.workflow_run_id) {
        database.prepare(`
          UPDATE workflow_stages
          SET status='failed', error='discussion_stale_timeout',
              completed_at=datetime('now'), updated_at=datetime('now')
          WHERE workflow_run_id=? AND stage='discussion'
            AND discussion_id=? AND status IN ('pending','running')
        `).run(row.workflow_run_id, row.id);
        refreshWorkflowRun(row.workflow_run_id, database);
      }
    }
  }).immediate();
  log.warn({ count: stale.length, timeoutMs: safeTimeoutMs }, 'Failed stale discussions');
  return stale.length;
}
