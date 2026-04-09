import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('knowledge-base');

export interface KnowledgeEntry {
  id?: string;
  projectPath: string;
  category: 'bug_pattern' | 'architecture' | 'convention' | 'decision';
  content: string;
  sourceTaskId?: string;
  sourceDiscussionId?: string;
  confidence?: number;
}

class KnowledgeBase {
  /**
   * Save a knowledge entry.
   */
  save(entry: KnowledgeEntry): string {
    const id = entry.id || createId('kb');
    const db = getDb();
    db.prepare(`
      INSERT INTO knowledge_base (id, project_path, category, content, source_task_id, source_discussion_id, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      entry.projectPath,
      entry.category,
      entry.content,
      entry.sourceTaskId || null,
      entry.sourceDiscussionId || null,
      entry.confidence ?? 0.8,
    );
    log.info({ id, category: entry.category }, 'Knowledge saved');
    return id;
  }

  /**
   * Query knowledge by keywords and optional project path.
   */
  query(keywords: string, projectPath?: string, limit = 10): any[] {
    const db = getDb();
    const terms = keywords.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    // Build LIKE conditions for each term
    const conditions = terms.map(() => 'content LIKE ?').join(' AND ');
    const params = terms.map(t => `%${t}%`);

    let sql = `SELECT * FROM knowledge_base WHERE ${conditions}`;
    if (projectPath) {
      sql += ' AND project_path = ?';
      params.push(projectPath);
    }
    sql += ' ORDER BY confidence DESC, used_count DESC LIMIT ?';
    params.push(String(limit));

    const results = db.prepare(sql).all(...params) as any[];

    // Increment used_count for returned results
    const updateStmt = db.prepare('UPDATE knowledge_base SET used_count = used_count + 1 WHERE id = ?');
    for (const r of results) {
      updateStmt.run(r.id);
    }

    return results;
  }

  /**
   * Get context for a project — top N most used/confident entries.
   */
  getContext(projectPath: string, limit = 5): any[] {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM knowledge_base
      WHERE project_path = ?
      ORDER BY used_count DESC, confidence DESC
      LIMIT ?
    `).all(projectPath, limit);
  }

  /**
   * Auto-extract knowledge from a task result.
   * Looks for patterns like decisions, conventions, bug fixes.
   */
  extractFromTaskResult(taskId: string, output: string, projectPath: string): number {
    let saved = 0;

    // Extract decisions (lines with "결정:", "decided:", "chose:", etc.)
    const decisionPatterns = /(?:결정|decided|chose|선택|approach|방향)[:：]\s*(.+)/gi;
    for (const match of output.matchAll(decisionPatterns)) {
      this.save({
        projectPath,
        category: 'decision',
        content: match[1].trim(),
        sourceTaskId: taskId,
        confidence: 0.7,
      });
      saved++;
    }

    // Extract bug patterns (lines with "fix:", "버그:", "원인:", etc.)
    const bugPatterns = /(?:fix|버그|원인|cause|root cause|해결)[:：]\s*(.+)/gi;
    for (const match of output.matchAll(bugPatterns)) {
      this.save({
        projectPath,
        category: 'bug_pattern',
        content: match[1].trim(),
        sourceTaskId: taskId,
        confidence: 0.6,
      });
      saved++;
    }

    if (saved > 0) {
      log.info({ taskId, saved }, 'Knowledge auto-extracted');
    }

    return saved;
  }
}

export const knowledgeBase = new KnowledgeBase();
