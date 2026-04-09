import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { env } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('plan-manager');

const PLANS_DIR = resolve(env.ROOT, 'docs/plans');

export interface Plan {
  id: string;
  title: string;
  markdownPath: string;
  sourceDiscussionId?: string;
  status: string;
  createdAt: string;
}

export interface KanbanTask {
  id: string;
  planId: string;
  title: string;
  description?: string;
  columnStatus: string;
  assignedTo?: string;
  orderIndex: number;
  dependsOn: string[];
  executionType: string;
}

class PlanManager {
  /**
   * Create a new plan with markdown file + DB record.
   */
  async createPlan(title: string, tasks?: string[], sourceDiscussionId?: string): Promise<Plan> {
    const id = createId('plan');
    const slug = title.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    const markdownPath = `docs/plans/${slug}.md`;
    const fullPath = resolve(env.ROOT, markdownPath);

    // Ensure plans directory exists
    if (!existsSync(PLANS_DIR)) {
      await mkdir(PLANS_DIR, { recursive: true });
    }

    // Generate markdown content
    const taskLines = (tasks || []).map((t, i) => `- [ ] ${t}`).join('\n');
    const content = `# ${title}\n\n${taskLines || '- [ ] (작업 추가 필요)'}\n`;

    await writeFile(fullPath, content, 'utf-8');

    // DB record
    const db = getDb();
    db.prepare(`
      INSERT INTO plans (id, title, markdown_path, source_discussion_id, status)
      VALUES (?, ?, ?, ?, 'draft')
    `).run(id, title, markdownPath, sourceDiscussionId || null);

    // If tasks provided, also create kanban_tasks
    if (tasks && tasks.length > 0) {
      this.syncFromTaskList(id, tasks);
    }

    log.info({ id, title, markdownPath }, 'Plan created');

    return {
      id, title, markdownPath,
      sourceDiscussionId: sourceDiscussionId || undefined,
      status: 'draft',
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Get a plan by ID.
   */
  getPlan(id: string): Plan | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      markdownPath: row.markdown_path,
      sourceDiscussionId: row.source_discussion_id,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  /**
   * List all plans.
   */
  listPlans(): Plan[] {
    const db = getDb();
    return (db.prepare('SELECT * FROM plans ORDER BY created_at DESC').all() as any[]).map(row => ({
      id: row.id,
      title: row.title,
      markdownPath: row.markdown_path,
      sourceDiscussionId: row.source_discussion_id,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  /**
   * Sync markdown file → DB kanban_tasks.
   * Parses `- [ ]` and `- [x]` checkboxes.
   */
  async syncFromMarkdown(planId: string): Promise<number> {
    const plan = this.getPlan(planId);
    if (!plan) throw new Error('Plan not found');

    const fullPath = resolve(env.ROOT, plan.markdownPath);
    if (!existsSync(fullPath)) throw new Error('Markdown file not found');

    const content = await readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    const db = getDb();

    // Clear existing tasks for this plan
    db.prepare('DELETE FROM kanban_tasks WHERE plan_id = ?').run(planId);

    let order = 0;
    let synced = 0;

    for (const line of lines) {
      const checkboxMatch = line.match(/^\s*-\s*\[( |x|X)\]\s*(.+)/);
      if (!checkboxMatch) continue;

      const isDone = checkboxMatch[1].toLowerCase() === 'x';
      const title = checkboxMatch[2].trim();

      // Parse optional assignment: (agent-name)
      const assignMatch = title.match(/\((\w[\w-]*)\)\s*$/);
      const assignedTo = assignMatch ? assignMatch[1] : null;
      const cleanTitle = assignedTo && assignMatch ? title.replace(assignMatch[0], '').trim() : title;

      // Parse execution type prefix: S=sequential, P=parallel
      const typeMatch = cleanTitle.match(/^([SP])\d+[a-z]?:\s*/);
      const executionType = typeMatch?.[1] === 'P' ? 'parallel' : 'sequential';
      const finalTitle = typeMatch ? cleanTitle.replace(typeMatch[0], '') : cleanTitle;

      db.prepare(`
        INSERT INTO kanban_tasks (id, plan_id, title, column_status, assigned_to, order_index, execution_type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        createId('kt'),
        planId,
        finalTitle,
        isDone ? 'done' : 'todo',
        assignedTo,
        order++,
        executionType,
      );
      synced++;
    }

    log.info({ planId, synced }, 'Synced from markdown');
    return synced;
  }

  /**
   * Sync DB kanban_tasks → markdown file.
   */
  async syncToMarkdown(planId: string): Promise<void> {
    const plan = this.getPlan(planId);
    if (!plan) throw new Error('Plan not found');

    const db = getDb();
    const tasks = db.prepare(
      'SELECT * FROM kanban_tasks WHERE plan_id = ? ORDER BY order_index'
    ).all(planId) as any[];

    const lines = [`# ${plan.title}`, ''];
    for (const task of tasks) {
      const checkbox = task.column_status === 'done' ? '[x]' : '[ ]';
      const assigned = task.assigned_to ? ` (${task.assigned_to})` : '';
      lines.push(`- ${checkbox} ${task.title}${assigned}`);
    }
    lines.push('');

    const fullPath = resolve(env.ROOT, plan.markdownPath);
    await writeFile(fullPath, lines.join('\n'), 'utf-8');
    log.info({ planId }, 'Synced to markdown');
  }

  /**
   * Create kanban tasks from a task list.
   */
  private syncFromTaskList(planId: string, tasks: string[]): void {
    const db = getDb();
    tasks.forEach((title, i) => {
      db.prepare(`
        INSERT INTO kanban_tasks (id, plan_id, title, column_status, order_index, execution_type)
        VALUES (?, ?, ?, 'todo', ?, 'sequential')
      `).run(createId('kt'), planId, title, i);
    });
  }
}

export const planManager = new PlanManager();
