/**
 * NCO mem0 Bridge — 에이전트별 장기 기억 레이어
 *
 * mem0ai (Apache-2.0, 51K⭐) 를 NCO에 이식.
 * - 에이전트별 대화/작업 맥락 영구 저장
 * - gbrain과 역할 분리: gbrain=지식그래프, mem0=에이전트 맥락 기억
 * - NO_EMBED 모드: 저사양 노드(snt/subnote)는 임베딩 생략, BM25 폴백
 * - 로컬 ollama 임베딩 우선 (nomic-embed-text 768dim)
 *
 * GitHub 이식 출처: mem0ai/mem0 (MIT-compatible) — 이식일 2026-06-30
 */

import { createLogger } from '../utils/logger.js';
import { getDb } from '../storage/database.js';

const log = createLogger('mem0-bridge');

// NO_EMBED mode: 저사양 머신 또는 ollama 미가용 시 BM25 전용
const NO_EMBED = process.env.NCO_MEM0_NO_EMBED === '1';
const OLLAMA_EMBED_URL = 'http://localhost:11434/api/embed';
const EMBED_MODEL = 'nomic-embed-text';

export interface Mem0Memory {
  id: string;
  agentId: string;
  userId?: string;
  content: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  score?: number;  // 검색 시 유사도 점수
}

export interface Mem0AddResult {
  id: string;
  stored: boolean;
  embedded: boolean;
}

export interface Mem0SearchResult {
  memories: Mem0Memory[];
  query: string;
  mode: 'semantic' | 'bm25';
}

// ──────────────────────────────────────────────────────────────────────────────
// DB 마이그레이션 (자동 실행)
// ──────────────────────────────────────────────────────────────────────────────

let _initialized = false;

function ensureSchema(): void {
  if (_initialized) return;
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS mem0_memories (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL,
      user_id    TEXT,
      content    TEXT NOT NULL,
      embedding  BLOB,             -- JSON array of floats, nullable
      metadata   TEXT,             -- JSON
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS mem0_agent_idx ON mem0_memories(agent_id);
    CREATE INDEX IF NOT EXISTS mem0_user_idx  ON mem0_memories(user_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS mem0_fts USING fts5(
      id UNINDEXED,
      agent_id UNINDEXED,
      content,
      content='mem0_memories',
      content_rowid='rowid'
    );
  `);

  // FTS sync trigger
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mem0_fts_insert AFTER INSERT ON mem0_memories BEGIN
      INSERT INTO mem0_fts(rowid, id, agent_id, content) VALUES (new.rowid, new.id, new.agent_id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS mem0_fts_update AFTER UPDATE ON mem0_memories BEGIN
      INSERT INTO mem0_fts(mem0_fts, rowid, id, agent_id, content) VALUES ('delete', old.rowid, old.id, old.agent_id, old.content);
      INSERT INTO mem0_fts(rowid, id, agent_id, content) VALUES (new.rowid, new.id, new.agent_id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS mem0_fts_delete AFTER DELETE ON mem0_memories BEGIN
      INSERT INTO mem0_fts(mem0_fts, rowid, id, agent_id, content) VALUES ('delete', old.rowid, old.id, old.agent_id, old.content);
    END;
  `);

  _initialized = true;
  log.info({ noEmbed: NO_EMBED }, 'mem0 schema initialized');
}

// ──────────────────────────────────────────────────────────────────────────────
// 임베딩
// ──────────────────────────────────────────────────────────────────────────────

async function embed(text: string): Promise<number[] | null> {
  if (NO_EMBED) return null;
  try {
    const res = await fetch(OLLAMA_EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { embeddings?: number[][] };
    return Array.isArray(data.embeddings?.[0]) ? data.embeddings![0] : null;
  } catch {
    return null;
  }
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/** 기억 저장 */
export async function mem0Add(opts: {
  agentId: string;
  content: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}): Promise<Mem0AddResult> {
  ensureSchema();
  const db = getDb();
  const id = `mem0-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const embedding = await embed(opts.content);

  db.prepare(`
    INSERT INTO mem0_memories (id, agent_id, user_id, content, embedding, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.agentId,
    opts.userId ?? null,
    opts.content,
    embedding ? JSON.stringify(embedding) : null,
    opts.metadata ? JSON.stringify(opts.metadata) : null,
  );

  log.debug({ id, agentId: opts.agentId, embedded: !!embedding }, 'mem0 stored');
  return { id, stored: true, embedded: !!embedding };
}

/** 기억 검색 (시맨틱 우선, 폴백 BM25) */
export async function mem0Search(opts: {
  agentId: string;
  query: string;
  limit?: number;
  userId?: string;
}): Promise<Mem0SearchResult> {
  ensureSchema();
  const db = getDb();
  const limit = opts.limit ?? 5;

  // 1) 시맨틱 검색 (임베딩 있을 때)
  if (!NO_EMBED) {
    const qEmbed = await embed(opts.query);
    if (qEmbed) {
      const whereClause = opts.userId
        ? 'WHERE agent_id = ? AND user_id = ? AND embedding IS NOT NULL'
        : 'WHERE agent_id = ? AND embedding IS NOT NULL';
      const params: unknown[] = opts.userId ? [opts.agentId, opts.userId] : [opts.agentId];

      const rows = db.prepare(`SELECT * FROM mem0_memories ${whereClause}`).all(...params) as Array<{
        id: string; agent_id: string; user_id: string | null;
        content: string; embedding: string | null; metadata: string | null;
        created_at: string; updated_at: string;
      }>;

      const scored = rows
        .map(r => ({ ...r, score: cosineSim(qEmbed, JSON.parse(r.embedding!)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (scored.length > 0) {
        return {
          query: opts.query,
          mode: 'semantic',
          memories: scored.map(r => ({
            id: r.id, agentId: r.agent_id, userId: r.user_id ?? undefined,
            content: r.content, metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
            createdAt: r.created_at, updatedAt: r.updated_at, score: r.score,
          })),
        };
      }
    }
  }

  // 2) BM25 전문 검색 (폴백 또는 NO_EMBED 모드)
  const ftsQuery = opts.query.split(/\s+/).filter(Boolean).map(w => `${w}*`).join(' ');
  const ftsWhere = opts.userId ? 'AND m.user_id = ?' : '';
  const ftsParams: unknown[] = opts.userId
    ? [opts.agentId, opts.userId, ftsQuery, limit]
    : [opts.agentId, ftsQuery, limit];

  const rows = db.prepare(`
    SELECT m.*, bm25(mem0_fts) AS score
    FROM mem0_fts f
    JOIN mem0_memories m ON m.id = f.id
    WHERE f.agent_id = ? ${ftsWhere} AND mem0_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `).all(...ftsParams) as Array<{
    id: string; agent_id: string; user_id: string | null;
    content: string; metadata: string | null;
    created_at: string; updated_at: string; score: number;
  }>;

  return {
    query: opts.query,
    mode: 'bm25',
    memories: rows.map(r => ({
      id: r.id, agentId: r.agent_id, userId: r.user_id ?? undefined,
      content: r.content, metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
      createdAt: r.created_at, updatedAt: r.updated_at, score: r.score,
    })),
  };
}

/** 기억 목록 (최신 순) */
export function mem0List(opts: {
  agentId: string;
  limit?: number;
  userId?: string;
}): Mem0Memory[] {
  ensureSchema();
  const db = getDb();
  const limit = opts.limit ?? 20;

  const whereClause = opts.userId ? 'WHERE agent_id = ? AND user_id = ?' : 'WHERE agent_id = ?';
  const params: unknown[] = opts.userId ? [opts.agentId, opts.userId, limit] : [opts.agentId, limit];

  const rows = db.prepare(`
    SELECT * FROM mem0_memories ${whereClause}
    ORDER BY updated_at DESC LIMIT ?
  `).all(...params) as Array<{
    id: string; agent_id: string; user_id: string | null;
    content: string; metadata: string | null;
    created_at: string; updated_at: string;
  }>;

  return rows.map(r => ({
    id: r.id, agentId: r.agent_id, userId: r.user_id ?? undefined,
    content: r.content, metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

/** 기억 삭제 */
export function mem0Delete(id: string, agentId: string): boolean {
  ensureSchema();
  const db = getDb();
  const info = db.prepare('DELETE FROM mem0_memories WHERE id = ? AND agent_id = ?').run(id, agentId);
  return info.changes > 0;
}

/** 에이전트 기억 전체 초기화 */
export function mem0Clear(agentId: string): number {
  ensureSchema();
  const db = getDb();
  const info = db.prepare('DELETE FROM mem0_memories WHERE agent_id = ?').run(agentId);
  return info.changes;
}

/** 기억 통계 */
export function mem0Stats(): { totalMemories: number; agents: Array<{ agentId: string; count: number }> } {
  ensureSchema();
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM mem0_memories').get() as { c: number }).c;
  const agents = db.prepare(`
    SELECT agent_id as agentId, COUNT(*) as count FROM mem0_memories GROUP BY agent_id ORDER BY count DESC
  `).all() as Array<{ agentId: string; count: number }>;
  return { totalMemories: total, agents };
}

// 싱글턴 편의 객체
export const mem0 = { add: mem0Add, search: mem0Search, list: mem0List, delete: mem0Delete, clear: mem0Clear, stats: mem0Stats };
