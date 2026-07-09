import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../storage/database.js';
import { createLogger } from '../../utils/logger.js';
import { randomUUID } from 'node:crypto';

const log = createLogger('mem0-routes');

/**
 * Register mem0 memory layer routes.
 *
 * POST   /api/mem0/:agentId/add      – store a memory entry (semantic embed optional)
 * POST   /api/mem0/:agentId/search   – search stored entries (semantic or BM25 fallback)
 * GET    /api/mem0/:agentId          – list all entries for an agent
 * DELETE /api/mem0/:agentId          – delete all entries for an agent (soft delete)
 */
export async function registerMem0Routes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // Ensure table exists (idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS mem0_entries (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      embedded INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // ── POST /api/mem0/:agentId/add ────────────────────────────────────────
  app.post('/api/mem0/:agentId/add', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const schema = z.object({
      content: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const { content } = parsed.data;

    // Determine embedding mode – env flag forces BM25 only
    const noEmbed = process.env.NCO_MEM0_NO_EMBED === '1';
    const embedded = noEmbed ? 0 : 1; // store as integer (0/1)

    const id = `mem0-${randomUUID()}`;
    const now = new Date().toISOString();
    db.prepare('INSERT INTO mem0_entries (id, agent_id, content, embedded, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, agentId, content, embedded, now);

    log.info({ id, agentId, embedded }, 'mem0 entry added');
    return reply.status(201).send({ stored: true, id, embedded: Boolean(embedded) });
  });

  // ── POST /api/mem0/:agentId/search ─────────────────────────────────────
  app.post('/api/mem0/:agentId/search', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const schema = z.object({
      query: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const { query } = parsed.data;

    const noEmbed = process.env.NCO_MEM0_NO_EMBED === '1';
    const mode = noEmbed ? 'bm25' : 'semantic';

    // BM25-style tokenized keyword scoring
    const rows = db.prepare('SELECT id, content FROM mem0_entries WHERE agent_id = ?').all(agentId) as any[];
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results = rows
      .map(row => {
        const lower = row.content.toLowerCase();
        const score = terms.reduce((acc: number, t: string) => acc + (lower.includes(t) ? 1 : 0), 0) / terms.length;
        return { id: row.id, score };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score);

    return reply.send({ mode, query, results });
  });

  // ── GET /api/mem0/:agentId ────────────────────────────────────────────────
  app.get('/api/mem0/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const rows = db.prepare('SELECT id, content, embedded, created_at FROM mem0_entries WHERE agent_id = ?').all(agentId) as any[];
    return reply.send({ agentId, count: rows.length, entries: rows });
  });

  // ── DELETE /api/mem0/:agentId ───────────────────────────────────────────────
  app.delete('/api/mem0/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const info = db.prepare('SELECT COUNT(*) as cnt FROM mem0_entries WHERE agent_id = ?').get(agentId) as any;
    db.prepare('DELETE FROM mem0_entries WHERE agent_id = ?').run(agentId);
    log.info({ agentId, deleted: info.cnt }, 'mem0 entries deleted');
    return reply.send({ agentId, deleted: info.cnt });
  });
}
