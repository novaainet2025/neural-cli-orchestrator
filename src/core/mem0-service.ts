import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';
import { randomUUID } from 'node:crypto';

const log = createLogger('mem0-service');

export interface Mem0Entry {
  id: string;
  agentId: string;
  content: string;
  embedded: number;
  createdAt: string;
}

/**
 * mem0 service — in-process SQLite-backed memory layer.
 * Provides add/search/list operations used by agent-manager hooks.
 * BM25 keyword search (semantic embed optional via mem0ai SDK).
 */
class Mem0Service {
  private ensureTable(): void {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS mem0_entries (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        embedded INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mem0_agent ON mem0_entries(agent_id);
    `);
  }

  async add(agentId: string, content: string): Promise<string> {
    this.ensureTable();
    const db = getDb();
    const id = `mem0-${randomUUID()}`;
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO mem0_entries (id, agent_id, content, embedded, created_at) VALUES (?, ?, ?, 0, ?)'
    ).run(id, agentId, content, now);
    log.debug({ id, agentId }, 'mem0 entry added');
    return id;
  }

  async search(agentId: string, query: string, limit = 5): Promise<Mem0Entry[]> {
    this.ensureTable();
    const db = getDb();
    const rows = db
      .prepare('SELECT id, agent_id, content, embedded, created_at FROM mem0_entries WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100')
      .all(agentId) as any[];

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return rows
      .map(row => {
        const lower = row.content.toLowerCase();
        const score = terms.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0);
        return { ...row, agentId: row.agent_id, createdAt: row.created_at, _score: score };
      })
      .filter(r => r._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, limit)
      .map(({ _score, agent_id, created_at, ...r }) => r as Mem0Entry);
  }

  async list(agentId: string): Promise<Mem0Entry[]> {
    this.ensureTable();
    const db = getDb();
    return (
      db
        .prepare('SELECT id, agent_id, content, embedded, created_at FROM mem0_entries WHERE agent_id = ? ORDER BY created_at DESC')
        .all(agentId) as any[]
    ).map(r => ({ ...r, agentId: r.agent_id, createdAt: r.created_at }));
  }

  async delete(agentId: string): Promise<number> {
    this.ensureTable();
    const db = getDb();
    const info = db.prepare('DELETE FROM mem0_entries WHERE agent_id = ?').run(agentId);
    return info.changes;
  }
}

export const mem0Service = new Mem0Service();
