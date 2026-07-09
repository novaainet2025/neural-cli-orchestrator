/**
 * NCO Semantic Memory — Mithosis-surpass: 자연어 유사도 검색 메모리
 *
 * 벡터DB 없이 SQLite + TF-IDF 유사도로 구현.
 * 과거 에이전트 결과를 저장하고 유사 쿼리 시 자동으로 컨텍스트를 주입한다.
 *
 * 미쏘스 대비 차별점:
 *   - SQLite 내장 (외부 벡터DB 의존 없음, 즉시 사용)
 *   - 중요도 decay: 오래된 메모리 자동 감가
 *   - 에이전트별 메모리 분리 가능
 */

import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('semantic-memory');

export interface MemoryEntry {
  id: string;
  content: string;
  summary: string;
  tags: string[];
  sourceAgent?: string;
  taskType: string;
  importance: number;
  accessCount: number;
  createdAt: string;
}

// ── TF-IDF 기반 키워드 벡터 추출 ─────────────────────────────────────
function extractKeywords(text: string): Array<{ word: string; freq: number }> {
  const stopWords = new Set(['the','a','an','is','it','this','that','to','of','in','for','and','or','be','has','have','are','was','with','by','from','on','at']);
  const words = text.toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  const freq: Record<string, number> = {};
  for (const w of words) freq[w] = (freq[w] ?? 0) + 1;

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([word, f]) => ({ word, freq: f }));
}

// ── 코사인 유사도 (키워드 벡터 기반) ─────────────────────────────────
function cosineSimilarity(
  vecA: Array<{ word: string; freq: number }>,
  vecB: Array<{ word: string; freq: number }>,
): number {
  const mapA: Record<string, number> = {};
  const mapB: Record<string, number> = {};
  for (const { word, freq } of vecA) mapA[word] = freq;
  for (const { word, freq } of vecB) mapB[word] = freq;

  const allWords = new Set([...Object.keys(mapA), ...Object.keys(mapB)]);
  let dotProduct = 0, normA = 0, normB = 0;
  for (const w of allWords) {
    const a = mapA[w] ?? 0;
    const b = mapB[w] ?? 0;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

class SemanticMemory {
  private readonly decayFactor = 0.95; // 일별 중요도 감가
  private readonly maxMemories = 10000;

  /**
   * 메모리 저장
   */
  store(params: {
    content: string;
    summary?: string;
    tags?: string[];
    sourceAgent?: string;
    taskType?: string;
    importance?: number;
  }): string {
    const db = getDb();
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const keywords = extractKeywords(params.content);
    const summary = params.summary ?? params.content.slice(0, 100).replace(/\n/g, ' ');

    db.prepare(
      `INSERT INTO semantic_memory (id, content, summary, tags, source_agent, task_type, keyword_vector, importance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.content,
      summary,
      JSON.stringify(params.tags ?? []),
      params.sourceAgent ?? null,
      params.taskType ?? 'general',
      JSON.stringify(keywords),
      params.importance ?? 0.5,
    );

    // 용량 초과 시 오래된 메모리 삭제
    const count = (db.prepare('SELECT COUNT(*) as c FROM semantic_memory').get() as any).c;
    if (count > this.maxMemories) {
      db.prepare(
        `DELETE FROM semantic_memory WHERE id IN (
           SELECT id FROM semantic_memory ORDER BY importance ASC, last_accessed ASC LIMIT ?
         )`
      ).run(count - this.maxMemories);
    }

    log.debug({ id, taskType: params.taskType, keywords: keywords.length }, 'Memory stored');
    return id;
  }

  /**
   * 유사 메모리 검색 (코사인 유사도 기반)
   */
  search(query: string, options: {
    taskType?: string;
    limit?: number;
    minSimilarity?: number;
    sourceAgent?: string;
  } = {}): Array<MemoryEntry & { similarity: number }> {
    const db = getDb();
    const limit = options.limit ?? 5;
    const minSim = options.minSimilarity ?? 0.15;
    const queryVec = extractKeywords(query);

    let sql = `SELECT * FROM semantic_memory WHERE 1=1`;
    const params: any[] = [];
    if (options.taskType) { sql += ` AND task_type=?`; params.push(options.taskType); }
    if (options.sourceAgent) { sql += ` AND source_agent=?`; params.push(options.sourceAgent); }
    sql += ` ORDER BY importance DESC, last_accessed DESC LIMIT 200`;

    const rows = db.prepare(sql).all(...params) as any[];

    // 코사인 유사도 계산
    const scored = rows
      .map(row => {
        let vec: Array<{ word: string; freq: number }> = [];
        try { vec = JSON.parse(row.keyword_vector ?? '[]'); } catch { /* */ }
        const similarity = cosineSimilarity(queryVec, vec);
        return { row, similarity };
      })
      .filter(({ similarity }) => similarity >= minSim)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    // 접근 카운터 갱신
    for (const { row } of scored) {
      db.prepare(`UPDATE semantic_memory SET access_count=access_count+1, last_accessed=datetime('now') WHERE id=?`).run(row.id);
    }

    return scored.map(({ row, similarity }) => ({
      id: row.id,
      content: row.content,
      summary: row.summary,
      tags: JSON.parse(row.tags ?? '[]'),
      sourceAgent: row.source_agent,
      taskType: row.task_type,
      importance: row.importance,
      accessCount: row.access_count,
      createdAt: row.created_at,
      similarity,
    }));
  }

  /**
   * 검색 결과를 프롬프트 컨텍스트 문자열로 변환
   */
  buildContext(query: string, options: { taskType?: string; limit?: number } = {}): string {
    const memories = this.search(query, { ...options, limit: options.limit ?? 3 });
    if (memories.length === 0) return '';

    const parts = memories.map((m, i) =>
      `[관련 기억 ${i + 1}] (유사도: ${(m.similarity * 100).toFixed(0)}%, 출처: ${m.sourceAgent ?? 'unknown'})\n${m.summary}`
    );
    return `\n\n[시맨틱 메모리 컨텍스트]\n${parts.join('\n\n')}\n`;
  }

  /**
   * 중요도 decay 적용 (배치 작업용 — 하루 1회 권장)
   */
  applyDecay(): void {
    const db = getDb();
    db.prepare(
      `UPDATE semantic_memory SET importance = importance * ? WHERE importance > 0.05`
    ).run(this.decayFactor);
    db.prepare(`DELETE FROM semantic_memory WHERE importance < 0.05`).run();
    log.info('Semantic memory decay applied');
  }

  getStats(): { total: number; byTaskType: Record<string, number> } {
    const db = getDb();
    const total = (db.prepare('SELECT COUNT(*) as c FROM semantic_memory').get() as any).c;
    const byType = db.prepare(
      `SELECT task_type, COUNT(*) as c FROM semantic_memory GROUP BY task_type`
    ).all() as any[];
    const byTaskType: Record<string, number> = {};
    for (const r of byType) byTaskType[r.task_type] = r.c;
    return { total, byTaskType };
  }
}

export const semanticMemory = new SemanticMemory();
