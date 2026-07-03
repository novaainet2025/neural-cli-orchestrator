import { createHash } from 'crypto';
import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('knowledge-base');

// ─── Embedding Service — ollama nomic-embed-text (primary) or legacy 6270 ────
const OLLAMA_EMBED_URL = 'http://localhost:11434/api/embed';
const LEGACY_EMBED_URL = 'http://localhost:6270/embed';
const EMBED_MODEL = 'nomic-embed-text';

async function fetchEmbedding(text: string): Promise<number[] | null> {
  // 1) Try ollama (primary — nomic-embed-text 768dim)
  try {
    const res = await fetch(OLLAMA_EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: text }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json() as { embeddings?: number[][] };
      if (Array.isArray(data.embeddings?.[0])) return data.embeddings![0];
    }
  } catch { /* fallthrough */ }

  // 2) Legacy embed service at 6270
  try {
    const res = await fetch(LEGACY_EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json() as { embedding?: number[] };
      if (Array.isArray(data.embedding)) return data.embedding;
    }
  } catch { /* fallthrough */ }

  return null; // both unavailable — fall back to lexical
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface KnowledgeEntry {
  id?: string;
  projectPath: string;
  category: 'bug_pattern' | 'architecture' | 'convention' | 'decision' | 'obsidian';
  content: string;
  sourceTaskId?: string;
  sourceDiscussionId?: string;
  confidence?: number;
}

class KnowledgeBase {
  isSelfImprovementAutoApplyEnabled(): boolean {
    return process.env.NCO_SELF_IMPROVEMENT_AUTO_APPLY === '1';
  }

  /**
   * Save a knowledge entry.
   */
  save(entry: KnowledgeEntry): string {
    const id = entry.id || createId('kb');
    const db = getDb();
    db.prepare(`
      INSERT INTO knowledge_base (id, project_path, category, content, source_task_id, source_discussion_id, confidence, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        project_path = excluded.project_path,
        category = excluded.category,
        content = excluded.content,
        source_task_id = excluded.source_task_id,
        source_discussion_id = excluded.source_discussion_id,
        confidence = excluded.confidence,
        updated_at = datetime('now')
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

    // Increment used_count and apply small confidence boost (feedback loop)
    const updateStmt = db.prepare('UPDATE knowledge_base SET used_count = used_count + 1, confidence = MIN(1.0, confidence + 0.01) WHERE id = ?');
    for (const r of results) {
      updateStmt.run(r.id);
    }

    return results;
  }

  /**
   * Query knowledge by category and optional keywords.
   */
  queryByCategory(category: string, keywords?: string, limit = 10): any[] {
    const db = getDb();
    const params: any[] = [category];
    let sql = 'SELECT * FROM knowledge_base WHERE category = ?';

    if (keywords) {
      const terms = keywords.split(/\s+/).filter(Boolean);
      if (terms.length > 0) {
        const conditions = terms.map(() => 'content LIKE ?').join(' AND ');
        sql += ` AND (${conditions})`;
        params.push(...terms.map(t => `%${t}%`));
      }
    }

    sql += ' ORDER BY updated_at DESC LIMIT ?';
    params.push(limit);

    const results = db.prepare(sql).all(...params) as any[];

    // Increment used_count
    const updateStmt = db.prepare('UPDATE knowledge_base SET used_count = used_count + 1 WHERE id = ?');
    for (const r of results) {
      updateStmt.run(r.id);
    }

    return results;
  }

  /**
   * Specifically search Obsidian notes, with optional semantic boost.
   */
  async queryObsidian(query: string, limit = 10): Promise<any[]> {
    // If no query, return recent ones
    if (!query || query.trim().length === 0) {
      return this.queryByCategory('obsidian', '', limit);
    }

    // Try semantic search first
    const similar = await this.findSimilarAsync(query, limit * 2);
    const filtered = similar.filter(e => e.category === 'obsidian');

    if (filtered.length > 0) {
      return filtered.slice(0, limit);
    }

    // Fallback to lexical
    return this.queryByCategory('obsidian', query, limit);
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
   * Semantic similarity search: uses embedding API (localhost:6270) when available,
   * falls back to Jaccard coefficient for lexical matching.
   */
  async findSimilarAsync(query: string, limit = 5): Promise<KnowledgeEntry[]> {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM knowledge_base').all() as Record<string, unknown>[];
    if (rows.length === 0) return [];

    const queryEmbedding = await fetchEmbedding(query);

    if (queryEmbedding) {
      // Embedding-based cosine similarity
      const scored: { row: Record<string, unknown>; sim: number }[] = [];
      for (const row of rows) {
        const stored = typeof row.embedding_json === 'string'
          ? (JSON.parse(row.embedding_json) as number[])
          : null;
        if (stored && stored.length === queryEmbedding.length) {
          scored.push({ row, sim: cosineSimilarity(queryEmbedding, stored) });
        } else {
          // No stored embedding — use Jaccard as fallback for this entry
          const content = typeof row.content === 'string' ? row.content : '';
          scored.push({ row, sim: this.jaccardSimilarity(this.tokenWordSet(query), this.tokenWordSet(content)) });
        }
      }
      scored.sort((a, b) => b.sim - a.sim);
      return scored.slice(0, limit).filter(s => s.sim > 0.1).map(s => this.rowToEntry(s.row));
    }

    // Fallback: lexical Jaccard
    return this.findSimilar(query, limit);
  }

  /**
   * Lexical similarity search without embeddings: token overlap via Jaccard coefficient
   * (lightweight stand-in for TF–IDF cosine on bag-of-words).
   */
  findSimilar(query: string, limit = 5): KnowledgeEntry[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM knowledge_base').all() as Record<string, unknown>[];
    const qSet = this.tokenWordSet(query);
    const scored: { row: Record<string, unknown>; sim: number }[] = [];
    for (const row of rows) {
      const content = typeof row.content === 'string' ? row.content : '';
      scored.push({ row, sim: this.jaccardSimilarity(qSet, this.tokenWordSet(content)) });
    }
    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, limit).map(s => this.rowToEntry(s.row));
  }

  /**
   * LLM-inspired category inference: multi-signal scoring across all categories.
   * Scores keyword density for each category and picks the winner.
   */
  inferCategory(content: string): KnowledgeEntry['category'] {
    const lower = content.toLowerCase();
    const scores: Record<KnowledgeEntry['category'], number> = {
      bug_pattern: 0,
      architecture: 0,
      convention: 0,
      decision: 0,
      obsidian: 0,
    };

    const patterns: Array<{ category: KnowledgeEntry['category']; terms: RegExp[] }> = [
      { category: 'bug_pattern', terms: [/\berror\b/, /\bfix\b/, /\bbug\b/, /\bcrash\b/, /\bfail\b/, /\bnull\b/, /\bundefined\b/, /\bexception\b/, /원인/, /수정/, /버그/] },
      { category: 'architecture', terms: [/\bdesign\b/, /\bstructure\b/, /\bpattern\b/, /\bmodule\b/, /\blayer\b/, /\bservice\b/, /\bcomponent\b/, /\binterface\b/, /아키텍처/, /설계/, /구조/] },
      { category: 'decision', terms: [/\bdecided\b/, /\bchose\b/, /\breason\b/, /\bapproach\b/, /\btradeoff\b/, /\bselected\b/, /결정/, /선택/, /방향/, /이유/] },
      { category: 'convention', terms: [/\bconvention\b/, /\bstandard\b/, /\bformat\b/, /\bstyle\b/, /\bnaming\b/, /\brule\b/, /\bguideline\b/, /규칙/, /컨벤션/, /형식/] },
      { category: 'obsidian', terms: [/\bvault\b/, /\bobsidian\b/, /\bnote\b/, /\btag\b/, /옵시디언/, /메모/, /지식/] },
    ];

    for (const { category, terms } of patterns) {
      for (const term of terms) {
        const matches = (lower.match(new RegExp(term.source, 'gi')) || []).length;
        scores[category] += matches;
      }
    }

    let best: KnowledgeEntry['category'] = 'convention';
    let bestScore = -1;
    for (const [cat, score] of Object.entries(scores) as Array<[KnowledgeEntry['category'], number]>) {
      if (score > bestScore) { bestScore = score; best = cat; }
    }
    return best;
  }

  /**
   * Save with optional embedding generation (async variant).
   */
  async saveWithEmbedding(entry: KnowledgeEntry): Promise<string> {
    const id = entry.id || createId('kb');
    const embedding = await fetchEmbedding(entry.content);
    const db = getDb();
    db.prepare(`
      INSERT INTO knowledge_base (id, project_path, category, content, source_task_id, source_discussion_id, confidence, embedding_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        project_path = excluded.project_path,
        category = excluded.category,
        content = excluded.content,
        source_task_id = excluded.source_task_id,
        source_discussion_id = excluded.source_discussion_id,
        confidence = excluded.confidence,
        embedding_json = COALESCE(excluded.embedding_json, knowledge_base.embedding_json),
        updated_at = datetime('now')
    `).run(
      id,
      entry.projectPath,
      entry.category,
      entry.content,
      entry.sourceTaskId || null,
      entry.sourceDiscussionId || null,
      entry.confidence ?? 0.8,
      embedding ? JSON.stringify(embedding) : null,
    );
    log.info({ id, category: entry.category, hasEmbedding: !!embedding }, 'Knowledge saved with embedding');
    return id;
  }

  async upsertDistilledLesson(
    entry: KnowledgeEntry,
    similarityThreshold = 0.85,
  ): Promise<{ action: 'inserted' | 'merged' | 'blocked'; id?: string; similarity?: number }> {
    if (!this.isSelfImprovementAutoApplyEnabled()) {
      return { action: 'blocked' };
    }

    const db = getDb();
    const exact = db.prepare(`
      SELECT * FROM knowledge_base
      WHERE project_path = ?
        AND category = ?
        AND lower(trim(content)) = lower(trim(?))
      LIMIT 1
    `).get(entry.projectPath, entry.category, entry.content) as Record<string, unknown> | undefined;

    if (exact) {
      const existing = this.rowToEntry(exact);
      const id = await this.saveWithEmbedding({
        ...existing,
        id: existing.id,
        confidence: Math.min(1, Math.max(existing.confidence ?? 0.8, entry.confidence ?? 0.8) + 0.02),
        sourceTaskId: entry.sourceTaskId ?? existing.sourceTaskId,
      });
      return { action: 'merged', id, similarity: 1 };
    }

    const candidates = await this.findSimilarAsync(entry.content, 5);
    let best: KnowledgeEntry | null = null;
    let bestSimilarity = 0;
    for (const candidate of candidates) {
      const similarity = this.contentSimilarity(entry.content, candidate.content);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        best = candidate;
      }
    }

    if (best?.id && bestSimilarity >= similarityThreshold) {
      const id = await this.saveWithEmbedding({
        ...best,
        id: best.id,
        category: entry.category,
        projectPath: entry.projectPath,
        content: this.mergeKnowledgeContent(best.content, entry.content),
        sourceTaskId: entry.sourceTaskId ?? best.sourceTaskId,
        confidence: Math.min(1, Math.max(best.confidence ?? 0.8, entry.confidence ?? 0.8) + 0.05),
      });
      return { action: 'merged', id, similarity: bestSimilarity };
    }

    const id = await this.saveWithEmbedding(entry);
    return { action: 'inserted', id, similarity: bestSimilarity };
  }

  removeObsidianFile(filePath: string): void {
    const id = `kb_obsidian_${createHash('md5').update(filePath).digest('hex').slice(0, 16)}`;
    const db = getDb();
    db.prepare('DELETE FROM knowledge_base WHERE id = ?').run(id);
    log.info({ id, filePath }, 'Obsidian knowledge removed');
  }

  /**
   * LLM-based category classification (async). Falls back to inferCategory() on error.
   * Uses OpenRouter API when available.
   */
  async inferCategoryAsync(content: string): Promise<KnowledgeEntry['category']> {
    try {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || 'dummy',
        baseURL: 'https://openrouter.ai/api/v1',
      });
      const res = await client.chat.completions.create({
        model: 'openai/gpt-4o-mini',
        max_tokens: 10,
        messages: [
          {
            role: 'system',
            content: 'Classify into exactly one: bug_pattern, architecture, convention, decision. Reply with the category name only.',
          },
          { role: 'user', content: content.slice(0, 300) },
        ],
      });
      const cat = res.choices[0]?.message?.content?.trim().toLowerCase() as KnowledgeEntry['category'];
      if (['bug_pattern', 'architecture', 'convention', 'decision'].includes(cat)) return cat;
    } catch { /* API unavailable — fall back to regex */ }
    return this.inferCategory(content);
  }

  updateConfidence(id: string, delta: number): void {
    const db = getDb();
    db.prepare(
      'UPDATE knowledge_base SET confidence = MIN(1.0, MAX(0.0, confidence + ?)) WHERE id = ?',
    ).run(delta, id);
  }

  private rowToEntry(row: Record<string, unknown>): KnowledgeEntry {
    return {
      id: typeof row.id === 'string' ? row.id : undefined,
      projectPath: String(row.project_path ?? ''),
      category: row.category as KnowledgeEntry['category'],
      content: String(row.content ?? ''),
      sourceTaskId: typeof row.source_task_id === 'string' ? row.source_task_id : undefined,
      sourceDiscussionId:
        typeof row.source_discussion_id === 'string' ? row.source_discussion_id : undefined,
      confidence: typeof row.confidence === 'number' ? row.confidence : undefined,
    };
  }

  private tokenWordSet(text: string): Set<string> {
    const words = text
      .toLowerCase()
      .split(/[^a-z0-9가-힣]+/)
      .filter(w => w.length > 0);
    return new Set(words);
  }

  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const w of a) {
      if (b.has(w)) inter++;
    }
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  private contentSimilarity(a: string, b: string): number {
    return this.jaccardSimilarity(this.tokenWordSet(a), this.tokenWordSet(b));
  }

  private mergeKnowledgeContent(existing: string, incoming: string): string {
    const normalizedExisting = existing.trim().toLowerCase();
    const normalizedIncoming = incoming.trim().toLowerCase();
    if (normalizedExisting === normalizedIncoming || normalizedExisting.includes(normalizedIncoming)) {
      return existing;
    }
    return `${existing}\n\nRelated lesson: ${incoming}`;
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

  /**
   * Index a markdown file from an Obsidian vault into the knowledge base.
   */
  async indexObsidianFile(filePath: string, content: string): Promise<string> {
    const category = await this.inferCategoryAsync(content);
    return this.saveWithEmbedding({
      projectPath: filePath,
      category,
      content: content.slice(0, 4000),
      confidence: 0.75,
    });
  }
}

export const knowledgeBase = new KnowledgeBase();
