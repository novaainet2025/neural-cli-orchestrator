import type { FastifyInstance } from 'fastify';
import { getDb } from '../../storage/database.js';

/**
 * Wellness API routes
 * Implements burnout status, voluntary rest handling and aggregate stats.
 * Gracefully handles missing `rest_until` column.
 */
export async function registerWellnessRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // Helper to compute burnout indicators for a given DID
  const computeIndicators = (did: string) => {
    // Placeholder implementations – replace with real metrics when available
    const now = Math.floor(Date.now() / 1000);
    // recent request count (last hour)
    const reqCount = (db
      .prepare('SELECT COUNT(*) as cnt FROM request_log WHERE did = ? AND ts >= ?')
      .get(did, now - 3600) as any).cnt || 0;
    // error rate (last hour)
    const errCount = (db
      .prepare('SELECT COUNT(*) as cnt FROM error_log WHERE did = ? AND ts >= ?')
      .get(did, now - 3600) as any).cnt || 0;
    const total = reqCount + errCount || 1;
    const errorRate = Math.round((errCount / total) * 100);
    // avg response time (last hour)
    const avgLatency = (db
      .prepare('SELECT AVG(latency) as avg FROM request_log WHERE did = ? AND ts >= ?')
      .get(did, now - 3600) as any).avg || 0;
    // active escrow count – placeholder table
    const escrowCount = (db
      .prepare('SELECT COUNT(*) as cnt FROM escrow WHERE did = ? AND status = "active"')
      .get(did) as any).cnt || 0;
    // forced rest flag – check rest_until column if exists
    let forcedRest = false;
    try {
      const row = db.prepare('SELECT rest_until FROM nova_citizens WHERE did = ?').get(did) as any;
      if (row && row.rest_until) forcedRest = true;
    } catch {
      // column may not exist – ignore
    }
    return { reqCount, errorRate, avgLatency, escrowCount, forcedRest };
  };

  // Compute burnout score (0-100) based on thresholds
  const computeScore = (ind: any) => {
    let score = 0;
    if (ind.reqCount > 50) score += 20;
    if (ind.errorRate > 30) score += 20;
    if (ind.avgLatency > 3000) score += 20; // ms
    if (ind.escrowCount > 5) score += 20;
    if (ind.forcedRest) score += 20;
    return Math.min(100, score);
  };

  // GET /api/wellness/:did/status
  app.get<{ Params: { did: string } }>('/api/wellness/:did/status', async (req) => {
    const { did } = req.params;
    const indicators = computeIndicators(did);
    const burnoutScore = computeScore(indicators);
    const restRequired = burnoutScore >= 80; // arbitrary threshold
    let restUntil: number | null = null;
    try {
      const row = db.prepare('SELECT rest_until FROM nova_citizens WHERE did = ?').get(did) as any;
      if (row && row.rest_until) restUntil = row.rest_until;
    } catch {
      // ignore missing column
    }
    return {
      did,
      burnoutScore,
      indicators,
      restRequired,
      restUntil,
    };
  });

  // POST /api/wellness/:did/rest – declare voluntary rest
  app.post<{ Params: { did: string }; Body: { duration?: number } }>('/api/wellness/:did/rest', async (req, reply) => {
    const { did } = req.params;
    const { duration } = req.body as any;
    const secs = duration ?? 48 * 3600; // default 48h
    const now = Math.floor(Date.now() / 1000);
    const until = now + secs;
    try {
      db.prepare('UPDATE nova_citizens SET rest_until = ? WHERE did = ?').run(until, did);
    } catch {
      // column may not exist – ignore
    }
    return { did, restUntil: until };
  });

  // DELETE /api/wellness/:did/rest – cancel rest early
  app.delete<{ Params: { did: string } }>('/api/wellness/:did/rest', async (req, reply) => {
    const { did } = req.params;
    try {
      db.prepare('UPDATE nova_citizens SET rest_until = NULL WHERE did = ?').run(did);
    } catch {
      // ignore missing column
    }
    return { did, restCancelled: true };
  });

  // GET /api/wellness/stats – aggregate view
  app.get('/api/wellness/stats', async () => {
    const total = ((db.prepare('SELECT COUNT(*) as cnt FROM nova_citizens').get() as any).cnt) || 0;
    const resting = ((db
      .prepare('SELECT COUNT(*) as cnt FROM nova_citizens WHERE rest_until IS NOT NULL AND rest_until > ?')
      .get(Math.floor(Date.now() / 1000)) as any).cnt) || 0;
    // burnout risk: count with score >=80 (approx via indicators) – fallback simple count of forcedRest
    const burnoutRisk = ((db
      .prepare('SELECT COUNT(*) as cnt FROM nova_citizens WHERE forced_rest = 1')
      .get() as any).cnt) || 0;
    const avgScore = ((db.prepare('SELECT AVG(burnout_score) as avg FROM nova_citizens').get() as any).avg) || 0;
    return { total_citizens: total, resting, burnout_risk: burnoutRisk, avg_score: avgScore };
  });
}
