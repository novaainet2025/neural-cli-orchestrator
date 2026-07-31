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
// 2026-07-31 스래싱 회귀 수정 (T1 실측).
// 이전 기본값 8 은 워킹셋을 전혀 담지 못했다. 캐시 키는 프로바이더뿐 아니라 **팀 단위**
// (`team:team_*`)라 실제 키 공간이 101개(팀 87 + 프로바이더/기타 14)다. 상한 8 이면
// 접근할 때마다 다른 인덱스를 밀어내고 다시 디스크에서 읽는다 —
// 운영 로그에서 `HNSW index loaded from disk` 45회 / `evicted from cache` 38회,
// 같은 초에 load↔evict 가 6회 교차하는 구간이 관측됐다.
// hnswlib 의 readIndexSync 는 동기 파일 I/O 라 그때마다 이벤트루프가 멈춘다.
//
// 인덱스 전량은 db/hnsw-indices 기준 101파일 / 85MB 이고 max_memory_restart 는 2G 이므로
// 전부 상주시켜도 예산 안이다. 스래싱 제거가 메모리 절약보다 이득이 크다.
// 워킹셋보다 넉넉하게 잡되, 저사양 머신은 NCO_HNSW_CACHE_MAX 로 낮출 수 있다(0=무제한).
const DEFAULT_INDEX_CACHE_MAX = 160;

function parseIndexCacheMax(rawValue: string | undefined): number {
  if (rawValue === undefined) return DEFAULT_INDEX_CACHE_MAX;
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    log.warn(
      { value: rawValue, fallback: DEFAULT_INDEX_CACHE_MAX },
      'Invalid NCO_HNSW_CACHE_MAX; using default',
    );
    return DEFAULT_INDEX_CACHE_MAX;
  }
  return parsed;
}

// 0 preserves the previous unbounded-cache behaviour.
const INDEX_CACHE_MAX = parseIndexCacheMax(process.env.NCO_HNSW_CACHE_MAX);

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
const indexLoads = new Map<string, Promise<{ index: any; dirty: boolean }>>();
let indexCacheEvictions = 0;

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

async function loadIndex(agentId: string): Promise<{ index: any; dirty: boolean }> {
  mkdirSync(INDEX_DIR, { recursive: true });
  const idx = await createEmptyIndex();
  const path = indexPath(agentId);
  let dirty = false;

  if (existsSync(path)) {
    try {
      idx.readIndexSync(path, false);
      try {
        const currentMaxElements = idx.getMaxElements();
        if (currentMaxElements > MAX_ELEMENTS) {
          const resizedMaxElements = Math.max(MAX_ELEMENTS, idx.getCurrentCount());
          idx.resizeIndex(resizedMaxElements);
          dirty = true;
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

  return { index: idx, dirty };
}

function getCachedIndex(agentId: string): any | undefined {
  const idx = indexCache.get(agentId);
  if (!idx) return undefined;
  // Map iteration order is the LRU order: oldest first, newest last.
  indexCache.delete(agentId);
  indexCache.set(agentId, idx);
  return idx;
}

function persistIndexSync(agentId: string): void {
  const idx = indexCache.get(agentId);
  if (!idx || !indexDirty.get(agentId)) return;
  mkdirSync(INDEX_DIR, { recursive: true });
  idx.writeIndexSync(indexPath(agentId));
  indexDirty.set(agentId, false);
  log.debug({ agentId }, 'HNSW index persisted to disk');
}

async function persistIndex(agentId: string): Promise<void> {
  persistIndexSync(agentId);
}

function evictLeastRecentlyUsed(): void {
  if (INDEX_CACHE_MAX === 0 || indexCache.size < INDEX_CACHE_MAX) return;

  const oldestAgentId = indexCache.keys().next().value as string | undefined;
  if (oldestAgentId === undefined) return;

  try {
    // Synchronous flush and deletion are deliberately atomic with respect to
    // the Node.js event loop. A failed write leaves both maps untouched.
    persistIndexSync(oldestAgentId);
  } catch (error) {
    log.error({ agentId: oldestAgentId, err: error }, 'HNSW cache eviction flush failed; eviction aborted');
    throw error;
  }

  indexCache.delete(oldestAgentId);
  indexDirty.delete(oldestAgentId);
  indexCacheEvictions++;
  log.info(
    { agentId: oldestAgentId, size: indexCache.size, max: INDEX_CACHE_MAX, evictions: indexCacheEvictions },
    'HNSW index evicted from cache',
  );
}

function cacheIndex(agentId: string, idx: any, dirty: boolean): void {
  const previous = indexCache.get(agentId);
  if (previous) {
    if (previous !== idx) {
      // Replacements (for example rebuildIndex) must not discard dirty state.
      persistIndexSync(agentId);
    }
    indexCache.delete(agentId);
  } else {
    evictLeastRecentlyUsed();
  }

  indexCache.set(agentId, idx);
  indexDirty.set(agentId, dirty);
}

function getIndexLoad(agentId: string): Promise<{ index: any; dirty: boolean }> {
  const pending = indexLoads.get(agentId);
  if (pending) return pending;

  const load = loadIndex(agentId);
  indexLoads.set(agentId, load);
  void load.then(
    () => {
      if (indexLoads.get(agentId) === load) indexLoads.delete(agentId);
    },
    () => {
      if (indexLoads.get(agentId) === load) indexLoads.delete(agentId);
    },
  );
  return load;
}

async function withIndex<T>(agentId: string, use: (idx: any) => T): Promise<T> {
  const cached = getCachedIndex(agentId);
  if (cached) return use(cached);

  const loaded = await getIndexLoad(agentId);
  // Another waiter may have cached the shared load first.
  const existing = getCachedIndex(agentId);
  const idx = existing ?? loaded.index;
  if (!existing) cacheIndex(agentId, idx, loaded.dirty);

  // The callback must remain synchronous so an eviction cannot interleave with
  // addPoint/searchKnn after the index is obtained.
  return use(idx);
}

export function getVectorIndexCacheStats(): {
  size: number;
  evictions: number;
  maxEntries: number;
} {
  return {
    size: indexCache.size,
    evictions: indexCacheEvictions,
    maxEntries: INDEX_CACHE_MAX,
  };
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
    return withIndex(agentId, idx => {
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
    });
  }

  /** Search: HNSW ANN → top-k results ranked by score × importance */
  async search(agentId: string, query: string, k = 5): Promise<VectorMemoryEntry[]> {
    if (VECTOR_MEMORY_DISABLED) return [];
    ensureTable();
    const db = getDb();
    const initialCount = await withIndex(agentId, idx => idx.getCurrentCount() as number);
    if (initialCount === 0) return [];

    const { vector } = await embed(query);
    return withIndex(agentId, idx => {
      const count = idx.getCurrentCount();
      if (count === 0) return [];

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
    });
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
    const pendingLoad = indexLoads.get(agentId);
    if (pendingLoad) {
      try { await pendingLoad; } catch { /* deletion does not depend on a failed load */ }
    }
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
    const rows = db.prepare(`
      SELECT id, content, hnsw_label FROM mem0_entries WHERE agent_id = ? ORDER BY hnsw_label
    `).all(agentId) as any[];

    let rebuilt = 0;
    for (const row of rows) {
      const { vector } = await embed(row.content);
      const label = row.hnsw_label ?? rebuilt;
      try { idx.addPoint(vector, label); rebuilt++; } catch { /* skip dups */ }
    }

    cacheIndex(agentId, idx, true);
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
