import { getDb } from '../storage/database.js';
import { agentManager } from '../agent/agent-manager.js';
import { eventBus } from './event-bus.js';
import { createLogger } from '../utils/logger.js';
import { createTaskId } from '../utils/id.js';
import { classifyResult, applyVerifierGate } from './task-queue.js';
import { transitionTask } from './task-state.js';

const log = createLogger('kanban-engine');

export interface KanbanBoard {
  planId: string;
  columns: Record<string, any[]>;
}

class KanbanEngine {
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
  moveTask(taskId: string, toColumn: string): boolean {
    const db = getDb();
    const validColumns = ['todo', 'in_progress', 'review', 'done'];
    if (!validColumns.includes(toColumn)) return false;

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
    }

    return result.changes > 0;
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

    if (tasks.length === 0) return { executed: 0, results: [] };

    // Update plan status to active
    db.prepare("UPDATE plans SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(planId);

    const results: any[] = [];
    let executed = 0;

    if (strategy === 'sequential' || (strategy === 'auto' && tasks.every(t => t.execution_type === 'sequential'))) {
      // Sequential execution
      for (const task of tasks) {
        const result = await this.executeKanbanTask(task);
        results.push(result);
        executed++;
      }
    } else {
      // Parallel: group independent tasks, execute simultaneously
      const parallelBatch = tasks.filter(t => {
        const deps = JSON.parse(t.depends_on_json || '[]');
        return deps.length === 0;
      });
      const sequential = tasks.filter(t => {
        const deps = JSON.parse(t.depends_on_json || '[]');
        return deps.length > 0;
      });

      // Execute parallel batch
      if (parallelBatch.length > 0) {
        const promises = parallelBatch.map(t => this.executeKanbanTask(t));
        const batchResults = await Promise.allSettled(promises);
        for (const r of batchResults) {
          results.push(r.status === 'fulfilled' ? r.value : { error: (r as any).reason?.message });
          executed++;
        }
      }

      // Then sequential
      for (const task of sequential) {
        const result = await this.executeKanbanTask(task);
        results.push(result);
        executed++;
      }
    }

    // Check if all done → update plan status
    const remaining = db.prepare(
      "SELECT COUNT(*) as cnt FROM kanban_tasks WHERE plan_id = ? AND column_status != 'done'"
    ).get(planId) as any;

    if (remaining.cnt === 0) {
      db.prepare("UPDATE plans SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(planId);
    }

    return { executed, results };
  }

  public createRetryTaskRef: ((taskId: string, options?: { overrideAi?: string }) => Promise<any>) | null = null;

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
  ): Promise<void> {
    this.moveTask(kanbanTaskId, 'review');

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
  }

  /**
   * Execute a single kanban task via agent manager.
   */
  private async executeKanbanTask(task: any): Promise<any> {
    const db = getDb();

    // 1. Move to in_progress
    this.moveTask(task.id, 'in_progress');

    let verifierConfig: any = null;
    let maxRetries = 3;
    if (task.description) {
      try {
        const parsed = JSON.parse(task.description);
        if (parsed) {
          if (parsed.verifier) verifierConfig = parsed.verifier;
          if (typeof parsed.maxRetries === 'number') maxRetries = parsed.maxRetries;
          else if (typeof parsed.maxAttempts === 'number') maxRetries = parsed.maxAttempts;
        }
      } catch {}
    }

    const agentId = task.assigned_to || agentManager.listEnabledIds()[0];
    if (!agentId) {
      this.moveTask(task.id, 'review');
      throw new Error('No agent available');
    }

    let attempt = 0;
    let currentPrompt = task.title;
    let lastTaskId = '';
    let success = false;
    let errorMsg = '';
    let lastOutput = '';

    while (true) {
      if (attempt === 0) {
        // Initial attempt
        lastTaskId = createTaskId();
        const verifierJson = verifierConfig ? JSON.stringify(verifierConfig) : null;

        db.prepare(`
          INSERT INTO tasks (id, mode, prompt, assigned_to, status, verifier_json, last_activity_at)
          VALUES (?, 'task', ?, ?, 'running', ?, datetime('now'))
        `).run(lastTaskId, currentPrompt, agentId, verifierJson);

        db.prepare('UPDATE kanban_tasks SET task_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(lastTaskId, task.id);

        try {
          const executeResult = await agentManager.executeTask(agentId, currentPrompt, { taskId: lastTaskId });
          lastOutput = executeResult.output || '';
          
          const finalizedResult = {
            success: executeResult.success,
            output: executeResult.output,
            error: executeResult.error,
          };

          const classified = classifyResult(finalizedResult);
          const controller = new AbortController();
          const gated = await applyVerifierGate({
            taskId: lastTaskId,
            agentId,
            prompt: currentPrompt,
            verifier: verifierConfig,
          }, classified, controller.signal);

          success = gated.success;
          errorMsg = gated.error || '';

          const finalStatus = success ? 'completed' : 'failed';
          transitionTask(db, lastTaskId, finalStatus, {
            response: gated.output || undefined,
            error: gated.error || undefined,
            completedAt: success,
          });
        } catch (err: any) {
          success = false;
          errorMsg = err.message;
          transitionTask(db, lastTaskId, 'failed', {
            error: err.message,
            completedAt: false,
          });
        }
      } else {
        // Retry attempt
        if (!this.createRetryTaskRef) {
          throw new Error('createRetryTaskRef is not registered on KanbanEngine');
        }

        const retryResult = await this.createRetryTaskRef(lastTaskId);
        if (!retryResult.ok) {
          success = false;
          errorMsg = retryResult.body?.error || 'Retry limit exceeded or failed to spawn';
          await this.triggerHumanEscalation(
            db,
            task.id,
            lastTaskId,
            `Retry failed: ${errorMsg}`
          );
          return { taskId: task.id, lastTaskId, success: false, error: errorMsg };
        }

        const newTaskId = retryResult.newTaskId;
        db.prepare('UPDATE kanban_tasks SET task_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(newTaskId, task.id);
        lastTaskId = newTaskId;

        // Poll for completion with a timeout limit (Issue ③)
        let polledTask: any = null;
        let pollCount = 0;
        const maxPollAttempts = 3000; // 5 minutes with 100ms intervals
        let pollingTimedOut = false;
        while (true) {
          polledTask = db.prepare('SELECT status, response, error FROM tasks WHERE id=?').get(newTaskId);
          if (polledTask && ['completed', 'failed', 'timed_out', 'cancelled'].includes(polledTask.status)) {
            break;
          }
          pollCount++;
          if (pollCount >= maxPollAttempts) {
            pollingTimedOut = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (pollingTimedOut) {
          success = false;
          errorMsg = 'Polling timed out waiting for task completion';
          await this.triggerHumanEscalation(
            db,
            task.id,
            newTaskId,
            'Polling timed out: task did not reach terminal state within limit.'
          );
          return { taskId: task.id, lastTaskId: newTaskId, success: false, error: errorMsg };
        }

        success = polledTask.status === 'completed';
        errorMsg = polledTask.error || '';
        lastOutput = polledTask.response || '';
      }

      // Check loop conditions
      if (success) {
        this.moveTask(task.id, 'done');
        return { taskId: task.id, lastTaskId, success: true, output: lastOutput.slice(0, 500) };
      }

      // If failed, check retry budget
      if (attempt >= maxRetries) {
        await this.triggerHumanEscalation(
          db,
          task.id,
          lastTaskId,
          `Max verifier retries (${maxRetries}) exceeded on verification gate.`
        );
        return { taskId: task.id, lastTaskId, success: false, error: errorMsg };
      }

      // Increment attempt and inject feedback for next loop iteration
      attempt++;
      const verifierStatus = await this.getVerifierStatus(db, lastTaskId, false);
      currentPrompt = this.injectFeedbackToPrompt(task.title, verifierStatus.feedback, attempt, maxRetries);

      // We update the prompt of the failed task in the DB so that the next createRetryTask call reads this prompt
      db.prepare('UPDATE tasks SET prompt=? WHERE id=?').run(currentPrompt, lastTaskId);
    }
  }
}

export const kanbanEngine = new KanbanEngine();
