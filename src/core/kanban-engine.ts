import { getDb } from '../storage/database.js';
import { agentManager } from '../agent/agent-manager.js';
import { eventBus } from './event-bus.js';
import { createLogger } from '../utils/logger.js';
import { isTaskCompatibleProvider, smartRouter } from './smart-router.js';
import type { TaskType } from './quality-gate.js';

const log = createLogger('kanban-engine');
const DEFAULT_KANBAN_TASK_TIMEOUT_MS = 1_800_000;
const KANBAN_POLL_GRACE_MS = 60_000;
const KANBAN_POLL_INTERVAL_MS = 250;
const KANBAN_TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'lease_expired',
]);
const KANBAN_SETTLED_STATUSES = new Set([
  ...KANBAN_TERMINAL_STATUSES,
  'reviewing',
]);
const KANBAN_ACTIVE_STATUSES = new Set([
  'pending',
  'queued',
  'assigned',
  'running',
  'streaming',
]);
const KANBAN_REVIEW_STATUSES = new Set([
  'reviewing',
  'failed',
  'timed_out',
  'cancelled',
  'lease_expired',
]);

function projectKanbanColumn(status: string): 'in_progress' | 'review' | 'done' | null {
  if (status === 'completed') return 'done';
  if (KANBAN_REVIEW_STATUSES.has(status)) return 'review';
  if (KANBAN_ACTIVE_STATUSES.has(status)) return 'in_progress';
  return null;
}

export interface KanbanTaskDispatchInput {
  kanbanTaskId: string;
  planId: string;
  agentId: string;
  prompt: string;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  priority?: number;
  verifier?: { type: 'run'; command: string; timeoutMs?: number };
  requiredEvidence?: string[];
  metadata?: Record<string, unknown>;
}

export interface KanbanBoard {
  planId: string;
  columns: Record<string, any[]>;
}

export type KanbanMoveResult =
  | { moved: true }
  | {
      moved: false;
      error: 'invalid_column' | 'kanban_task_not_found' | 'canonical_task_not_completed';
      canonicalTaskId?: string;
      canonicalStatus?: string | null;
    };

class KanbanEngine {
  private readDependencies(task: any): string[] | null {
    try {
      const parsed = JSON.parse(task.depends_on_json || '[]');
      return Array.isArray(parsed) && parsed.every(dep => typeof dep === 'string')
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  private refreshPlanStatus(planId: string): void {
    const db = getDb();
    const summary = db.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE
          WHEN kt.column_status!='done' THEN 1
          WHEN kt.task_id IS NOT NULL AND COALESCE(t.status, '')!='completed' THEN 1
          ELSE 0
        END), 0) AS incomplete
      FROM kanban_tasks kt
      LEFT JOIN tasks t ON t.id=kt.task_id
      WHERE kt.plan_id=?
    `).get(planId) as { total: number; incomplete: number };

    if (summary.total > 0 && summary.incomplete === 0) {
      db.prepare(`
        UPDATE plans
        SET status='completed', updated_at=datetime('now')
        WHERE id=? AND status!='archived'
      `).run(planId);
      return;
    }

    if (summary.incomplete > 0) {
      db.prepare(`
        UPDATE plans
        SET status='active', updated_at=datetime('now')
        WHERE id=? AND status='completed'
      `).run(planId);
    }
  }

  /**
   * Get kanban board for a plan (tasks grouped by column).
   */
  getBoard(planId?: string): KanbanBoard {
    const db = getDb();
    const query = planId
      ? 'SELECT * FROM kanban_tasks WHERE plan_id = ? ORDER BY order_index'
      : 'SELECT * FROM kanban_tasks ORDER BY order_index';
    const tasks = planId ? db.prepare(query).all(planId) : db.prepare(query).all();

    const columns: Record<string, any[]> = {
      todo: [],
      in_progress: [],
      review: [],
      done: [],
    };

    for (const task of tasks as any[]) {
      const col = task.column_status || 'todo';
      if (!columns[col]) columns[col] = [];
      columns[col].push(task);
    }

    return { planId: planId || 'all', columns };
  }

  /**
   * Move a kanban task between columns.
   */
  moveTaskDetailed(taskId: string, toColumn: string): KanbanMoveResult {
    const db = getDb();
    const validColumns = ['todo', 'in_progress', 'review', 'done'];
    if (!validColumns.includes(toColumn)) {
      return { moved: false, error: 'invalid_column' };
    }

    const card = db.prepare('SELECT plan_id, task_id FROM kanban_tasks WHERE id=?')
      .get(taskId) as { plan_id: string; task_id: string | null } | undefined;
    if (!card) return { moved: false, error: 'kanban_task_not_found' };

    if (toColumn === 'done' && card.task_id) {
      const canonical = db.prepare('SELECT status FROM tasks WHERE id=?')
        .get(card.task_id) as { status: string } | undefined;
      if (canonical?.status !== 'completed') {
        return {
          moved: false,
          error: 'canonical_task_not_completed',
          canonicalTaskId: card.task_id,
          canonicalStatus: canonical?.status ?? null,
        };
      }
    }

    const result = db.prepare(
      'UPDATE kanban_tasks SET column_status = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).run(toColumn, taskId);

    if (result.changes > 0) {
      eventBus.publish({
        type: 'kanban:task_moved',
        taskId,
        toColumn,
      });
      log.info({ taskId, toColumn }, 'Kanban task moved');
      this.refreshPlanStatus(card.plan_id);
    }

    return result.changes > 0
      ? { moved: true }
      : { moved: false, error: 'kanban_task_not_found' };
  }

  moveTask(taskId: string, toColumn: string): boolean {
    return this.moveTaskDetailed(taskId, toColumn).moved;
  }

  /**
   * Move a card only while it still belongs to the canonical attempt observed
   * by this execution loop. Nullable ownership is used before initial dispatch.
   */
  private moveTaskIfOwned(
    taskId: string,
    canonicalTaskId: string | null,
    toColumn: string,
  ): boolean {
    const db = getDb();
    const validColumns = ['todo', 'in_progress', 'review', 'done'];
    if (!validColumns.includes(toColumn)) return false;

    const card = db.prepare('SELECT plan_id, task_id FROM kanban_tasks WHERE id=?')
      .get(taskId) as { plan_id: string; task_id: string | null } | undefined;
    if (!card || card.task_id !== canonicalTaskId) return false;

    if (toColumn === 'done' && canonicalTaskId) {
      const canonical = db.prepare('SELECT status FROM tasks WHERE id=?')
        .get(canonicalTaskId) as { status: string } | undefined;
      if (canonical?.status !== 'completed') return false;
    }

    const result = db.prepare(`
      UPDATE kanban_tasks
      SET column_status=?, updated_at=datetime('now')
      WHERE id=?
        AND (
          task_id=?
          OR (task_id IS NULL AND ? IS NULL)
        )
    `).run(toColumn, taskId, canonicalTaskId, canonicalTaskId);
    if (result.changes === 0) return false;

    void eventBus.publish({
      type: 'kanban:task_moved',
      taskId,
      canonicalTaskId,
      toColumn,
    });
    this.refreshPlanStatus(card.plan_id);
    return true;
  }

  /**
   * Bind an execution attempt without stealing a card whose owner changed
   * while the queue/retry request was being created. A gateway retry may have
   * already performed the same source -> child hand-off, so newTaskId is also
   * an accepted current value.
   */
  private bindExecutionTask(
    taskId: string,
    expectedTaskId: string | null,
    newTaskId: string,
  ): boolean {
    const db = getDb();
    const result = db.prepare(`
      UPDATE kanban_tasks
      SET task_id=?, updated_at=datetime('now')
      WHERE id=?
        AND (
          task_id=?
          OR task_id=?
          OR (task_id IS NULL AND ? IS NULL)
        )
    `).run(newTaskId, taskId, newTaskId, expectedTaskId, expectedTaskId);
    if (result.changes === 0) return false;

    const current = db.prepare('SELECT plan_id, task_id FROM kanban_tasks WHERE id=?')
      .get(taskId) as { task_id: string | null } | undefined;
    return current?.task_id === newTaskId;
  }

  private supersededResult(taskId: string, lastTaskId: string): Record<string, unknown> {
    return {
      taskId,
      lastTaskId,
      success: false,
      superseded: true,
      error: 'Kanban task ownership changed',
    };
  }

  /**
   * Project a canonical task state back onto its linked Kanban card.
   *
   * The task_id guard is intentional: a late completion from an older retry
   * must never overwrite the card owned by a newer attempt.
   */
  projectTaskStatus(taskId: string, status?: string): boolean {
    const db = getDb();
    const task = db.prepare(`
      SELECT status, metadata_json
      FROM tasks
      WHERE id=?
    `).get(taskId) as { status: string; metadata_json: string | null } | undefined;
    if (!task) return false;

    let metadata: Record<string, unknown> = {};
    if (task.metadata_json) {
      try {
        const parsed = JSON.parse(task.metadata_json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {}
    }
    const kanbanTaskId = typeof metadata.kanbanTaskId === 'string'
      ? metadata.kanbanTaskId
      : '';
    // The persisted task row is the status source of truth. Callers may pass a
    // status hint after performing a transition, but a stale/mistaken hint must
    // never make a failed canonical task appear completed on the Kanban board.
    if (status !== undefined && status !== task.status) {
      log.warn({
        taskId,
        statusHint: status,
        persistedStatus: task.status,
      }, 'Ignored mismatched canonical task status hint during Kanban projection');
    }
    const projectedStatus = task.status;
    const toColumn = projectKanbanColumn(projectedStatus);
    if (!kanbanTaskId || !toColumn) return false;

    const card = db.prepare(`
      SELECT plan_id
      FROM kanban_tasks
      WHERE id=? AND task_id=?
    `).get(kanbanTaskId, taskId) as { plan_id: string } | undefined;
    if (!card) return false;

    const result = db.prepare(`
      UPDATE kanban_tasks
      SET column_status=?, updated_at=datetime('now')
      WHERE id=? AND task_id=?
    `).run(toColumn, kanbanTaskId, taskId);
    if (result.changes === 0) return false;

    void eventBus.publish({
      type: 'kanban:task_moved',
      taskId: kanbanTaskId,
      canonicalTaskId: taskId,
      toColumn,
    });
    log.info({ taskId: kanbanTaskId, canonicalTaskId: taskId, toColumn }, 'Canonical task projected to Kanban');

    this.refreshPlanStatus(card.plan_id);

    return true;
  }

  /**
   * Hand a Kanban card from one canonical retry attempt to the next.
   *
   * The source task guard prevents a late/manual retry from stealing a card
   * that is already tracking a newer attempt in the same lineage.
   */
  bindRetryTask(sourceTaskId: string, newTaskId: string): boolean {
    if (sourceTaskId === newTaskId) return false;

    const db = getDb();
    const task = db.prepare(`
      SELECT status, metadata_json
      FROM tasks
      WHERE id=?
    `).get(newTaskId) as { status: string; metadata_json: string | null } | undefined;
    if (!task) return false;

    let metadata: Record<string, unknown> = {};
    if (task.metadata_json) {
      try {
        const parsed = JSON.parse(task.metadata_json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {}
    }
    const kanbanTaskId = typeof metadata.kanbanTaskId === 'string'
      ? metadata.kanbanTaskId
      : '';
    const toColumn = projectKanbanColumn(task.status);
    if (!kanbanTaskId || !toColumn) return false;

    const card = db.prepare(`
      SELECT plan_id
      FROM kanban_tasks
      WHERE id=? AND task_id=?
    `).get(kanbanTaskId, sourceTaskId) as { plan_id: string } | undefined;
    if (!card) return false;

    const result = db.prepare(`
      UPDATE kanban_tasks
      SET task_id=?, column_status=?, updated_at=datetime('now')
      WHERE id=? AND task_id=?
    `).run(newTaskId, toColumn, kanbanTaskId, sourceTaskId);
    if (result.changes === 0) return false;

    void eventBus.publish({
      type: 'kanban:task_moved',
      taskId: kanbanTaskId,
      canonicalTaskId: newTaskId,
      previousCanonicalTaskId: sourceTaskId,
      toColumn,
    });
    log.info({
      taskId: kanbanTaskId,
      canonicalTaskId: newTaskId,
      previousCanonicalTaskId: sourceTaskId,
      toColumn,
    }, 'Kanban card rebound to canonical retry');

    this.refreshPlanStatus(card.plan_id);
    return true;
  }

  private claimTaskForExecution(taskId: string): any | null {
    const db = getDb();
    const claim = db.prepare(`
      UPDATE kanban_tasks
      SET column_status = 'in_progress', updated_at = datetime('now')
      WHERE id = ?
        AND column_status = 'todo'
    `).run(taskId);

    if (claim.changes === 0) {
      return null;
    }

    return db.prepare('SELECT * FROM kanban_tasks WHERE id = ?').get(taskId) as any | null;
  }

  /**
   * Spread unassigned work in the same runnable wave across distinct healthy
   * providers. Explicit card assignments always win. The queue still owns
   * final gating/failover, so a routing snapshot becoming stale is contained.
   */
  private async distributeBatch(tasks: any[]): Promise<any[]> {
    const unassigned = tasks.filter(task => !task.assigned_to);
    if (unassigned.length === 0) return tasks;
    const enabled = agentManager.listEnabledIds();
    if (enabled.length === 0) return tasks;

    const groups = new Map<TaskType, any[]>();
    const routingErrors = new Map<string, string>();
    for (const task of unassigned) {
      let taskType: TaskType = 'general';
      try {
        taskType = smartRouter.inferTaskType(`${task.title ?? ''}\n${task.description ?? ''}`);
      } catch (error) {
        log.warn({
          kanbanTaskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        }, 'Kanban task type inference failed closed');
        routingErrors.set(task.id, 'Unable to determine a compatible provider for task');
        continue;
      }
      const group = groups.get(taskType) ?? [];
      group.push(task);
      groups.set(taskType, group);
    }

    const assignments = new Map<string, string>();
    const providerUseCount = new Map<string, number>();
    for (const task of tasks) {
      if (typeof task.assigned_to !== 'string') continue;
      providerUseCount.set(task.assigned_to, (providerUseCount.get(task.assigned_to) ?? 0) + 1);
    }
    for (const [taskType, group] of groups) {
      const fallback = enabled.filter(agentId => isTaskCompatibleProvider(agentId, taskType));
      if (fallback.length === 0) {
        const error = `No compatible provider available for ${taskType} task`;
        for (const task of group) routingErrors.set(task.id, error);
        continue;
      }

      const desired = Math.min(group.length, fallback.length);
      const candidateCount = Math.min(unassigned.length, fallback.length);
      let providers: string[] = [];
      try {
        providers = (await smartRouter.selectProviders(
          desired > 1 ? 'parallel' : 'task',
          candidateCount,
          undefined,
          taskType,
        )).filter(agentId => (
          enabled.includes(agentId)
          && isTaskCompatibleProvider(agentId, taskType)
        ));
      } catch (error) {
        log.warn({
          taskType,
          desired,
          error: error instanceof Error ? error.message : String(error),
        }, 'Kanban batch provider routing fell back to compatible enabled providers');
      }

      if (providers.length === 0) providers = fallback;
      for (const task of group) {
        const provider = providers.reduce((best, candidate) => (
          (providerUseCount.get(candidate) ?? 0) < (providerUseCount.get(best) ?? 0)
            ? candidate
            : best
        ));
        assignments.set(task.id, provider);
        providerUseCount.set(provider, (providerUseCount.get(provider) ?? 0) + 1);
      }
    }

    return tasks.map(task => {
      if (task.assigned_to) return task;
      const providerRoutingError = routingErrors.get(task.id);
      if (providerRoutingError) return { ...task, providerRoutingError };
      return { ...task, assigned_to: assignments.get(task.id) };
    });
  }

  private dependenciesSatisfied(task: any): boolean {
    const db = getDb();
    const deps = this.readDependencies(task);
    if (!deps) return false;

    if (deps.length === 0) {
      return true;
    }

    const readDependency = db.prepare(`
      SELECT kt.column_status, kt.task_id, t.status AS task_status
      FROM kanban_tasks kt
      LEFT JOIN tasks t ON t.id = kt.task_id
      WHERE kt.id = ?
    `);

    return deps.every((depId) => {
      const dep = readDependency.get(depId) as { column_status?: string; task_id?: string | null; task_status?: string | null } | undefined;
      if (!dep || dep.column_status !== 'done') {
        return false;
      }
      if (!dep.task_id) {
        return true;
      }
      return dep.task_status === 'completed';
    });
  }

  private async selectRetryProvider(
    task: any,
    attemptCounts: Map<string, number>,
    allowProviderFailover: boolean,
  ): Promise<string | undefined> {
    if (!allowProviderFailover) return undefined;

    let taskType: TaskType;
    try {
      taskType = smartRouter.inferTaskType(`${task.title ?? ''}\n${task.description ?? ''}`);
    } catch (error) {
      log.warn({
        kanbanTaskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      }, 'Kanban retry provider selection skipped after type inference failure');
      return undefined;
    }

    const enabled = agentManager.listEnabledIds()
      .filter(agentId => isTaskCompatibleProvider(agentId, taskType));
    if (enabled.length < 2) return undefined;

    let candidates: string[] = [];
    try {
      candidates = (await smartRouter.selectProviders(
        'task',
        enabled.length,
        undefined,
        taskType,
      )).filter(agentId => (
        enabled.includes(agentId)
        && isTaskCompatibleProvider(agentId, taskType)
      ));
    } catch (error) {
      log.warn({
        kanbanTaskId: task.id,
        taskType,
        error: error instanceof Error ? error.message : String(error),
      }, 'Kanban retry provider selection fell back to compatible enabled providers');
    }
    if (candidates.length === 0) candidates = enabled;
    candidates = [...new Set(candidates)];

    return candidates.reduce((best, candidate) => (
      (attemptCounts.get(candidate) ?? 0) < (attemptCounts.get(best) ?? 0)
        ? candidate
        : best
    ));
  }

  /**
   * Execute a plan — run kanban tasks via agent manager.
   * Respects depends_on for ordering, uses parallel for independent tasks.
   */
  async executePlan(
    planId: string,
    strategy: 'sequential' | 'parallel' | 'auto' = 'auto',
  ): Promise<{ executed: number; results: any[] }> {
    const db = getDb();
    const tasks = db.prepare(
      "SELECT * FROM kanban_tasks WHERE plan_id = ? AND column_status != 'done' ORDER BY order_index"
    ).all(planId) as any[];

    if (tasks.length === 0) {
      this.refreshPlanStatus(planId);
      return { executed: 0, results: [] };
    }

    // Update plan status to active
    db.prepare("UPDATE plans SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(planId);

    const results: any[] = [];
    let executed = 0;

    // Only todo cards are claimable. review/in_progress cards may be visible in
    // the board query but are already owned by a human or another execution.
    const pending = new Map(
      tasks
        .filter(task => task.column_status === 'todo')
        .map(task => [task.id as string, task]),
    );

    // A wave scheduler makes dependency order independent from order_index.
    // After each wave, canonical completions are visible to the next dependency
    // check. Cycles, missing dependencies, and failed prerequisites make no
    // progress and are reported once after the loop.
    while (pending.size > 0) {
      const runnable = [...pending.values()].filter(task => this.dependenciesSatisfied(task));
      if (runnable.length === 0) break;

      const batch = strategy === 'sequential'
        ? [runnable[0]]
        : strategy === 'parallel'
          ? runnable
          : (() => {
              const declaredParallel = runnable.filter(task => task.execution_type === 'parallel');
              return declaredParallel.length > 0 ? declaredParallel : [runnable[0]];
            })();

      const claimed = batch
        .map(task => {
          pending.delete(task.id);
          return this.claimTaskForExecution(task.id);
        })
        .filter((task): task is any => task != null);
      if (claimed.length === 0) continue;

      let distributed: any[];
      try {
        distributed = await this.distributeBatch(claimed);
      } catch (error) {
        const providerRoutingError = error instanceof Error ? error.message : String(error);
        log.warn({ providerRoutingError }, 'Kanban batch routing failed closed');
        distributed = claimed.map(task => ({ ...task, providerRoutingError }));
      }
      const batchResults = await Promise.allSettled(
        distributed.map(task => this.executeKanbanTask(task)),
      );
      for (let index = 0; index < batchResults.length; index++) {
        const settled = batchResults[index];
        results.push(settled.status === 'fulfilled'
          ? settled.value
          : {
              taskId: claimed[index]?.id,
              success: false,
              error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
            });
        executed++;
      }
    }

    for (const task of pending.values()) {
      results.push({ taskId: task.id, success: false, error: 'Dependencies not completed' });
    }

    this.refreshPlanStatus(planId);

    return { executed, results };
  }

  public createRetryTaskRef: ((
    taskId: string,
    options?: { overrideAi?: string; overridePrompt?: string },
  ) => Promise<any>) | null = null;

  /** Gateway-owned initial dispatch hook so Kanban execution uses the same
   * queue, lease, verifier, quality, and audit contracts as API tasks. */
  public createTaskRef: ((input: KanbanTaskDispatchInput) => Promise<any>) | null = null;

  /**
   * Gateway-owned active-task replacement hook.
   *
   * Active recovery must stop the source worker and preserve its workflow/retry
   * contract atomically. Keeping a separate hook prevents background recovery
   * from marking a task failed before the gateway has validated that a safe
   * replacement can be created.
   */
  public replaceActiveTaskRef: ((taskId: string) => Promise<any>) | null = null;

  /**
   * [신규] 실행 완료된 Task DB 레코드로부터 Verifier 통과 여부 검증 및 피드백 추출
   */
  private async getVerifierStatus(
    db: any,
    taskId: string,
    agentSuccess: boolean
  ): Promise<{ passed: boolean; feedback: string }> {
    const row = db.prepare('SELECT verifier_result_json, error FROM tasks WHERE id=?').get(taskId) as { verifier_result_json?: string; error?: string } | undefined;
    if (!row || !row.verifier_result_json) {
      return { passed: agentSuccess, feedback: row?.error || '' };
    }
    try {
      const verifierResult = JSON.parse(row.verifier_result_json);
      return {
        passed: verifierResult.passed === true,
        feedback: verifierResult.outputSnippet || row.error || '',
      };
    } catch {
      return { passed: agentSuccess, feedback: row?.error || '' };
    }
  }

  /**
   * [신규] 이전 시도의 실패 정보를 반영하여 프롬프트 재생성
   */
  private injectFeedbackToPrompt(
    originalPrompt: string,
    feedback: string,
    currentAttempt: number,
    maxAttempts: number
  ): string {
    const sliced = feedback.length > 1500 ? '... [truncated] ...\n' + feedback.slice(-1500) : feedback;
    return `${originalPrompt}\n\n[Previous Attempt ${currentAttempt}/${maxAttempts} Failed]\nFeedback:\n${sliced}`;
  }

  /**
   * [신규] 최대 재시도 횟수 도달 시 시스템 메타데이터 기록 및 알림 이벤트 발행
   */
  private async triggerHumanEscalation(
    db: any,
    kanbanTaskId: string,
    lastTaskId: string,
    reason: string
  ): Promise<boolean> {
    if (!this.moveTaskIfOwned(kanbanTaskId, lastTaskId || null, 'review')) {
      return false;
    }

    const taskRow = db.prepare('SELECT metadata_json FROM tasks WHERE id=?').get(lastTaskId) as { metadata_json?: string } | undefined;
    let metadata: Record<string, any> = {};
    if (taskRow?.metadata_json) {
      try {
        metadata = JSON.parse(taskRow.metadata_json);
      } catch {}
    }
    metadata.escalated_to_human = true;
    metadata.escalation_reason = reason;

    db.prepare('UPDATE tasks SET metadata_json=? WHERE id=?').run(
      JSON.stringify(metadata),
      lastTaskId
    );

    await eventBus.publish({
      type: 'kanban:task_escalated',
      kanbanTaskId,
      lastTaskId,
      reason,
    });
    await eventBus.publish({
      type: 'task:escalated',
      kanbanTaskId,
      lastTaskId,
      reason,
    });
    return true;
  }

  /**
   * Execute a single kanban task via agent manager.
   */
  private async executeKanbanTask(task: any): Promise<any> {
    const ownership = {
      canonicalTaskId: typeof task.task_id === 'string' ? task.task_id : null as string | null,
    };
    try {
      return await this.runKanbanTask(task, ownership);
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : String(reason);
      log.warn({
        kanbanTaskId: task.id,
        canonicalTaskId: ownership.canonicalTaskId,
        error,
      }, 'Kanban task execution failed unexpectedly');
      try {
        if (!this.moveTaskIfOwned(task.id, ownership.canonicalTaskId, 'review')) {
          return this.supersededResult(task.id, ownership.canonicalTaskId ?? '');
        }
      } catch (containmentError) {
        log.warn({
          kanbanTaskId: task.id,
          error: containmentError instanceof Error ? containmentError.message : String(containmentError),
        }, 'Kanban execution failure could not be projected to review');
      }
      return {
        taskId: task.id,
        lastTaskId: ownership.canonicalTaskId ?? '',
        success: false,
        error,
      };
    }
  }

  private async runKanbanTask(
    task: any,
    ownership: { canonicalTaskId: string | null },
  ): Promise<any> {
    const db = getDb();
    const initialTaskId = ownership.canonicalTaskId;

    if (typeof task.providerRoutingError === 'string') {
      throw new Error(task.providerRoutingError);
    }

    let verifierConfig: any = null;
    let maxRetries = 3;
    let taskTimeoutMs = DEFAULT_KANBAN_TASK_TIMEOUT_MS;
    let model: string | undefined;
    let systemPrompt: string | undefined;
    let priority: number | undefined;
    let requiredEvidence: string[] | undefined;
    let taskMetadata: Record<string, unknown> = {};
    if (task.description) {
      try {
        const parsed = JSON.parse(task.description);
        if (parsed) {
          if (parsed.verifier) verifierConfig = parsed.verifier;
          const configuredRetries = typeof parsed.maxRetries === 'number'
            ? parsed.maxRetries
            : parsed.maxAttempts;
          if (typeof configuredRetries === 'number' && Number.isFinite(configuredRetries)) {
            maxRetries = Math.min(3, Math.max(0, Math.trunc(configuredRetries)));
          }
          if (
            typeof parsed.timeoutMs === 'number'
            && Number.isInteger(parsed.timeoutMs)
            && parsed.timeoutMs >= 1_000
            && parsed.timeoutMs <= DEFAULT_KANBAN_TASK_TIMEOUT_MS
          ) {
            taskTimeoutMs = parsed.timeoutMs;
          }
          if (typeof parsed.model === 'string' && parsed.model.trim()) model = parsed.model.trim();
          if (typeof parsed.systemPrompt === 'string') systemPrompt = parsed.systemPrompt;
          if (Number.isInteger(parsed.priority) && parsed.priority >= 0 && parsed.priority <= 10) {
            priority = parsed.priority;
          }
          if (
            Array.isArray(parsed.requiredEvidence)
            && parsed.requiredEvidence.every((kind: unknown) => typeof kind === 'string' && kind.length > 0)
          ) {
            requiredEvidence = parsed.requiredEvidence;
          }
          if (parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)) {
            taskMetadata = parsed.metadata;
          }
        }
      } catch {}
    }

    const agentId = task.assigned_to || agentManager.listEnabledIds()[0];
    if (!agentId) {
      throw new Error('No agent available');
    }

    let attempt = 0;
    let currentPrompt = task.title;
    let lastTaskId = '';
    let success = false;
    let errorMsg = '';
    let lastOutput = '';
    const providerAttemptCounts = new Map<string, number>([[agentId, 1]]);
    const providerFailoverAllowed = taskMetadata.allowProviderFailover !== false
      && !model
      && !(typeof taskMetadata.model === 'string' && taskMetadata.model.trim());

    while (true) {
      if (attempt === 0) {
        if (!this.createTaskRef) {
          this.moveTaskIfOwned(task.id, initialTaskId, 'review');
          return {
            taskId: task.id,
            lastTaskId,
            success: false,
            error: 'Initial task dispatch contract is not registered',
          };
        }
        const created = await this.createTaskRef({
          kanbanTaskId: task.id,
          planId: task.plan_id,
          agentId,
          prompt: currentPrompt,
          model,
          systemPrompt,
          timeoutMs: taskTimeoutMs,
          priority,
          verifier: verifierConfig ?? undefined,
          requiredEvidence,
          metadata: taskMetadata,
        });
        if (created?.ok !== true || typeof created.newTaskId !== 'string') {
          errorMsg = created?.body?.error || created?.error || 'Initial task dispatch failed';
          if (!this.moveTaskIfOwned(task.id, initialTaskId, 'review')) {
            return this.supersededResult(task.id, lastTaskId);
          }
          return { taskId: task.id, lastTaskId, success: false, error: errorMsg };
        }
        lastTaskId = created.newTaskId;
        if (!this.bindExecutionTask(task.id, initialTaskId, lastTaskId)) {
          return this.supersededResult(task.id, lastTaskId);
        }
        ownership.canonicalTaskId = lastTaskId;
        const actualProvider = db.prepare('SELECT assigned_to FROM tasks WHERE id=?')
          .get(lastTaskId) as { assigned_to?: string | null } | undefined;
        if (actualProvider?.assigned_to && actualProvider.assigned_to !== agentId) {
          providerAttemptCounts.set(
            actualProvider.assigned_to,
            (providerAttemptCounts.get(actualProvider.assigned_to) ?? 0) + 1,
          );
        }
      } else {
        // Retry attempt
        if (!this.createRetryTaskRef) {
          throw new Error('createRetryTaskRef is not registered on KanbanEngine');
        }

        const sourceTaskId = lastTaskId;
        const overrideAi = await this.selectRetryProvider(
          task,
          providerAttemptCounts,
          providerFailoverAllowed,
        );
        const retryResult = await this.createRetryTaskRef(sourceTaskId, {
          overridePrompt: currentPrompt,
          ...(overrideAi ? { overrideAi } : {}),
        });
        if (!retryResult.ok) {
          success = false;
          errorMsg = retryResult.body?.error || 'Retry limit exceeded or failed to spawn';
          const escalated = await this.triggerHumanEscalation(
            db,
            task.id,
            sourceTaskId,
            `Retry failed: ${errorMsg}`
          );
          if (!escalated) return this.supersededResult(task.id, sourceTaskId);
          return { taskId: task.id, lastTaskId, success: false, error: errorMsg };
        }

        const newTaskId = retryResult.newTaskId;
        if (!this.bindExecutionTask(task.id, sourceTaskId, newTaskId)) {
          return this.supersededResult(task.id, newTaskId);
        }
        lastTaskId = newTaskId;
        ownership.canonicalTaskId = newTaskId;
        const actualProvider = db.prepare('SELECT assigned_to FROM tasks WHERE id=?')
          .get(lastTaskId) as { assigned_to?: string | null } | undefined;
        const attemptedProvider = actualProvider?.assigned_to ?? overrideAi;
        if (attemptedProvider) {
          providerAttemptCounts.set(
            attemptedProvider,
            (providerAttemptCounts.get(attemptedProvider) ?? 0) + 1,
          );
        }
      }

      const pollDeadline = Date.now() + taskTimeoutMs + KANBAN_POLL_GRACE_MS;
      let polledTask: any = null;
      while (Date.now() < pollDeadline) {
        polledTask = db.prepare('SELECT status, response, error FROM tasks WHERE id=?').get(lastTaskId);
        if (polledTask && KANBAN_SETTLED_STATUSES.has(polledTask.status)) break;
        await new Promise(resolve => setTimeout(resolve, KANBAN_POLL_INTERVAL_MS));
      }

      if (!polledTask || !KANBAN_SETTLED_STATUSES.has(polledTask.status)) {
        success = false;
        errorMsg = 'Polling timed out waiting for task completion';
        const escalated = await this.triggerHumanEscalation(
          db,
          task.id,
          lastTaskId,
          `Polling timed out after ${taskTimeoutMs + KANBAN_POLL_GRACE_MS}ms`,
        );
        if (!escalated) return this.supersededResult(task.id, lastTaskId);
        return { taskId: task.id, lastTaskId, success: false, error: errorMsg };
      }

      if (polledTask.status === 'reviewing') {
        if (!this.moveTaskIfOwned(task.id, lastTaskId, 'review')) {
          return this.supersededResult(task.id, lastTaskId);
        }
        return {
          taskId: task.id,
          lastTaskId,
          success: false,
          awaitingReview: true,
          status: 'reviewing',
          output: (polledTask.response || '').slice(0, 500),
        };
      }

      if (polledTask.status === 'cancelled') {
        if (!this.moveTaskIfOwned(task.id, lastTaskId, 'review')) {
          return this.supersededResult(task.id, lastTaskId);
        }
        return {
          taskId: task.id,
          lastTaskId,
          success: false,
          cancelled: true,
          status: 'cancelled',
          error: polledTask.error || 'Task cancelled',
        };
      }

      success = polledTask.status === 'completed';
      errorMsg = polledTask.error || '';
      lastOutput = polledTask.response || '';

      // Check loop conditions
      if (success) {
        if (!this.moveTaskIfOwned(task.id, lastTaskId, 'done')) {
          return this.supersededResult(task.id, lastTaskId);
        }
        return { taskId: task.id, lastTaskId, success: true, output: lastOutput.slice(0, 500) };
      }

      // If failed, check retry budget
      if (attempt >= maxRetries) {
        const escalated = await this.triggerHumanEscalation(
          db,
          task.id,
          lastTaskId,
          `Max verifier retries (${maxRetries}) exceeded on verification gate.`
        );
        if (!escalated) return this.supersededResult(task.id, lastTaskId);
        return { taskId: task.id, lastTaskId, success: false, error: errorMsg };
      }

      // Increment attempt and inject feedback for next loop iteration
      attempt++;
      const verifierStatus = await this.getVerifierStatus(db, lastTaskId, false);
      currentPrompt = this.injectFeedbackToPrompt(task.title, verifierStatus.feedback, attempt, maxRetries);
    }
  }
}

export const kanbanEngine = new KanbanEngine();
