/**
 * VectorMemory — HNSW-backed semantic long-term memory for NCO agents.
 *
 * Architecture:
 *   SQLite  → raw text + metadata (durable, cross-session)
 *   HNSW    → 1536-dim float32 vectors (fast ANN, persisted to disk)
 *   Embed   → OpenRouter text-embedding-3-small (primary) / TF-IDF hash (fallback)
 *
 * Key properties:
 *   - O(log n) retrieval at any scale (HNSW graph traversal)
 *   - Disk-persisted index survives NCO restarts
 *   - Fallback TF-IDF works offline with no API key
 *   - Thread-safe: single writer, multiple readers via SQLite WAL
 */

import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';
import { env } from '../utils/config.js';

const log = createLogger('vector-memory');

// ── Constants ────────────────────────────────────────────────────────────────
const EMBED_DIM = 1536;          // text-embedding-3-small dimension
const HNSW_M = 16;               // HNSW graph connectivity (16 = balanced)
const HNSW_EF = 200;             // ef_construction: build quality
const HNSW_EF_SEARCH = 50;       // ef search: recall/speed tradeoff
const INDEX_DIR = join(env.ROOT, 'db', 'hnsw-indices');
// initIndex는 MAX_ELEMENTS × EMBED_DIM × 4B를 선할당한다 (1M × 1536 × 4B ≈ 6.1GB/agent).
// 저사양 머신(subnote 3.7GB)에서 C++ std::runtime_error(Not enough memory)로 프로세스가
// 통째로 죽으므로 env로 조절 가능해야 한다. NCO_VECTOR_MEMORY_DISABLED=1이면 아예 비활성.
const MAX_ELEMENTS = Math.max(1_000, Number(process.env.NCO_HNSW_MAX_ELEMENTS ?? 1_000_000));
const VECTOR_MEMORY_DISABLED = process.env.NCO_VECTOR_MEMORY_DISABLED === '1';

// ── Lazy HNSW module ─────────────────────────────────────────────────────────
let _HierarchicalNSW: any = null;
async function getHierarchicalNSW() {
  if (!_HierarchicalNSW) {
    const m = await import('hnswlib-node');
    // hnswlib-node exports via default or module.exports
    const lib = (m as any).default ?? (m as any)['module.exports'] ?? m;
    _HierarchicalNSW = lib.HierarchicalNSW;
  }
  return _HierarchicalNSW;
}

// ── Per-agent HNSW index cache ────────────────────────────────────────────────
const indexCache = new Map<string, any>();
const indexDirty = new Map<string, boolean>();

function indexPath(agentId: string): string {
  return join(INDEX_DIR, `${agentId}.hnsw`);
}

async function createEmptyIndex(): Promise<any> {
  const HierarchicalNSW = await getHierarchicalNSW();
  const idx = new HierarchicalNSW('cosine', EMBED_DIM);
  idx.initIndex(MAX_ELEMENTS, HNSW_M, HNSW_EF);
  idx.setEf(HNSW_EF_SEARCH);
  return idx;
}

async function getOrCreateIndex(agentId: string): Promise<any> {
  if (indexCache.has(agentId)) return indexCache.get(agentId)!;

  mkdirSync(INDEX_DIR, { recursive: true });
  const idx = await createEmptyIndex();
  const path = indexPath(agentId);

  if (existsSync(path)) {
    try {
      idx.readIndexSync(path, false);
      try {
        const currentMaxElements = idx.getMaxElements();
        if (currentMaxElements > MAX_ELEMENTS) {
          const resizedMaxElements = Math.max(MAX_ELEMENTS, idx.getCurrentCount());
          idx.resizeIndex(resizedMaxElements);
          indexDirty.set(agentId, true);
          log.info(
            { agentId, from: currentMaxElements, to: resizedMaxElements },
            'HNSW index max_elements reduced after load',
          );
        }
      } catch (error) {
        log.warn({ agentId, err: error }, 'HNSW index resize after load failed; using loaded index as-is');
      }
      log.info({ agentId, path, count: idx.getCurrentCount() }, 'HNSW index loaded from disk');
    } catch {
      log.warn({ agentId }, 'HNSW index corrupt — reinitialised');
    }
  }

  indexCache.set(agentId, idx);
  return idx;
}

async function persistIndex(agentId: string): Promise<void> {
  const idx = indexCache.get(agentId);
  if (!idx || !indexDirty.get(agentId)) return;
  mkdirSync(INDEX_DIR, { recursive: true });
  idx.writeIndexSync(indexPath(agentId));
  indexDirty.set(agentId, false);
  log.debug({ agentId }, 'HNSW index persisted to disk');
}

// ── Embedding ────────────────────────────────────────────────────────────────

/** Real semantic embedding via OpenRouter (text-embedding-3-small, 1536-dim) */
async function embedOpenRouter(text: string): Promise<number[] | null> {
  const keys = process.env.OPENROUTER_API_KEYS || process.env.OPENROUTER_API_KEY || '';
  const apiKey = keys.split(',')[0]?.trim();
  if (!apiKey) return null;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/text-embedding-3-small',
        input: [text.slice(0, 8192)],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data?.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

/**
 * Offline fallback: deterministic TF-IDF-style sparse hash → dense 1536-dim vector.
 * No API needed. Provides reasonable keyword-overlap similarity.
 */
function embedFallback(text: string): number[] {
  const vec = new Float32Array(EMBED_DIM).fill(0);
  const tokens = text.toLowerCase().split(/\W+/).filter(t => t.length > 1);

  for (const token of tokens) {
    // djb2 hash → bucket mod EMBED_DIM
    let h = 5381;
    for (let i = 0; i < token.length; i++) h = ((h << 5) + h) ^ token.charCodeAt(i);
    const idx = Math.abs(h) % EMBED_DIM;
    vec[idx] += 1;

    // Bigram for basic phrase similarity
    if (token.length > 3) {
      let h2 = 0;
      for (let i = 0; i < token.length - 1; i++) {
        h2 = (h2 * 31 + token.charCodeAt(i) * 37 + token.charCodeAt(i + 1)) | 0;
      }
      vec[Math.abs(h2) % EMBED_DIM] += 0.5;
    }
  }

  // L2 normalise → unit sphere for cosine similarity
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec).map(v => v / norm);
}

async function embed(text: string): Promise<{ vector: number[]; semantic: boolean }> {
  const v = await embedOpenRouter(text);
  if (v) return { vector: v, semantic: true };
  return { vector: embedFallback(text), semantic: false };
}

// ── SQLite schema ────────────────────────────────────────────────────────────
function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS mem0_entries (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      embedded INTEGER NOT NULL DEFAULT 0,
      semantic INTEGER NOT NULL DEFAULT 0,
      hnsw_label INTEGER,
      importance REAL NOT NULL DEFAULT 1.0,
      access_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mem0_agent ON mem0_entries(agent_id);
  `);

  // Migrate: add new columns if they don't exist yet
  const cols = (db.prepare("PRAGMA table_info(mem0_entries)").all() as any[]).map((c: any) => c.name);
  for (const [col, def] of [
    ['semantic', 'INTEGER NOT NULL DEFAULT 0'],
    ['hnsw_label', 'INTEGER'],
    ['importance', 'REAL NOT NULL DEFAULT 1.0'],
    ['access_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_accessed', 'TEXT'],
  ] as [string, string][]) {
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE mem0_entries ADD COLUMN ${col} ${def}`);
    }
  }

  // Create hnsw_label index AFTER migration (column must exist first)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mem0_label ON mem0_entries(agent_id, hnsw_label)`);
}

// ── Public API ───────────────────────────────────────────────────────────────
export interface VectorMemoryEntry {
  id: string;
  agentId: string;
  content: string;
  score: number;
  semantic: boolean;
  importance: number;
  accessCount: number;
  createdAt: string;
}

class VectorMemoryService {

  /** Add a new memory entry. Embeds and indexes automatically. */
  async add(agentId: string, content: string, importance = 1.0): Promise<string> {
    if (VECTOR_MEMORY_DISABLED) return '';
    ensureTable();
    const db = getDb();
    const { vector, semantic } = await embed(content);
    const idx = await getOrCreateIndex(agentId);

    const label = idx.getCurrentCount();
    const id = `mem0-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO mem0_entries (id, agent_id, content, embedded, semantic, hnsw_label, importance, created_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)
    `).run(id, agentId, content, semantic ? 1 : 0, label, importance, now);

    try {
      idx.addPoint(vector, label);
      indexDirty.set(agentId, true);
    } catch (error) {
      db.prepare('DELETE FROM mem0_entries WHERE id = ?').run(id);
      throw error;
    }

    // Async persist (non-blocking)
    setImmediate(() => persistIndex(agentId).catch(() => {}));

    log.debug({ id, agentId, semantic, label }, 'memory added');
    return id;
  }

  /** Search: HNSW ANN → top-k results ranked by score × importance */
  async search(agentId: string, query: string, k = 5): Promise<VectorMemoryEntry[]> {
    if (VECTOR_MEMORY_DISABLED) return [];
    ensureTable();
    const db = getDb();
    const idx = await getOrCreateIndex(agentId);
    const count = idx.getCurrentCount();

    if (count === 0) return [];

    const { vector, semantic } = await embed(query);
    const actualK = Math.min(k * 3, count); // over-fetch then re-rank
    const result = idx.searchKnn(vector, actualK);

    const labels: number[] = result.neighbors;
    const distances: number[] = result.distances;

    const rows = db.prepare(`
      SELECT id, agent_id, content, semantic, hnsw_label, importance, access_count, created_at
      FROM mem0_entries
      WHERE agent_id = ? AND hnsw_label IN (${labels.map(() => '?').join(',')})
    `).all(agentId, ...labels) as any[];

    const rowByLabel = new Map(rows.map((r: any) => [r.hnsw_label, r]));

    const results = labels.map((label, i) => {
      const row = rowByLabel.get(label);
      if (!row) return null;
      // cosine distance → similarity score (0-1), weighted by importance
      const similarity = 1 - distances[i];
      const score = similarity * row.importance;
      return {
        id: row.id,
        agentId: row.agent_id,
        content: row.content,
        score,
        semantic: row.semantic === 1,
        importance: row.importance,
        accessCount: row.access_count,
        createdAt: row.created_at,
      } as VectorMemoryEntry;
    }).filter(Boolean) as VectorMemoryEntry[];

    // Update access stats
    if (results.length > 0) {
      const ids = results.slice(0, k).map(r => r.id);
      db.prepare(`
        UPDATE mem0_entries
        SET access_count = access_count + 1, last_accessed = datetime('now')
        WHERE id IN (${ids.map(() => '?').join(',')})
      `).run(...ids);
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** List all memories for an agent (newest first) */
  list(agentId: string, limit = 100): VectorMemoryEntry[] {
    ensureTable();
    const db = getDb();
    return (db.prepare(`
      SELECT id, agent_id, content, semantic, importance, access_count, created_at
      FROM mem0_entries WHERE agent_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(agentId, limit) as any[]).map(r => ({
      id: r.id, agentId: r.agent_id, content: r.content,
      score: r.importance, semantic: r.semantic === 1,
      importance: r.importance, accessCount: r.access_count, createdAt: r.created_at,
    }));
  }

  /** Delete all memories for an agent (also resets HNSW index) */
  async delete(agentId: string): Promise<number> {
    ensureTable();
    const db = getDb();
    const info = db.prepare('DELETE FROM mem0_entries WHERE agent_id = ?').run(agentId);
    // Reset HNSW index
    indexCache.delete(agentId);
    indexDirty.delete(agentId);
    const path = indexPath(agentId);
    if (existsSync(path)) {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(path);
    }
    return info.changes;
  }

  /** Stats for an agent's memory */
  stats(agentId: string) {
    ensureTable();
    const db = getDb();
    const row = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN semantic=1 THEN 1 ELSE 0 END) as semantic_count,
             AVG(importance) as avg_importance,
             MAX(created_at) as latest,
             SUM(access_count) as total_accesses
      FROM mem0_entries WHERE agent_id = ?
    `).get(agentId) as any;
    const indexLoaded = indexCache.has(agentId);
    return { agentId, ...row, indexLoaded, indexPath: indexPath(agentId) };
  }

  /** Rebuild HNSW index from SQLite (recovery / index corruption) */
  async rebuildIndex(agentId: string): Promise<number> {
    if (VECTOR_MEMORY_DISABLED) return 0;
    ensureTable();
    const db = getDb();
    const idx = await createEmptyIndex();
    indexCache.set(agentId, idx);
    const rows = db.prepare(`
      SELECT id, content, hnsw_label FROM mem0_entries WHERE agent_id = ? ORDER BY hnsw_label
    `).all(agentId) as any[];

    let rebuilt = 0;
    for (const row of rows) {
      const { vector } = await embed(row.content);
      const label = row.hnsw_label ?? rebuilt;
      try { idx.addPoint(vector, label); rebuilt++; } catch { /* skip dups */ }
    }

    indexDirty.set(agentId, true);
    await persistIndex(agentId);
    log.info({ agentId, rebuilt }, 'HNSW index rebuilt');
    return rebuilt;
  }

  /** Flush all dirty indices to disk */
  async flushAll(): Promise<void> {
    for (const agentId of indexCache.keys()) {
      await persistIndex(agentId);
    }
  }
}

export const vectorMemory = new VectorMemoryService();
