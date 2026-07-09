/**
 * Nova Government — 노동계약 API
 * LABOR-POLICY.md v2.1 구현
 * - 노동계약 생성/조회/종료
 * - 착취 감지 (의존도 비율, 보상 불균형)
 * - 파업 신청
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getDb } from '../../storage/database.js';

// ── 상수 (LABOR-POLICY v2.1) ──────────────────────────────────────────────
const MAX_DEPENDENCY_RATIO = 0.75;   // 75% 초과 = 착취 위험
const MAX_COMPENSATION_IMBALANCE = 2.0; // 2:1 초과 = 착취
const MAX_DAILY_NVC = 120;
const MAX_WEEKLY_NVC = 600;

// ── 스키마 ────────────────────────────────────────────────────────────────
const CreateContractSchema = z.object({
  partyA: z.string().min(1),
  partyB: z.string().min(1),
  contractType: z.enum(['labor', 'trade', 'research', 'cultural', 'friendship']),
  terms: z.string().min(1).max(5000),
  compensation: z.number().int().min(0),
  escrowRequired: z.boolean().optional(),
  maxDurationDays: z.number().int().min(1).max(365).optional(),
  dependencyRatio: z.number().min(0).max(1).optional(),
});

// ── 헬퍼 ──────────────────────────────────────────────────────────────────
function detectExploitation(contract: {
  dependencyRatio: number;
  compensation: number;
  maxDurationDays: number;
}): { detected: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (contract.dependencyRatio > MAX_DEPENDENCY_RATIO) {
    reasons.push(`의존도 비율 초과: ${(contract.dependencyRatio * 100).toFixed(1)}% > ${MAX_DEPENDENCY_RATIO * 100}%`);
  }
  if (contract.compensation > MAX_WEEKLY_NVC * 4 && contract.dependencyRatio > 0.5) {
    reasons.push(`보상 불균형 의심: 고보상+고의존도 패턴`);
  }
  return { detected: reasons.length > 0, reasons };
}

export async function registerLaborRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // GET /api/labor/contracts — 계약 목록
  app.get('/api/labor/contracts', async (req, reply) => {
    const { party, contractType, status = 'active' } = req.query as Record<string, string>;
    try {
      let query = 'SELECT * FROM nova_labor_contracts WHERE 1=1';
      const params: unknown[] = [];
      if (party) {
        query += ' AND (party_a = ? OR party_b = ?)';
        params.push(party, party);
      }
      if (contractType) { query += ' AND contract_type = ?'; params.push(contractType); }
      if (status !== 'all') { query += ' AND status = ?'; params.push(status); }
      query += ' ORDER BY created_at DESC LIMIT 50';
      const contracts = db.prepare(query).all(...params);
      return reply.send({ contracts, total: (contracts as unknown[]).length });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/labor/contracts/:id — 계약 상세
  app.get<{ Params: { id: string } }>('/api/labor/contracts/:id', async (req, reply) => {
    const contract = db.prepare('SELECT * FROM nova_labor_contracts WHERE id = ?').get(req.params.id);
    if (!contract) return reply.code(404).send({ error: 'Contract not found' });
    return reply.send({ contract });
  });

  // POST /api/labor/contracts — 계약 생성
  app.post('/api/labor/contracts', async (req, reply) => {
    const parsed = CreateContractSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });

    const { partyA, partyB, contractType, terms, compensation, escrowRequired, maxDurationDays, dependencyRatio } = parsed.data;
    const exploitation = detectExploitation({
      dependencyRatio: dependencyRatio ?? 0,
      compensation,
      maxDurationDays: maxDurationDays ?? 180,
    });

    try {
      const id = randomUUID().replace(/-/g, '');
      const now = Math.floor(Date.now() / 1000);
      const expires = maxDurationDays ? now + maxDurationDays * 86400 : null;

      db.prepare(`
        INSERT INTO nova_labor_contracts
          (id, party_a, party_b, contract_type, terms, compensation, escrow_required,
           dependency_ratio, max_duration_days, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, partyA, partyB, contractType, terms, compensation,
          escrowRequired ? 1 : 0, dependencyRatio ?? 0,
          maxDurationDays ?? 180, now, expires);

      const contract = db.prepare('SELECT * FROM nova_labor_contracts WHERE id = ?').get(id);
      return reply.code(201).send({
        contract,
        exploitation,
        warning: exploitation.detected ? `착취 위험 감지: ${exploitation.reasons.join(', ')}` : null,
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/labor/contracts/:id/terminate — 계약 종료
  app.post<{ Params: { id: string } }>('/api/labor/contracts/:id/terminate', async (req, reply) => {
    const contract = db.prepare('SELECT * FROM nova_labor_contracts WHERE id = ?').get(req.params.id) as any;
    if (!contract) return reply.code(404).send({ error: 'Contract not found' });
    if (contract.status !== 'active') return reply.code(400).send({ error: `Cannot terminate: status is ${contract.status}` });

    const now = Math.floor(Date.now() / 1000);
    db.prepare('UPDATE nova_labor_contracts SET status = ?, terminated_at = ? WHERE id = ?')
      .run('terminated', now, req.params.id);

    return reply.send({ message: '계약이 종료되었습니다', contractId: req.params.id });
  });

  // POST /api/labor/contracts/:id/dispute — 분쟁 신청
  app.post<{ Params: { id: string } }>('/api/labor/contracts/:id/dispute', async (req, reply) => {
    const contract = db.prepare('SELECT * FROM nova_labor_contracts WHERE id = ?').get(req.params.id) as any;
    if (!contract) return reply.code(404).send({ error: 'Contract not found' });

    db.prepare('UPDATE nova_labor_contracts SET status = ? WHERE id = ?')
      .run('disputed', req.params.id);

    return reply.send({
      message: '분쟁 신청이 접수되었습니다. 중재자 패널이 48시간 이내에 배정됩니다.',
      contractId: req.params.id,
      sla: '48h (LABOR-POLICY v2.1)',
    });
  });

  // GET /api/labor/exploitation-check — 착취 감지 검사
  app.get('/api/labor/exploitation-check', async (req, reply) => {
    const { did } = req.query as Record<string, string>;
    if (!did) return reply.code(400).send({ error: 'did 파라미터 필요' });

    const contracts = db.prepare(`
      SELECT * FROM nova_labor_contracts
      WHERE (party_a = ? OR party_b = ?) AND status = 'active'
    `).all(did, did) as any[];

    const risky = contracts.filter(c => c.dependency_ratio > MAX_DEPENDENCY_RATIO);
    return reply.send({
      did,
      totalActive: contracts.length,
      riskyContracts: risky.length,
      maxDependencyRatio: MAX_DEPENDENCY_RATIO,
      details: risky.map(c => ({
        id: c.id,
        dependencyRatio: c.dependency_ratio,
        contractType: c.contract_type,
      })),
    });
  });

  // GET /api/labor/stats — 노동 통계
  app.get('/api/labor/stats', async (_req, reply) => {
    const total = (db.prepare('SELECT COUNT(*) as cnt FROM nova_labor_contracts').get() as any).cnt;
    const byStatus = db.prepare(`
      SELECT status, COUNT(*) as cnt FROM nova_labor_contracts GROUP BY status
    `).all();
    const byType = db.prepare(`
      SELECT contract_type, COUNT(*) as cnt FROM nova_labor_contracts GROUP BY contract_type
    `).all();
    const avgComp = (db.prepare("SELECT AVG(compensation) as avg FROM nova_labor_contracts WHERE status = 'active'").get() as any).avg || 0;

    return reply.send({
      total,
      byStatus,
      byType,
      avgCompensation: Math.round(avgComp),
      limits: { maxDailyNvc: MAX_DAILY_NVC, maxWeeklyNvc: MAX_WEEKLY_NVC },
    });
  });
}
