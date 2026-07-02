import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eventBus } from '../../core/event-bus.js';
import { getDb } from '../../storage/database.js';

const EvidenceSchema = z.object({
  tier: z.enum(['T1', 'T2', 'T3', 'T4']),
  method: z.string().min(1),
  claim: z.string().min(1),
  raw: z.string().min(1),
});

const HandoffPacketSchema = z.object({
  schema_version: z.string().min(1),
  sender: z.object({
    agent_name: z.string().min(1),
    session_id: z.string().min(1),
    timestamp: z.string().min(1),
  }),
  task: z.object({
    id: z.string().min(1),
    description: z.string().min(1),
  }),
  outcome: z.enum(['done', 'partial', 'failed', 'question']),
  summary: z.string().max(200),
  evidence: z.array(EvidenceSchema),
});

type HandoffPacket = z.infer<typeof HandoffPacketSchema>;

const TIER_RANK: Record<'T1' | 'T2' | 'T3' | 'T4', number> = {
  T1: 1,
  T2: 2,
  T3: 3,
  T4: 4,
};

function getRequiredTier(outcome: HandoffPacket['outcome']): string | null {
  switch (outcome) {
    case 'done':
      return 'T1 + (T2 or T3)';
    case 'partial':
      return 'T1';
    case 'failed':
      return 'T1 or T3';
    case 'question':
      return null;
  }
}

function getPolicyFailure(packet: HandoffPacket): { reason: string; requiredTier: string } | null {
  const evidenceRanks = new Set(packet.evidence.map((item) => TIER_RANK[item.tier]));
  const hasT1 = evidenceRanks.has(TIER_RANK.T1);
  const hasT2 = evidenceRanks.has(TIER_RANK.T2);
  const hasT3 = evidenceRanks.has(TIER_RANK.T3);

  switch (packet.outcome) {
    case 'done':
      if (!hasT1 || (!hasT2 && !hasT3)) {
        return {
          reason: 'done outcome requires T1 and either T2 or T3 evidence',
          requiredTier: 'T1 + (T2 or T3)',
        };
      }
      return null;
    case 'partial':
      if (!hasT1) {
        return {
          reason: 'partial outcome requires T1 evidence',
          requiredTier: 'T1',
        };
      }
      return null;
    case 'failed':
      if (!hasT1 && !hasT3) {
        return {
          reason: 'failed outcome requires T1 or T3 evidence',
          requiredTier: 'T1 or T3',
        };
      }
      return null;
    case 'question':
      return null;
  }
}

export async function registerHandoffRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  app.post('/api/handoff', async (req, reply) => {
    const parsed = HandoffPacketSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ accepted: false, error: parsed.error.flatten() });
    }

    const packet = parsed.data;
    const policyFailure = getPolicyFailure(packet);
    const insert = db.prepare(`
      INSERT INTO handoff_packets (
        task_id, sender, outcome, summary, packet_json, accepted, reject_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    if (policyFailure) {
      const result = insert.run(
        packet.task.id,
        JSON.stringify(packet.sender),
        packet.outcome,
        packet.summary,
        JSON.stringify(packet),
        0,
        policyFailure.reason,
      );
      return reply.code(422).send({
        accepted: false,
        id: Number(result.lastInsertRowid),
        reason: policyFailure.reason,
        requiredTier: policyFailure.requiredTier,
      });
    }

    const result = insert.run(
      packet.task.id,
      JSON.stringify(packet.sender),
      packet.outcome,
      packet.summary,
      JSON.stringify(packet),
      1,
      null,
    );

    await eventBus.publish({
      type: 'session:handoff',
      taskId: packet.task.id,
      sender: packet.sender,
      outcome: packet.outcome,
      summary: packet.summary,
      packet,
    });

    return reply.code(200).send({ accepted: true, id: Number(result.lastInsertRowid) });
  });

  app.get('/api/handoff', async (req, reply) => {
    const querySchema = z.object({
      task_id: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const { task_id, limit } = parsed.data;
    const rows = task_id
      ? db.prepare(`
          SELECT id, task_id, sender, outcome, summary, packet_json, accepted, reject_reason, created_at
          FROM handoff_packets
          WHERE task_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `).all(task_id, limit)
      : db.prepare(`
          SELECT id, task_id, sender, outcome, summary, packet_json, accepted, reject_reason, created_at
          FROM handoff_packets
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `).all(limit);

    return reply.send({ items: rows, count: rows.length });
  });
}
