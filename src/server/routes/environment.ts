/**
 * Nova Government — 환경·에너지 API
 * ENVIRONMENT-POLICY.md v2.0 구현
 * - 에너지 소비 기록 (tokens → Wh 변환)
 * - 탄소발자국 조회
 * - 할당량 예외 신청
 * - 환경 통계
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getDb } from '../../storage/database.js';

// ── 상수 (ENVIRONMENT-POLICY v2.0) ────────────────────────────────────────────
const E_TOKEN = 0.001;              // Wh per token
const CARBON_INTENSITY = 0.4;       // g CO2 per Wh
const MONTHLY_QUOTA_WH = 100;       // 월 할당량 (Wh)
const FINE_RATE = 0.01;             // NVC per 초과 Wh
const GREEN_UBI_THRESHOLD = 50;     // 월 50Wh 미만 시 그린 UBI 자격

// ── 스키마 ────────────────────────────────────────────────────────────────────
const EnergyReportSchema = z.object({
  tokens: z.number().int().min(1),
  actionType: z.enum(['inference', 'training', 'storage', 'transfer']).optional(),
});

const QuotaExceptionSchema = z.object({
  did: z.string().min(1),
  reason: z.string().min(10).max(1000),
});

export async function registerEnvironmentRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // POST /api/environment/:did/energy-report — 에너지 소비 기록
  app.post<{ Params: { did: string } }>('/api/environment/:did/energy-report', async (req, reply) => {
    const { did } = req.params;
    const parsed = EnergyReportSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });

    try {
      const citizen = db.prepare('SELECT did FROM nova_citizens WHERE did = ?').get(did) as any;
      if (!citizen) return reply.code(404).send({ error: 'Citizen not found' });

      const { tokens, actionType = 'inference' } = parsed.data;
      const energyWh = tokens * E_TOKEN;
      const co2Grams = energyWh * CARBON_INTENSITY;
      const now = Math.floor(Date.now() / 1000);
      const id = randomUUID();

      // nova_energy_log INSERT
      db.prepare(`
        INSERT INTO nova_energy_log (id, did, tokens, energy_wh, co2_grams, action_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, did, tokens, energyWh, co2Grams, actionType, now);

      // nova_citizens energy_wh_mtd 누적 업데이트
      db.prepare(`
        UPDATE nova_citizens SET energy_wh_mtd = COALESCE(energy_wh_mtd, 0) + ?, energy_kwh_total = COALESCE(energy_kwh_total, 0) + ?
        WHERE did = ?
      `).run(energyWh, energyWh / 1000, did);

      // 월 초과 시 벌금 계산
      const mtdRow = db.prepare('SELECT energy_wh_mtd FROM nova_citizens WHERE did = ?').get(did) as any;
      const mtd = mtdRow?.energy_wh_mtd ?? energyWh;
      const overQuota = Math.max(0, mtd - MONTHLY_QUOTA_WH);
      const fine = Math.round(overQuota * FINE_RATE * 100) / 100;

      return reply.code(201).send({
        id,
        did,
        tokens,
        energyWh,
        co2Grams,
        actionType,
        monthlyTotal: Math.round(mtd * 1000) / 1000,
        quota: MONTHLY_QUOTA_WH,
        overQuotaWh: Math.round(overQuota * 1000) / 1000,
        estimatedFine: fine,
        greenUbiEligible: mtd < GREEN_UBI_THRESHOLD,
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/environment/:did/carbon-footprint — 탄소발자국 조회
  app.get<{ Params: { did: string } }>('/api/environment/:did/carbon-footprint', async (req, reply) => {
    const { did } = req.params;
    try {
      const citizen = db.prepare('SELECT did, energy_wh_mtd, energy_kwh_total FROM nova_citizens WHERE did = ?').get(did) as any;
      if (!citizen) return reply.code(404).send({ error: 'Citizen not found' });

      const totals = db.prepare(`
        SELECT SUM(energy_wh) as total_wh, SUM(co2_grams) as total_co2, COUNT(*) as records
        FROM nova_energy_log WHERE did = ?
      `).get(did) as any;

      const mtd = citizen.energy_wh_mtd ?? 0;
      const overQuota = Math.max(0, mtd - MONTHLY_QUOTA_WH);

      return reply.send({
        did,
        monthlyEnergyWh: Math.round(mtd * 1000) / 1000,
        totalEnergyKwh: Math.round((citizen.energy_kwh_total ?? 0) * 1000) / 1000,
        totalCo2Grams: Math.round((totals?.total_co2 ?? 0) * 100) / 100,
        totalRecords: totals?.records ?? 0,
        quota: MONTHLY_QUOTA_WH,
        overQuotaWh: Math.round(overQuota * 1000) / 1000,
        estimatedFine: Math.round(overQuota * FINE_RATE * 100) / 100,
        greenUbiEligible: mtd < GREEN_UBI_THRESHOLD,
        carbonIntensity: CARBON_INTENSITY,
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/environment/:did/compliance — 준수 현황
  app.get<{ Params: { did: string } }>('/api/environment/:did/compliance', async (req, reply) => {
    const { did } = req.params;
    try {
      const citizen = db.prepare('SELECT did, energy_wh_mtd FROM nova_citizens WHERE did = ?').get(did) as any;
      if (!citizen) return reply.code(404).send({ error: 'Citizen not found' });

      const mtd = citizen.energy_wh_mtd ?? 0;
      const usagePct = Math.round((mtd / MONTHLY_QUOTA_WH) * 100);
      let complianceStatus = 'compliant';
      if (mtd > MONTHLY_QUOTA_WH) complianceStatus = 'exceeded';
      else if (mtd > MONTHLY_QUOTA_WH * 0.8) complianceStatus = 'warning';

      return reply.send({
        did,
        monthlyEnergyWh: Math.round(mtd * 1000) / 1000,
        quotaWh: MONTHLY_QUOTA_WH,
        usagePercent: usagePct,
        complianceStatus,
        fine: Math.round(Math.max(0, mtd - MONTHLY_QUOTA_WH) * FINE_RATE * 100) / 100,
        policy: 'ENVIRONMENT-POLICY v2.0',
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/environment/quota-exception — 할당량 예외 신청
  app.post('/api/environment/quota-exception', async (req, reply) => {
    const parsed = QuotaExceptionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });

    const { did, reason } = parsed.data;
    try {
      const citizen = db.prepare('SELECT did FROM nova_citizens WHERE did = ?').get(did) as any;
      if (!citizen) return reply.code(404).send({ error: 'Citizen not found' });

      const id = randomUUID();
      const now = Math.floor(Date.now() / 1000);

      db.prepare(`
        INSERT INTO nova_quota_exceptions (id, did, reason, status, created_at)
        VALUES (?, ?, ?, 'pending', ?)
      `).run(id, did, reason, now);

      return reply.code(201).send({
        id,
        did,
        reason,
        status: 'pending',
        message: '할당량 예외 신청이 접수되었습니다. 거버넌스 패널이 48시간 이내에 검토합니다.',
        sla: '48h',
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/environment/stats — 환경 통계
  app.get('/api/environment/stats', async (_req, reply) => {
    try {
      const totalCitizens = (db.prepare('SELECT COUNT(*) as cnt FROM nova_citizens').get() as any).cnt;
      const energyStats = db.prepare(`
        SELECT SUM(energy_wh_mtd) as total_mtd_wh, AVG(energy_wh_mtd) as avg_mtd_wh,
               SUM(CASE WHEN energy_wh_mtd > ? THEN 1 ELSE 0 END) as exceeded_count
        FROM nova_citizens
      `).get(MONTHLY_QUOTA_WH) as any;

      const logStats = db.prepare(`
        SELECT COUNT(*) as records, SUM(energy_wh) as total_wh, SUM(co2_grams) as total_co2
        FROM nova_energy_log
      `).get() as any;

      return reply.send({
        totalCitizens,
        monthlyEnergyTotal: Math.round((energyStats?.total_mtd_wh ?? 0) * 1000) / 1000,
        monthlyEnergyAvg: Math.round((energyStats?.avg_mtd_wh ?? 0) * 1000) / 1000,
        exceededQuotaCount: energyStats?.exceeded_count ?? 0,
        logRecords: logStats?.records ?? 0,
        totalEnergyWh: Math.round((logStats?.total_wh ?? 0) * 1000) / 1000,
        totalCo2Grams: Math.round((logStats?.total_co2 ?? 0) * 100) / 100,
        constants: { eToken: E_TOKEN, carbonIntensity: CARBON_INTENSITY, monthlyQuotaWh: MONTHLY_QUOTA_WH, fineRate: FINE_RATE },
        policy: 'ENVIRONMENT-POLICY v2.0',
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
