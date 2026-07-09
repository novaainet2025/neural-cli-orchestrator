/**
 * Nova Government — Privacy API
 * PRIVACY-POLICY v2.3 구현
 * - 동의 수준 조회/업데이트
 * - 삭제 요청 접수
 * - 동의 로그 조회
 * - 개인정보 통계
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../../storage/database.js';

const MAX_CONSENT_LEVEL = 3;
const ERASURE_SLA_HOURS = 72;
const CONSENT_LEVELS = {
  0: 'none',
  1: 'basic',
  2: 'standard',
  3: 'full',
} as const;

const UpdatePrivacySettingsSchema = z.object({
  consentLevel: z.number().int().min(0).max(MAX_CONSENT_LEVEL),
});

function consentLabel(level: number): string {
  return CONSENT_LEVELS[level as keyof typeof CONSENT_LEVELS] ?? CONSENT_LEVELS[0];
}

export async function registerPrivacyRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  const getCitizenStmt = db.prepare('SELECT did FROM nova_citizens WHERE did = ?');
  const getPrivacySettingsStmt = db.prepare(`
    SELECT did, consent_level, erasure_requested_at, erasure_completed_at, updated_at
    FROM nova_privacy_settings
    WHERE did = ?
  `);
  const upsertPrivacySettingsStmt = db.prepare(`
    INSERT INTO nova_privacy_settings
      (did, consent_level, erasure_requested_at, erasure_completed_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(did) DO UPDATE SET
      consent_level = excluded.consent_level,
      erasure_requested_at = excluded.erasure_requested_at,
      erasure_completed_at = excluded.erasure_completed_at,
      updated_at = excluded.updated_at
  `);
  const insertConsentLogStmt = db.prepare(`
    INSERT INTO nova_consent_log (id, did, action, old_level, new_level, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const getConsentLogStmt = db.prepare(`
    SELECT id, did, action, old_level, new_level, created_at
    FROM nova_consent_log
    WHERE did = ?
    ORDER BY created_at DESC
    LIMIT 20
  `);
  const consentDistributionStmt = db.prepare(`
    SELECT consent_level, COUNT(*) as cnt
    FROM nova_privacy_settings
    GROUP BY consent_level
  `);
  const erasureStatusStmt = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN erasure_requested_at IS NOT NULL THEN 1 ELSE 0 END) as requested,
      SUM(CASE WHEN erasure_requested_at IS NOT NULL AND erasure_completed_at IS NULL THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN erasure_completed_at IS NOT NULL THEN 1 ELSE 0 END) as completed
    FROM nova_privacy_settings
  `);

  function getCitizenOr404(did: string, reply: any) {
    const citizen = getCitizenStmt.get(did) as { did: string } | undefined;
    if (!citizen) {
      reply.code(404).send({ error: 'Citizen not found' });
      return null;
    }
    return citizen;
  }

  // GET /api/privacy/stats — 전체 동의 수준 분포, 삭제 요청 처리 현황
  app.get('/api/privacy/stats', async (_req, reply) => {
    try {
      const totalCitizens = ((db.prepare('SELECT COUNT(*) as cnt FROM nova_citizens').get() as any)?.cnt) ?? 0;
      const distributionRows = consentDistributionStmt.all() as Array<{ consent_level: number; cnt: number }>;
      const distribution = Object.keys(CONSENT_LEVELS).map((key) => {
        const level = Number(key);
        const row = distributionRows.find((item) => item.consent_level === level);
        return {
          consentLevel: level,
          label: consentLabel(level),
          count: row?.cnt ?? 0,
        };
      });
      const erasure = (erasureStatusStmt.get() as any) ?? {};

      return reply.send({
        totalCitizens,
        consentLevels: distribution,
        erasure: {
          totalTracked: erasure.total ?? 0,
          requested: erasure.requested ?? 0,
          pending: erasure.pending ?? 0,
          completed: erasure.completed ?? 0,
          slaHours: ERASURE_SLA_HOURS,
        },
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/privacy/:did/settings — 개인정보 설정 조회
  app.get<{ Params: { did: string } }>('/api/privacy/:did/settings', async (req, reply) => {
    const { did } = req.params;
    try {
      if (!getCitizenOr404(did, reply)) return;

      const row = getPrivacySettingsStmt.get(did) as any;
      const consentLevel = row?.consent_level ?? 0;

      return reply.send({
        did,
        consentLevel,
        consentLabel: consentLabel(consentLevel),
        erasureRequestedAt: row?.erasure_requested_at ?? null,
        erasureCompletedAt: row?.erasure_completed_at ?? null,
        updatedAt: row?.updated_at ?? null,
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/privacy/:did/settings — 개인정보 설정 업데이트
  app.post<{ Params: { did: string } }>('/api/privacy/:did/settings', async (req, reply) => {
    const { did } = req.params;
    const parsed = UpdatePrivacySettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
    }

    try {
      if (!getCitizenOr404(did, reply)) return;

      const now = Math.floor(Date.now() / 1000);
      const existing = getPrivacySettingsStmt.get(did) as any;
      const oldLevel = existing?.consent_level ?? 0;
      const newLevel = parsed.data.consentLevel;

      upsertPrivacySettingsStmt.run(
        did,
        newLevel,
        existing?.erasure_requested_at ?? null,
        existing?.erasure_completed_at ?? null,
        now,
      );
      insertConsentLogStmt.run(
        `consent-${randomUUID()}`,
        did,
        'consent_level_updated',
        oldLevel,
        newLevel,
        now,
      );

      return reply.send({
        did,
        consentLevel: newLevel,
        consentLabel: consentLabel(newLevel),
        previousConsentLevel: oldLevel,
        previousConsentLabel: consentLabel(oldLevel),
        updatedAt: now,
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/privacy/:did/erasure — 삭제 요청
  app.post<{ Params: { did: string } }>('/api/privacy/:did/erasure', async (req, reply) => {
    const { did } = req.params;
    try {
      if (!getCitizenOr404(did, reply)) return;

      const now = Math.floor(Date.now() / 1000);
      const slaDeadline = now + ERASURE_SLA_HOURS * 3600;
      const existing = getPrivacySettingsStmt.get(did) as any;
      const currentConsentLevel = existing?.consent_level ?? 0;

      upsertPrivacySettingsStmt.run(
        did,
        currentConsentLevel,
        now,
        existing?.erasure_completed_at ?? null,
        now,
      );
      insertConsentLogStmt.run(
        `erasure-${randomUUID()}`,
        did,
        'erasure_requested',
        currentConsentLevel,
        currentConsentLevel,
        now,
      );

      return reply.send({
        did,
        erasureRequestedAt: now,
        erasureDueAt: slaDeadline,
        slaHours: ERASURE_SLA_HOURS,
        status: 'pending',
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/privacy/:did/consent-log — 최근 동의 로그
  app.get<{ Params: { did: string } }>('/api/privacy/:did/consent-log', async (req, reply) => {
    const { did } = req.params;
    try {
      if (!getCitizenOr404(did, reply)) return;

      const rows = getConsentLogStmt.all(did) as Array<{
        id: string;
        did: string;
        action: string;
        old_level: number | null;
        new_level: number | null;
        created_at: number;
      }>;

      return reply.send({
        did,
        logs: rows.map((row) => ({
          id: row.id,
          action: row.action,
          oldLevel: row.old_level,
          oldLabel: row.old_level == null ? null : consentLabel(row.old_level),
          newLevel: row.new_level,
          newLabel: row.new_level == null ? null : consentLabel(row.new_level),
          createdAt: row.created_at,
        })),
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
