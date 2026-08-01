import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, relative } from 'path';
import chokidar from 'chokidar';
import Handlebars from 'handlebars';
import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { env } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('plan-manager');

const PLANS_DIR = resolve(env.ROOT, 'docs/plans');
const EMPTY_PLAN_PLACEHOLDER = '(작업 추가 필요)';
const MAX_PLAN_TASK_TITLE_LENGTH = 1_000;
const ACTIVE_CANONICAL_TASK_STATUSES = new Set([
  'pending',
  'queued',
  'assigned',
  'running',
  'streaming',
  'reviewing',
]);

export type PlanSyncConflict = {
  kanbanTaskId: string;
  canonicalTaskId: string | null;
  kanbanStatus: string;
  canonicalStatus: string | null;
};

export class PlanSyncConflictError extends Error {
  readonly code = 'plan_has_active_tasks';

  constructor(readonly conflicts: PlanSyncConflict[]) {
    super('Plan markdown cannot be synchronized while linked tasks are active or awaiting review');
    this.name = 'PlanSyncConflictError';
  }
}

export class PlanSyncCompletionError extends Error {
  readonly code = 'canonical_task_not_completed';

  constructor(readonly conflicts: PlanSyncConflict[]) {
    super('Plan markdown cannot mark a linked card done before its canonical task completes');
    this.name = 'PlanSyncCompletionError';
  }
}

export class PlanNotFoundError extends Error {
  readonly code = 'plan_not_found';

  constructor(readonly planId: string) {
    super(`Plan not found: ${planId}`);
    this.name = 'PlanNotFoundError';
  }
}

export class PlanMarkdownNotFoundError extends Error {
  readonly code = 'plan_markdown_not_found';

  constructor(readonly planId: string, readonly markdownPath: string) {
    super(`Markdown file not found for plan: ${planId}`);
    this.name = 'PlanMarkdownNotFoundError';
  }
}

export type PlanTaskValidationIssue = {
  index: number;
  line?: number;
  label: string;
  reason: 'title_required' | 'title_too_long';
};

export class PlanTaskValidationError extends Error {
  readonly code = 'invalid_plan_task';

  constructor(readonly issues: PlanTaskValidationIssue[]) {
    super('One or more plan tasks have an invalid title');
    this.name = 'PlanTaskValidationError';
  }
}

export function buildPlanMarkdownPath(title: string, planId: string): string {
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  return `docs/plans/${slug || 'plan'}-${planId}.md`;
}

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

export interface ParsedPlanTaskLabel {
  title: string;
  assignedTo: string | null;
  executionType: 'sequential' | 'parallel';
}

/** Parse the markdown/API task label contract in one place. */
export function parsePlanTaskLabel(value: string): ParsedPlanTaskLabel {
  const label = value.trim();
  const assignMatch = label.match(/\((\w[\w-]*)\)\s*$/);
  const assignedTo = assignMatch ? assignMatch[1] : null;
  const withoutAssignment = assignedTo && assignMatch
    ? label.replace(assignMatch[0], '').trim()
    : label;
  const typeMatch = withoutAssignment.match(/^([SP])\d+[a-z]?:\s*/i);
  return {
    title: typeMatch ? withoutAssignment.replace(typeMatch[0], '').trim() : withoutAssignment,
    assignedTo,
    executionType: typeMatch?.[1].toUpperCase() === 'P' ? 'parallel' : 'sequential',
  };
}

function validatePlanTaskLabels(
  labels: Array<{ label: string; line?: number }>,
): ParsedPlanTaskLabel[] {
  const parsed = labels.map(item => parsePlanTaskLabel(item.label));
  const issues: PlanTaskValidationIssue[] = [];
  for (let index = 0; index < parsed.length; index++) {
    const task = parsed[index];
    if (!task.title) {
      issues.push({
        index,
        line: labels[index].line,
        label: labels[index].label,
        reason: 'title_required',
      });
    } else if (task.title.length > MAX_PLAN_TASK_TITLE_LENGTH) {
      issues.push({
        index,
        line: labels[index].line,
        label: labels[index].label,
        reason: 'title_too_long',
      });
    }
  }
  if (issues.length > 0) throw new PlanTaskValidationError(issues);
  return parsed;
}

class PlanManager {
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
    } else if (summary.incomplete > 0) {
      db.prepare(`
        UPDATE plans
        SET status='active', updated_at=datetime('now')
        WHERE id=? AND status='completed'
      `).run(planId);
    }
  }

  /**
   * Create a new plan with markdown file + DB record.
   */
  async createPlan(title: string, tasks?: string[], sourceDiscussionId?: string): Promise<Plan> {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) throw new Error('Plan title is required');
    const taskLabels = tasks ?? [];
    const parsedTasks = validatePlanTaskLabels(taskLabels.map(label => ({ label })));
    const id = createId('plan');
    const markdownPath = buildPlanMarkdownPath(normalizedTitle, id);
    const fullPath = resolve(env.ROOT, markdownPath);

    // Ensure plans directory exists
    if (!existsSync(PLANS_DIR)) {
      await mkdir(PLANS_DIR, { recursive: true });
    }

    // Generate markdown content
    const taskLines = taskLabels.map(t => `- [ ] ${t}`).join('\n');
    const content = `# ${normalizedTitle}\n\n${taskLines || `<!-- ${EMPTY_PLAN_PLACEHOLDER} -->`}\n`;

    await writeFile(fullPath, content, { encoding: 'utf-8', flag: 'wx' });

    const db = getDb();
    try {
      const persistPlan = db.transaction(() => {
        db.prepare(`
          INSERT INTO plans (id, title, markdown_path, source_discussion_id, status)
          VALUES (?, ?, ?, ?, 'draft')
        `).run(id, normalizedTitle, markdownPath, sourceDiscussionId || null);

        if (parsedTasks.length > 0) {
          this.syncFromTaskList(id, parsedTasks);
        }
      });
      persistPlan();
    } catch (error) {
      await unlink(fullPath).catch(() => undefined);
      throw error;
    }

    log.info({ id, title: normalizedTitle, markdownPath }, 'Plan created');

    return {
      id, title: normalizedTitle, markdownPath,
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
    if (!plan) throw new PlanNotFoundError(planId);

    const fullPath = resolve(env.ROOT, plan.markdownPath);
    if (!existsSync(fullPath)) throw new PlanMarkdownNotFoundError(planId, plan.markdownPath);

    const content = await readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    const db = getDb();
    const desired: Array<{
      title: string;
      columnStatus: 'todo' | 'done';
      assignedTo: string | null;
      orderIndex: number;
      executionType: 'sequential' | 'parallel';
    }> = [];

    const taskLabels: Array<{
      label: string;
      line: number;
      columnStatus: 'todo' | 'done';
    }> = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const checkboxMatch = line.match(/^\s*-\s*\[( |x|X)\]\s*(.*)$/);
      if (!checkboxMatch) continue;

      const isDone = checkboxMatch[1].toLowerCase() === 'x';
      const label = checkboxMatch[2].trim();
      // Older empty plans used a checkbox as instructional copy. It must not
      // become executable work when those files are synchronized again.
      if (label === EMPTY_PLAN_PLACEHOLDER) continue;
      taskLabels.push({
        label,
        line: lineIndex + 1,
        columnStatus: isDone ? 'done' : 'todo',
      });
    }

    const parsedTasks = validatePlanTaskLabels(taskLabels);
    for (let index = 0; index < parsedTasks.length; index++) {
      const parsed = parsedTasks[index];

      desired.push({
        title: parsed.title,
        columnStatus: taskLabels[index].columnStatus,
        assignedTo: parsed.assignedTo,
        orderIndex: desired.length,
        executionType: parsed.executionType,
      });
    }

    const existing = db.prepare(`
      SELECT kt.*, t.status AS canonical_status
      FROM kanban_tasks kt
      LEFT JOIN tasks t ON t.id=kt.task_id
      WHERE kt.plan_id=?
      ORDER BY kt.order_index, kt.created_at, kt.id
    `).all(planId) as Array<{
      id: string;
      title: string;
      column_status: string;
      task_id: string | null;
      canonical_status: string | null;
    }>;
    const conflicts = existing
      .filter(card => (
        card.column_status === 'in_progress'
        || card.column_status === 'review'
        || (card.canonical_status != null && ACTIVE_CANONICAL_TASK_STATUSES.has(card.canonical_status))
      ))
      .map(card => ({
        kanbanTaskId: card.id,
        canonicalTaskId: card.task_id,
        kanbanStatus: card.column_status,
        canonicalStatus: card.canonical_status,
      }));
    if (conflicts.length > 0) {
      throw new PlanSyncConflictError(conflicts);
    }

    const completionPreviewByTitle = new Map<string, typeof existing>();
    for (const card of existing) {
      const matches = completionPreviewByTitle.get(card.title) ?? [];
      matches.push(card);
      completionPreviewByTitle.set(card.title, matches);
    }
    const completionConflicts: PlanSyncConflict[] = [];
    for (const task of desired) {
      const match = completionPreviewByTitle.get(task.title)?.shift();
      if (
        task.columnStatus === 'done'
        && match?.task_id
        && match.canonical_status !== 'completed'
      ) {
        completionConflicts.push({
          kanbanTaskId: match.id,
          canonicalTaskId: match.task_id,
          kanbanStatus: match.column_status,
          canonicalStatus: match.canonical_status,
        });
      }
    }
    if (completionConflicts.length > 0) {
      throw new PlanSyncCompletionError(completionConflicts);
    }

    const existingByTitle = new Map<string, typeof existing>();
    for (const card of existing) {
      const matches = existingByTitle.get(card.title) ?? [];
      matches.push(card);
      existingByTitle.set(card.title, matches);
    }

    const retainedIds = new Set<string>();
    const reconcile = db.transaction(() => {
      for (const task of desired) {
        const match = existingByTitle.get(task.title)?.shift();
        if (match) {
          retainedIds.add(match.id);
          db.prepare(`
            UPDATE kanban_tasks
            SET title=?, column_status=?, assigned_to=?, order_index=?, execution_type=?,
                updated_at=datetime('now')
            WHERE id=? AND plan_id=?
          `).run(
            task.title,
            task.columnStatus,
            task.assignedTo,
            task.orderIndex,
            task.executionType,
            match.id,
            planId,
          );
          continue;
        }

        db.prepare(`
          INSERT INTO kanban_tasks (id, plan_id, title, column_status, assigned_to, order_index, execution_type)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          createId('kt'),
          planId,
          task.title,
          task.columnStatus,
          task.assignedTo,
          task.orderIndex,
          task.executionType,
        );
      }

      for (const card of existing) {
        if (!retainedIds.has(card.id)) {
          db.prepare('DELETE FROM kanban_tasks WHERE id=? AND plan_id=?').run(card.id, planId);
        }
      }
    });
    reconcile();
    this.refreshPlanStatus(planId);

    log.info({ planId, synced: desired.length }, 'Synced from markdown');
    return desired.length;
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
      // Absence of a prefix is the canonical sequential form. Parallel cards
      // need an explicit P marker or the next markdown -> DB sync silently
      // demotes them to sequential execution.
      const execution = task.execution_type === 'parallel'
        ? `P${Number(task.order_index) + 1}: `
        : '';
      lines.push(`- ${checkbox} ${execution}${task.title}${assigned}`);
    }
    lines.push('');

    const fullPath = resolve(env.ROOT, plan.markdownPath);
    await writeFile(fullPath, lines.join('\n'), 'utf-8');
    log.info({ planId }, 'Synced to markdown');
  }

  /**
   * Render a Handlebars template with context.
   */
  renderTemplate(templateStr: string, context: Record<string, unknown>): string {
    const tmpl = Handlebars.compile(templateStr);
    return tmpl(context);
  }

  /**
   * Export a plan as a Handlebars-rendered markdown string.
   */
  exportPlanAsMarkdown(plan: Plan): string {
    const db = getDb();
    const tasks = db.prepare(
      'SELECT * FROM kanban_tasks WHERE plan_id = ? ORDER BY order_index'
    ).all(plan.id) as any[];

    const templateStr = `# {{title}}

{{#each tasks}}
- [{{#if done}}x{{else}} {{/if}}] {{title}}{{#if assignedTo}} ({{assignedTo}}){{/if}}
{{/each}}
`;
    return this.renderTemplate(templateStr, {
      title: plan.title,
      tasks: tasks.map(t => ({
        title: t.execution_type === 'parallel'
          ? `P${Number(t.order_index) + 1}: ${t.title}`
          : t.title,
        done: t.column_status === 'done',
        assignedTo: t.assigned_to,
      })),
    });
  }

  /**
   * Watch markdown under `dir` and sync DB kanban when files change on disk (P4-9c).
   */
  watchPlans(dir: string): ReturnType<typeof chokidar.watch> {
    return chokidar.watch(`${dir}/**/*.md`)
      .on('change', (filePath: string) => {
        void this.loadFromFile(filePath).catch((err: unknown) => {
          log.error({ err, filePath }, 'Plan watch loadFromFile failed');
        });
      })
      .on('add', (filePath: string) => {
        void this.loadFromFile(filePath).catch((err: unknown) => {
          log.error({ err, filePath }, 'Plan watch loadFromFile failed');
        });
      });
  }

  /**
   * Reload a plan from disk when its markdown file changes; no-op if path is not a known plan.
   */
  private async loadFromFile(filePath: string): Promise<void> {
    const normalized = resolve(filePath);
    const relFromRoot = relative(env.ROOT, normalized).replace(/\\/g, '/');
    const db = getDb();
    const row = db.prepare('SELECT id FROM plans WHERE markdown_path = ?').get(relFromRoot) as
      | { id: string }
      | undefined;
    if (!row) return;
    await this.syncFromMarkdown(row.id);
  }

  /**
   * Create kanban tasks from a task list.
   */
  private syncFromTaskList(planId: string, tasks: ParsedPlanTaskLabel[]): void {
    const db = getDb();
    tasks.forEach((task, i) => {
      db.prepare(`
        INSERT INTO kanban_tasks (
          id, plan_id, title, column_status, assigned_to, order_index, execution_type
        ) VALUES (?, ?, ?, 'todo', ?, ?, ?)
      `).run(createId('kt'), planId, task.title, task.assignedTo, i, task.executionType);
    });
  }
}

export const planManager = new PlanManager();
