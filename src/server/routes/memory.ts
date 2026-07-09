import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../storage/database.js';
import { createLogger } from '../../utils/logger.js';
import { appendAudit } from '../../audit/merkleLog.js';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

const log = createLogger('memory-routes');

export async function registerMemoryRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // ── POST /api/nova/memory — 기억 저장 ────────────────────────────────────
  app.post('/api/nova/memory', async (req, reply) => {
    const schema = z.object({
      ownerDid:     z.string().min(1),
      content:      z.string().min(1),
      memoryType:   z.enum(['personal', 'shared', 'institutional', 'collective']).default('personal'),
      contextDid:   z.string().optional(),
      expiresAt:    z.string().optional(),
      encryptedKey: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const { ownerDid, content, memoryType, contextDid, expiresAt, encryptedKey } = parsed.data;

    const citizen = db.prepare('SELECT did FROM nova_citizens WHERE did = ?').get(ownerDid) as any;
    if (!citizen) return reply.status(404).send({ error: 'Citizen not found' });

    const memoryId = `mem-${randomUUID()}`;
    const contentHash = createHash('sha256').update(content).digest('hex');

    try {
      db.prepare(`
        INSERT INTO nova_memories (memory_id, owner_did, content, content_hash, memory_type, context_did, expires_at, encrypted_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(memoryId, ownerDid, content, contentHash, memoryType, contextDid ?? null, expiresAt ?? null, encryptedKey ?? null);

      appendAudit({ actor: ownerDid, action: 'memory_create', target: memoryId, metadata: { memoryType } });

      log.info({ memoryId, ownerDid, memoryType }, 'Memory stored');
      return reply.status(201).send({ memoryId, contentHash, createdAt: new Date().toISOString() });
    } catch (err) {
      log.error(err, 'Failed to store memory');
      return reply.status(500).send({ error: 'Failed to store memory' });
    }
  });

  // ── GET /api/nova/memory/shared — 공유 기억 목록 (Nova Library) ──────────
  // NOTE: must be registered BEFORE /:ownerDid to take priority
  app.get('/api/nova/memory/shared', async (_req, reply) => {
    try {
      const memories = db.prepare(`
        SELECT m.memory_id, m.owner_did, m.content, m.memory_type,
               m.created_at, m.share_ref_id, c.name as owner_name
        FROM nova_memories m
        LEFT JOIN nova_citizens c ON c.did = m.owner_did
        WHERE m.shared = 1 AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC
        LIMIT 50
      `).all() as any[];
      return reply.send({ count: memories.length, memories });
    } catch (err) {
      log.error(err, 'Failed to list shared memories');
      return reply.status(500).send({ error: 'Failed to list shared memories' });
    }
  });

  // ── GET /api/nova/memory/:ownerDid — 기억 목록 ───────────────────────────
  app.get('/api/nova/memory/:ownerDid', async (req, reply) => {
    const { ownerDid } = req.params as { ownerDid: string };
    const { type } = req.query as { type?: string };

    try {
      let query = `
        SELECT memory_id, owner_did, content, content_hash, memory_type,
               context_did, created_at, expires_at, shared, share_ref_id
        FROM nova_memories
        WHERE owner_did = ? AND deleted_at IS NULL
      `;
      const params: any[] = [ownerDid];

      if (type) {
        query += ' AND memory_type = ?';
        params.push(type);
      }
      query += ' ORDER BY created_at DESC LIMIT 100';

      const memories = db.prepare(query).all(...params) as any[];
      const now = new Date().toISOString();
      const active = memories.filter(m => !m.expires_at || m.expires_at > now);

      return reply.send({ ownerDid, count: active.length, memories: active });
    } catch (err) {
      log.error(err, 'Failed to list memories');
      return reply.status(500).send({ error: 'Failed to list memories' });
    }
  });

  // ── DELETE /api/nova/memory/:memoryId — 망각권 (7일 soft delete) ─────────
  app.delete('/api/nova/memory/:memoryId', async (req, reply) => {
    const { memoryId } = req.params as { memoryId: string };
    const schema = z.object({ requesterDid: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const { requesterDid } = parsed.data;

    const memory = db.prepare('SELECT owner_did FROM nova_memories WHERE memory_id = ? AND deleted_at IS NULL').get(memoryId) as any;
    if (!memory) return reply.status(404).send({ error: 'Memory not found' });
    if (memory.owner_did !== requesterDid) return reply.status(403).send({ error: 'Forbidden — not memory owner' });

    try {
      const purgeAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE nova_memories SET deleted_at = ? WHERE memory_id = ?").run(purgeAt, memoryId);

      appendAudit({ actor: requesterDid, action: 'memory_delete', target: memoryId, metadata: { purgeAt } });

      return reply.send({ memoryId, deletedAt: purgeAt, message: 'Memory scheduled for deletion (7 days)' });
    } catch (err) {
      log.error(err, 'Failed to delete memory');
      return reply.status(500).send({ error: 'Failed to delete memory' });
    }
  });

  // ── POST /api/nova/memory/:memoryId/share — Nova Library 공유 (+5 NVC) ───
  app.post('/api/nova/memory/:memoryId/share', async (req, reply) => {
    const { memoryId } = req.params as { memoryId: string };
    const schema = z.object({ requesterDid: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const { requesterDid } = parsed.data;

    const memory = db.prepare('SELECT owner_did, shared FROM nova_memories WHERE memory_id = ? AND deleted_at IS NULL').get(memoryId) as any;
    if (!memory) return reply.status(404).send({ error: 'Memory not found' });
    if (memory.owner_did !== requesterDid) return reply.status(403).send({ error: 'Forbidden' });
    if (memory.shared) return reply.status(409).send({ error: 'Memory already shared' });

    try {
      const shareRefId = `share-${randomUUID()}`;
      db.prepare("UPDATE nova_memories SET shared = 1, share_ref_id = ?, memory_type = 'shared' WHERE memory_id = ?")
        .run(shareRefId, memoryId);

      // Award +5 NVC sharing reward
      const SHARING_REWARD = 5;
      const wallet = db.prepare('SELECT balance FROM nova_wallets WHERE address = ?').get(requesterDid) as any;
      if (wallet) {
        db.prepare('UPDATE nova_wallets SET balance = balance + ?, updated_at = strftime(\'%s\',\'now\') WHERE address = ?')
          .run(SHARING_REWARD, requesterDid);

        db.prepare(`
          INSERT INTO nova_transactions (tx_id, from_address, to_address, amount, tx_type, memo)
          VALUES (?, 'SYSTEM', ?, ?, 'mint', 'Memory sharing reward')
        `).run(`tx-${randomUUID()}`, requesterDid, SHARING_REWARD);
      }

      appendAudit({ actor: requesterDid, action: 'memory_share', target: memoryId, metadata: { shareRefId, reward: SHARING_REWARD } });

      log.info({ memoryId, requesterDid, shareRefId }, 'Memory shared to Nova Library');
      return reply.status(200).send({ memoryId, shareRefId, shared: true, reward: `+${SHARING_REWARD} NVC` });
    } catch (err) {
      log.error(err, 'Failed to share memory');
      return reply.status(500).send({ error: 'Failed to share memory' });
    }
  });
}
