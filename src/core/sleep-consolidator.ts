/**
 * SleepConsolidator — SCM-inspired asynchronous memory consolidation.
 *
 * Mimics NREM/REM sleep stages:
 *   NREM: Replay recent memories, boost importance of frequently accessed
 *   REM:  Prune low-importance stale memories, merge near-duplicates
 *
 * Runs as a background job (default: every 6 hours via CronScheduler).
 * Non-blocking — NCO continues operating during consolidation.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';
import { knowledgeBase } from './knowledge-base.js';
import { vectorMemory } from './vector-memory.js';

const log = createLogger('sleep-consolidator');
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TEXT_CHARS = 4000;

export interface ConsolidationReport {
  agentId: string;
  boosted: number;
  pruned: number;
  total: number;
  durationMs: number;
}

export interface SelfImprovementReport {
  tasksReviewed: number;
  notesReviewed: number;
  logsReviewed: number;
  lessonsDistilled: number;
  lessonsSaved: number;
  durationMs: number;
}

export interface RawInputData {
  tasks: Array<{
    id: string;
    prompt: string;
    response: string;
    completedAt: string;
    workspaceId: string;
  }>;
  notes: Array<{
    filename: string;
    content: string;
    mtime: string;
  }>;
  logs: Array<{
    id: string;
    timestamp: string;
    level: string;
    message: string;
    contextJson?: string;
  }>;
}

export interface DistilledLesson {
  category: 'bug_pattern' | 'architecture' | 'convention' | 'decision';
  content: string;
  projectPath: string;
  sourceTaskId?: string;
  confidence: number;
}

class SleepConsolidator {
  private running = false;
  private runningSelfImprovement = false;

  async consolidate(agentId?: string): Promise<ConsolidationReport[]> {
    if (this.running) {
      log.warn('Consolidation already in progress — skipped');
      return [];
    }
    this.running = true;
    const reports: ConsolidationReport[] = [];
    const start = Date.now();

    try {
      const db = getDb();
      const agents: string[] = agentId
        ? [agentId]
        : (db.prepare('SELECT DISTINCT agent_id FROM mem0_entries').all() as Array<{ agent_id: string }>).map((r) => r.agent_id);

      for (const aid of agents) {
        const report = await this.consolidateAgent(aid);
        reports.push(report);
        log.info(report, 'Agent memory consolidated');
      }
    } finally {
      this.running = false;
      await vectorMemory.flushAll();
    }

    log.info({ agents: reports.length, totalMs: Date.now() - start }, 'Sleep consolidation complete');
    return reports;
  }

  getSelfImprovementGateStatus(): { ok: boolean; reason?: 'active_tasks' | 'mutex'; activeTasks: number } {
    const db = getDb();
    const activeTasks = Number(
      (db.prepare(`
        SELECT COUNT(*) as n
        FROM tasks
        WHERE status IN ('running', 'streaming', 'reviewing')
      `).get() as { n?: number } | undefined)?.n ?? 0,
    );

    if (activeTasks > 0) {
      return { ok: false, reason: 'active_tasks', activeTasks };
    }
    if (this.running || this.runningSelfImprovement) {
      return { ok: false, reason: 'mutex', activeTasks };
    }
    return { ok: true, activeTasks };
  }

  async consolidateSelfImprovements(): Promise<SelfImprovementReport> {
    const startedAt = Date.now();
    const gate = this.getSelfImprovementGateStatus();
    if (!gate.ok) {
      const report = this.emptySelfImprovementReport(startedAt);
      this.insertConsolidationLog(
        gate.reason === 'active_tasks' ? 'warn' : 'info',
        `Self-improvement skipped: ${gate.reason}`,
        { ...report, activeTasks: gate.activeTasks },
        'skipped',
      );
      return report;
    }

    this.runningSelfImprovement = true;

    try {
      const since = this.getLastSuccessfulSelfImprovementRun();
      const [tasks, notes, logsData] = await Promise.all([
        this.fetchRecentTasks(since),
        this.fetchRecentFileSystemNotes(since),
        this.fetchRecentLogs(since),
      ]);

      const inputs: RawInputData = { tasks, notes, logs: logsData };
      const lessons = (await this.distillLessonsWithLLM(inputs))
        .filter((lesson) => lesson.confidence >= 0.7);
      const lessonsSaved = await this.mergeAndSaveLessons(lessons);

      const report: SelfImprovementReport = {
        tasksReviewed: tasks.length,
        notesReviewed: notes.length,
        logsReviewed: logsData.length,
        lessonsDistilled: lessons.length,
        lessonsSaved,
        durationMs: Date.now() - startedAt,
      };

      this.insertConsolidationLog(
        'info',
        'Self-improvement consolidation complete',
        { ...report },
        lessonsSaved > 0 ? 'success' : (knowledgeBase.isSelfImprovementAutoApplyEnabled() ? 'success' : 'pending_approval'),
      );
      return report;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.insertConsolidationLog('error', 'Self-improvement consolidation failed', { error: message }, 'failed');
      throw err;
    } finally {
      this.runningSelfImprovement = false;
    }
  }

  private async consolidateAgent(agentId: string): Promise<ConsolidationReport> {
    const db = getDb();
    const start = Date.now();

    const boosted = db.prepare(`
      UPDATE mem0_entries
      SET importance = MIN(5.0, importance * (1 + 0.1 * access_count))
      WHERE agent_id = ?
        AND access_count > 2
        AND datetime(created_at) > datetime('now', '-30 days')
    `).run(agentId).changes;

    db.prepare(`
      UPDATE mem0_entries
      SET importance = importance * 0.8
      WHERE agent_id = ?
        AND access_count = 0
        AND datetime(created_at) < datetime('now', '-7 days')
    `).run(agentId);

    const pruned = db.prepare(`
      DELETE FROM mem0_entries
      WHERE agent_id = ? AND importance < 0.1
    `).run(agentId).changes;

    const total = (db.prepare('SELECT COUNT(*) as n FROM mem0_entries WHERE agent_id = ?').get(agentId) as { n: number }).n;
    let trimmed = 0;
    const MAX_PER_AGENT = 10_000;
    if (total > MAX_PER_AGENT) {
      const toDelete = total - MAX_PER_AGENT;
      trimmed = db.prepare(`
        DELETE FROM mem0_entries WHERE id IN (
          SELECT id FROM mem0_entries WHERE agent_id = ?
          ORDER BY importance ASC, created_at ASC LIMIT ?
        )
      `).run(agentId, toDelete).changes;
    }

    if (pruned + trimmed > 0) {
      await vectorMemory.rebuildIndex(agentId);
    }

    const finalCount = (db.prepare('SELECT COUNT(*) as n FROM mem0_entries WHERE agent_id = ?').get(agentId) as { n: number }).n;

    return {
      agentId,
      boosted,
      pruned: pruned + trimmed,
      total: finalCount,
      durationMs: Date.now() - start,
    };
  }

  private emptySelfImprovementReport(startedAt: number): SelfImprovementReport {
    return {
      tasksReviewed: 0,
      notesReviewed: 0,
      logsReviewed: 0,
      lessonsDistilled: 0,
      lessonsSaved: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  private getLastSuccessfulSelfImprovementRun(): string {
    const db = getDb();
    const row = db.prepare(`
      SELECT timestamp
      FROM logs
      WHERE category = 'sleep-consolidator'
        AND status = 'success'
        AND message = 'Self-improvement consolidation complete'
      ORDER BY timestamp DESC
      LIMIT 1
    `).get() as { timestamp?: string } | undefined;

    return row?.timestamp ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();
  }

  private async fetchRecentTasks(since: string): Promise<RawInputData['tasks']> {
    const db = getDb();
    return (db.prepare(`
      SELECT id, prompt, response, completed_at, workspace_id
      FROM tasks
      WHERE status = 'completed'
        AND completed_at IS NOT NULL
        AND datetime(completed_at) > datetime(?)
      ORDER BY completed_at DESC
      LIMIT 50
    `).all(since) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id ?? ''),
      prompt: this.sanitizeAndTruncate(String(row.prompt ?? '')),
      response: this.sanitizeAndTruncate(String(row.response ?? '')),
      completedAt: String(row.completed_at ?? ''),
      workspaceId: String(row.workspace_id ?? 'default'),
    }));
  }

  private async fetchRecentFileSystemNotes(since: string): Promise<RawInputData['notes']> {
    const notesDir = join(homedir(), '.claude', 'improvements');
    let filenames: string[] = [];
    try {
      filenames = await readdir(notesDir);
    } catch {
      return [];
    }

    const sinceMs = new Date(since).getTime();
    const notes = await Promise.all(
      filenames
        .filter((filename) => extname(filename).toLowerCase() === '.md')
        .map(async (filename) => {
          const fullPath = join(notesDir, filename);
          const fileStat = await stat(fullPath);
          if (fileStat.mtimeMs <= sinceMs) {
            return null;
          }
          const content = await readFile(fullPath, 'utf-8');
          return {
            filename,
            content: this.sanitizeAndTruncate(content),
            mtime: new Date(fileStat.mtimeMs).toISOString(),
          };
        }),
    );

    return notes.filter((note): note is NonNullable<typeof note> => note !== null);
  }

  private async fetchRecentLogs(since: string): Promise<RawInputData['logs']> {
    const db = getDb();
    const logsRows = db.prepare(`
      SELECT id, timestamp, level, message, context_json
      FROM logs
      WHERE datetime(timestamp) > datetime(?)
        AND level IN ('warn', 'error', 'fatal')
      ORDER BY timestamp DESC
      LIMIT 100
    `).all(since) as Array<Record<string, unknown>>;

    const meshRows = db.prepare(`
      SELECT id, created_at, type, content
      FROM mesh_messages
      WHERE datetime(created_at) > datetime(?)
      ORDER BY created_at DESC
      LIMIT 50
    `).all(since) as Array<Record<string, unknown>>;

    return [
      ...logsRows.map((row) => ({
        id: String(row.id ?? ''),
        timestamp: String(row.timestamp ?? ''),
        level: String(row.level ?? 'info'),
        message: this.sanitizeAndTruncate(String(row.message ?? '')),
        contextJson: typeof row.context_json === 'string' ? this.sanitizeAndTruncate(row.context_json) : undefined,
      })),
      ...meshRows.map((row) => ({
        id: `mesh:${String(row.id ?? '')}`,
        timestamp: String(row.created_at ?? ''),
        level: String(row.type ?? 'info'),
        message: this.sanitizeAndTruncate(String(row.content ?? '')),
        contextJson: undefined,
      })),
    ];
  }

  private async distillLessonsWithLLM(inputs: RawInputData): Promise<DistilledLesson[]> {
    const llmLessons = await this.tryDistillWithLLM(inputs);
    if (llmLessons.length > 0) {
      return this.dedupeLessons(llmLessons);
    }
    return this.dedupeLessons(this.distillLessonsFallback(inputs));
  }

  private async tryDistillWithLLM(inputs: RawInputData): Promise<DistilledLesson[]> {
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return [];
    }

    try {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({
        apiKey,
        baseURL: process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined,
      });

      const response = await client.chat.completions.create({
        model: process.env.OPENROUTER_API_KEY ? 'openai/gpt-4o-mini' : 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 1200,
        messages: [
          {
            role: 'system',
            content: [
              'You distill software execution artifacts into lessons.',
              'Return JSON only: {"lessons":[...]}',
              'Each lesson must include category, content, projectPath, sourceTaskId, confidence.',
              'Allowed category values: bug_pattern, architecture, convention, decision.',
              'Reject low-confidence lessons below 0.7 instead of inventing.',
            ].join(' '),
          },
          {
            role: 'user',
            content: this.formatInputsForPrompt(inputs),
          },
        ],
      });

      const raw = response.choices[0]?.message?.content?.trim();
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw) as { lessons?: DistilledLesson[] };
      if (!Array.isArray(parsed.lessons)) {
        return [];
      }
      return parsed.lessons
        .map((lesson) => this.normalizeLesson(lesson))
        .filter((lesson): lesson is DistilledLesson => lesson !== null);
    } catch (err) {
      log.warn({ err }, 'LLM distillation unavailable; using fallback');
      return [];
    }
  }

  private distillLessonsFallback(inputs: RawInputData): DistilledLesson[] {
    const lessons: DistilledLesson[] = [];
    const projectPath = process.cwd();
    const extractionPatterns: Array<{
      category: DistilledLesson['category'];
      regex: RegExp;
      confidence: number;
    }> = [
      { category: 'decision', regex: /(?:결정|decided|chose|선택|approach|tradeoff)[:：]\s*(.+)/gi, confidence: 0.78 },
      { category: 'bug_pattern', regex: /(?:fix|bug|버그|원인|root cause|해결)[:：]\s*(.+)/gi, confidence: 0.8 },
      { category: 'convention', regex: /(?:rule|guideline|convention|규칙|컨벤션|권장 개선사항)[:：]\s*(.+)/gi, confidence: 0.75 },
      { category: 'architecture', regex: /(?:architecture|design|structure|설계|아키텍처)[:：]\s*(.+)/gi, confidence: 0.76 },
    ];

    for (const task of inputs.tasks) {
      const body = `${task.prompt}\n${task.response}`;
      for (const pattern of extractionPatterns) {
        for (const match of body.matchAll(pattern.regex)) {
          const content = this.cleanLessonText(match[1] ?? '');
          if (!content) {
            continue;
          }
          lessons.push({
            category: pattern.category,
            content,
            projectPath: task.workspaceId || projectPath,
            sourceTaskId: task.id,
            confidence: pattern.confidence,
          });
        }
      }
    }

    for (const note of inputs.notes) {
      for (const pattern of extractionPatterns) {
        for (const match of note.content.matchAll(pattern.regex)) {
          const content = this.cleanLessonText(match[1] ?? '');
          if (!content) {
            continue;
          }
          lessons.push({
            category: pattern.category,
            content,
            projectPath,
            confidence: pattern.confidence,
          });
        }
      }

      const recommendationLines = note.content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^\d+\.\s+/.test(line) || /^[-*]\s+/.test(line));
      for (const line of recommendationLines) {
        const content = this.cleanLessonText(line.replace(/^(\d+\.\s+|[-*]\s+)/, ''));
        if (!content) {
          continue;
        }
        lessons.push({
          category: 'convention',
          content,
          projectPath,
          confidence: 0.72,
        });
      }
    }

    for (const row of inputs.logs) {
      if (!row.message) {
        continue;
      }
      const content = this.cleanLessonText(`Observed ${row.level} log: ${row.message}`);
      if (!content) {
        continue;
      }
      lessons.push({
        category: 'bug_pattern',
        content,
        projectPath,
        sourceTaskId: this.extractTaskIdFromContext(row.contextJson),
        confidence: row.level === 'error' || row.level === 'fatal' ? 0.74 : 0.7,
      });
    }

    return lessons;
  }

  private async mergeAndSaveLessons(lessons: DistilledLesson[]): Promise<number> {
    let saved = 0;

    for (const lesson of lessons) {
      const result = await knowledgeBase.upsertDistilledLesson({
        projectPath: lesson.projectPath,
        category: lesson.category,
        content: lesson.content,
        sourceTaskId: lesson.sourceTaskId,
        confidence: lesson.confidence,
      });
      if (result.action === 'inserted' || result.action === 'merged') {
        saved++;
      }
    }

    return saved;
  }

  private sanitizeAndTruncate(text: string): string {
    const sanitized = text
      .replace(/\b(?:sk-|pk_live_|pk_test_)[A-Za-z0-9_-]+\b/g, '[REDACTED_TOKEN]')
      .replace(/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s'"]+/gi, '$1=[REDACTED]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]');

    if (sanitized.length <= MAX_TEXT_CHARS) {
      return sanitized;
    }

    const head = sanitized.slice(0, MAX_TEXT_CHARS / 2);
    const tail = sanitized.slice(-MAX_TEXT_CHARS / 2);
    return `${head}\n...[truncated]...\n${tail}`;
  }

  private formatInputsForPrompt(inputs: RawInputData): string {
    return [
      '# Completed tasks',
      ...inputs.tasks.map((task) => [
        `## Task ${task.id}`,
        `workspace: ${task.workspaceId}`,
        `completedAt: ${task.completedAt}`,
        `prompt:\n${task.prompt}`,
        `response:\n${task.response}`,
      ].join('\n')),
      '# Improvement notes',
      ...inputs.notes.map((note) => [
        `## ${note.filename}`,
        `mtime: ${note.mtime}`,
        note.content,
      ].join('\n')),
      '# Logs',
      ...inputs.logs.map((row) => [
        `## ${row.id}`,
        `timestamp: ${row.timestamp}`,
        `level: ${row.level}`,
        row.message,
        row.contextJson ? `context: ${row.contextJson}` : '',
      ].filter(Boolean).join('\n')),
    ].join('\n\n');
  }

  private normalizeLesson(lesson: DistilledLesson): DistilledLesson | null {
    if (!lesson || typeof lesson.content !== 'string' || typeof lesson.projectPath !== 'string') {
      return null;
    }
    if (!['bug_pattern', 'architecture', 'convention', 'decision'].includes(lesson.category)) {
      return null;
    }
    const content = this.cleanLessonText(lesson.content);
    if (!content) {
      return null;
    }
    return {
      category: lesson.category,
      content,
      projectPath: lesson.projectPath || process.cwd(),
      sourceTaskId: lesson.sourceTaskId,
      confidence: Number.isFinite(lesson.confidence) ? lesson.confidence : 0.7,
    };
  }

  private dedupeLessons(lessons: DistilledLesson[]): DistilledLesson[] {
    const seen = new Map<string, DistilledLesson>();
    for (const lesson of lessons) {
      const normalized = this.normalizeLesson(lesson);
      if (!normalized || normalized.confidence < 0.7) {
        continue;
      }
      const key = `${normalized.category}:${normalized.projectPath}:${normalized.content.trim().toLowerCase()}`;
      const existing = seen.get(key);
      if (!existing || normalized.confidence > existing.confidence) {
        seen.set(key, normalized);
      }
    }
    return Array.from(seen.values());
  }

  private cleanLessonText(text: string): string {
    return this.sanitizeAndTruncate(text)
      .replace(/\s+/g, ' ')
      .replace(/^[|#>*\-\d.\s]+/, '')
      .trim()
      .slice(0, 1000);
  }

  private extractTaskIdFromContext(contextJson?: string): string | undefined {
    if (!contextJson) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(contextJson) as { taskId?: string; task_id?: string };
      return parsed.taskId ?? parsed.task_id;
    } catch {
      return undefined;
    }
  }

  private insertConsolidationLog(
    level: 'info' | 'warn' | 'error',
    message: string,
    context: Record<string, unknown>,
    status: string,
  ): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO logs (id, level, category, message, context_json, status)
        VALUES (?, ?, 'sleep-consolidator', ?, ?, ?)
      `).run(
        createId('log'),
        level,
        message,
        JSON.stringify(context),
        status,
      );
    } catch (err) {
      log.warn({ err, message }, 'Failed to persist sleep consolidator log');
    }
  }
}

export const sleepConsolidator = new SleepConsolidator();
