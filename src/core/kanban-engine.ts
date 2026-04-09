import { getDb } from '../storage/database.js';
import { agentManager } from '../agent/agent-manager.js';
import { eventBus } from './event-bus.js';
import { createLogger } from '../utils/logger.js';

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

  /**
   * Execute a single kanban task via agent manager.
   */
  private async executeKanbanTask(task: any): Promise<any> {
    const db = getDb();

    // Move to in_progress
    this.moveTask(task.id, 'in_progress');

    try {
      // Pick agent: assigned_to or first available
      const agentId = task.assigned_to || agentManager.listEnabledIds()[0];
      if (!agentId) throw new Error('No agent available');

      const result = await agentManager.executeTask(agentId, task.title, {});

      // Move to done on success
      this.moveTask(task.id, result.success ? 'done' : 'review');

      return { taskId: task.id, agentId, success: result.success, output: result.output?.slice(0, 500) };
    } catch (err: any) {
      this.moveTask(task.id, 'review');
      return { taskId: task.id, error: err.message };
    }
  }
}

export const kanbanEngine = new KanbanEngine();
