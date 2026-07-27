import type { FastifyInstance } from 'fastify';
import { z } from 'zod/v4';
import { getDb } from '../../storage/database.js';
import {
  WORK_EVENT_CATEGORIES,
  WORK_EVENT_OUTCOMES,
  WORK_EVENT_SEVERITIES,
  listWorkEvents,
  recordWorkEvent,
} from '../../core/work-event-ledger.js';

const MAX_EVENT_DETAIL_BYTES = 256 * 1024;

const WorkEventBodySchema = z.object({
  eventKey: z.string().min(1).max(500).optional(),
  source: z.string().min(1).max(120),
  sourceEventId: z.string().max(500).nullable().optional(),
  category: z.enum(WORK_EVENT_CATEGORIES).optional(),
  eventType: z.string().min(1).max(200),
  severity: z.enum(WORK_EVENT_SEVERITIES).optional(),
  outcome: z.enum(WORK_EVENT_OUTCOMES).optional(),
  title: z.string().min(1).max(1_000),
  summary: z.string().max(100_000).nullable().optional(),
  detail: z.unknown().optional(),
  evidence: z.unknown().optional(),
  taskId: z.string().max(200).nullable().optional(),
  workReportId: z.string().max(200).nullable().optional(),
  improvementNoteId: z.string().max(200).nullable().optional(),
  agentId: z.string().max(200).nullable().optional(),
  sessionId: z.string().max(200).nullable().optional(),
  projectPath: z.string().max(4_096).nullable().optional(),
  worktreePath: z.string().max(4_096).nullable().optional(),
  branch: z.string().max(500).nullable().optional(),
  commitSha: z.string().max(128).nullable().optional(),
  occurredAt: z.union([z.string(), z.number()]).optional(),
});

const WorkEventQuerySchema = z.object({
  category: z.enum(WORK_EVENT_CATEGORIES).optional(),
  taskId: z.string().max(200).optional(),
  source: z.string().max(120).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  beforeId: z.string().max(200).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export async function registerWorkEventRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/work-events', async (request, reply) => {
    const parsed = WorkEventBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'Invalid work event',
        details: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`),
      };
    }
    const detailBytes = Buffer.byteLength(JSON.stringify([
      parsed.data.detail ?? null,
      parsed.data.evidence ?? null,
    ]));
    if (detailBytes > MAX_EVENT_DETAIL_BYTES) {
      reply.code(413);
      return {
        error: 'Work event detail is too large',
        maxBytes: MAX_EVENT_DETAIL_BYTES,
        receivedBytes: detailBytes,
      };
    }

    const event = recordWorkEvent(parsed.data);
    reply.code(201);
    return { event };
  });

  app.get('/api/work-events', async (request, reply) => {
    const parsed = WorkEventQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'Invalid query',
        details: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`),
      };
    }
    const events = listWorkEvents(parsed.data);
    return {
      events,
      count: events.length,
      nextBeforeId: events.at(-1)?.id ?? null,
    };
  });

  app.get('/api/work-events/coverage', async () => {
    const db = getDb();
    const totals = db.prepare(`
      SELECT category, COUNT(*) AS count, MAX(occurred_at) AS latest
      FROM work_events
      GROUP BY category
      ORDER BY category
    `).all();
    const sourceTotals = db.prepare(`
      SELECT source, COUNT(*) AS count, MAX(occurred_at) AS latest
      FROM work_events
      GROUP BY source
      ORDER BY count DESC, source
    `).all();
    const chain = db.prepare(`
      WITH chain AS (
        SELECT
          rowid,
          previous_hash,
          LAG(content_hash) OVER (ORDER BY rowid) AS expected_previous_hash
        FROM work_events
      )
      SELECT
        COUNT(*) AS total,
        (SELECT COUNT(DISTINCT content_hash) FROM work_events) AS unique_hashes,
        COALESCE(SUM(
          CASE
            WHEN expected_previous_hash IS NULL AND previous_hash IS NULL THEN 0
            WHEN previous_hash = expected_previous_hash THEN 0
            ELSE 1
          END
        ), 0) AS broken_links
      FROM chain
    `).get();
    return { totals, sourceTotals, chain };
  });
}
