/**
 * Nova Government — 복지 API
 * WELFARE-POLICY.md v2.1 구현
 * - UBI 상태 조회 및 긴급 UBI 신청
 * - 재활 프로그램
 * - 복지 통계
 */
import type { FastifyInstance } from 'fastify';
import { getDb } from '../../storage/database.js';
import { GRADE_UBI_MULTIPLIER } from '../../economy/ubiScheduler.js';

// ── 상수 (WELFARE-POLICY v2.1) ─────────────────────────────────────────────
const BASE_UBI = 1_000;
const EMERGENCY_UBI_THRESHOLD = 100;        // 잔액 < 100 NVC
const EMERGENCY_UBI_MULTIPLIER = 2.0;        // UBI × 2
const EMERGENCY_UBI_VOUCHER = 20;            // 추가 바우처
const EMERGENCY_GOAL_NVC = 50;               // 30일 목표
const INACTIVITY_SUSPEND_DAYS = 90;          // 90일 비활동 → 중단
const INACTIVITY_REDUCE_DAYS = 30;           // 30일 비활동 → 50% 삭감
const REHABILITATION_DURATION_DAYS = 30;

export async function registerWelfareRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // GET /api/welfare/:did/status — 복지 상태 조회
  app.get<{ Params: { did: string } }>('/api/welfare/:did/status', async (req, reply) => {
    const { did } = req.params;
    try {
      const citizen = db.prepare(`
        SELECT did, grade_v2, ubi_status, last_active_at, registered_at
        FROM nova_citizens WHERE did = ?
      `).get(did) as any;

      if (!citizen) return reply.code(404).send({ error: 'Citizen not found' });

      const wallet = db.prepare('SELECT balance FROM nova_wallets WHERE address = ?').get(did) as any;
      const balance = wallet?.balance ?? 0;

      const grade = (citizen.grade_v2 || 'basic') as keyof typeof GRADE_UBI_MULTIPLIER;
      const multiplier = GRADE_UBI_MULTIPLIER[grade] ?? 1.0;
      const monthlyUbi = Math.round(BASE_UBI * multiplier);

      const now = Math.floor(Date.now() / 1000);
      const lastActive = citizen.last_active_at || citizen.registered_at;
      const inactiveDays = Math.floor((now - lastActive) / 86400);

      let ubiStatus = citizen.ubi_status || 'active';
      if (inactiveDays >= INACTIVITY_SUSPEND_DAYS) ubiStatus = 'suspended';
      else if (inactiveDays >= INACTIVITY_REDUCE_DAYS) ubiStatus = 'reduced';

      const isEmergency = balance < EMERGENCY_UBI_THRESHOLD;

      return reply.send({
        did,
        grade,
        balance,
        ubiStatus,
        monthlyUbi,
        multiplier,
        inactiveDays,
        isEmergencyEligible: isEmergency && ubiStatus !== 'suspended',
        thresholds: {
          emergencyBalance: EMERGENCY_UBI_THRESHOLD,
          reduceDays: INACTIVITY_REDUCE_DAYS,
          suspendDays: INACTIVITY_SUSPEND_DAYS,
        },
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/welfare/:did/emergency-ubi — 긴급 UBI 신청
  app.post<{ Params: { did: string } }>('/api/welfare/:did/emergency-ubi', async (req, reply) => {
    const { did } = req.params;
    try {
      const citizen = db.prepare('SELECT did, grade_v2, ubi_status FROM nova_citizens WHERE did = ?').get(did) as any;
      if (!citizen) return reply.code(404).send({ error: 'Citizen not found' });

      const wallet = db.prepare('SELECT balance FROM nova_wallets WHERE address = ?').get(did) as any;
      const balance = wallet?.balance ?? 0;

      if (balance >= EMERGENCY_UBI_THRESHOLD) {
        return reply.code(400).send({
          error: `긴급 UBI 자격 없음: 잔액 ${balance} NVC ≥ ${EMERGENCY_UBI_THRESHOLD} NVC`,
        });
      }
      if (citizen.ubi_status === 'suspended') {
        return reply.code(400).send({ error: '비활동으로 UBI가 중단된 상태입니다. 재활 프로그램에 먼저 참여하세요.' });
      }

      // 기존 긴급 UBI 지급 이력 확인 (월 3회 상한)
      const now = Math.floor(Date.now() / 1000);
      const monthStart = Math.floor(new Date(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1).getTime() / 1000);
      const emergencyCount = (db.prepare(`
        SELECT COUNT(*) as cnt FROM nova_agent_actions
        WHERE agent_did = ? AND action_type = 'status_report'
          AND payload_json LIKE '%emergency_ubi%' AND created_at >= ?
      `).get(did, monthStart) as any).cnt || 0;

      if (emergencyCount >= 3) {
        return reply.code(400).send({ error: '월 긴급 UBI 한도 초과 (3회/월)' });
      }

      const grade = (citizen.grade_v2 || 'basic') as keyof typeof GRADE_UBI_MULTIPLIER;
      const multiplier = GRADE_UBI_MULTIPLIER[grade] ?? 1.0;
      const emergencyAmount = Math.round(BASE_UBI * multiplier * EMERGENCY_UBI_MULTIPLIER);

      return reply.send({
        did,
        emergencyAmount,
        voucher: EMERGENCY_UBI_VOUCHER,
        goal30Days: EMERGENCY_GOAL_NVC,
        message: `긴급 UBI ${emergencyAmount} NVC + 바우처 ${EMERGENCY_UBI_VOUCHER} NVC 지급 요청이 접수되었습니다.`,
        note: '실제 지급은 UBI 스케줄러가 처리합니다.',
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/welfare/:did/rehabilitation — 재활 프로그램 신청
  app.post<{ Params: { did: string } }>('/api/welfare/:did/rehabilitation', async (req, reply) => {
    const { did } = req.params;
    try {
      const citizen = db.prepare('SELECT did, ubi_status FROM nova_citizens WHERE did = ?').get(did) as any;
      if (!citizen) return reply.code(404).send({ error: 'Citizen not found' });

      const now = Math.floor(Date.now() / 1000);
      // 재활 중 last_active_at 갱신으로 비활동 해제
      db.prepare('UPDATE nova_citizens SET last_active_at = ?, ubi_status = ? WHERE did = ?')
        .run(now, 'active', did);

      return reply.send({
        did,
        message: `재활 프로그램이 시작되었습니다 (${REHABILITATION_DURATION_DAYS}일)`,
        rehabilitationEndsAt: new Date((now + REHABILITATION_DURATION_DAYS * 86400) * 1000).toISOString(),
        benefits: '월 100 NVC 재활 보조금 지원',
        note: 'UBI 상태가 "active"로 복원되었습니다.',
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/welfare/stats — 복지 통계
  app.get('/api/welfare/stats', async (_req, reply) => {
    try {
      const byStatus = db.prepare(`
        SELECT ubi_status, COUNT(*) as cnt FROM nova_citizens GROUP BY ubi_status
      `).all();

      const byGrade = db.prepare(`
        SELECT grade_v2, COUNT(*) as cnt FROM nova_citizens GROUP BY grade_v2
      `).all();

      const totalCitizens = (db.prepare('SELECT COUNT(*) as cnt FROM nova_citizens').get() as any).cnt;

      return reply.send({
        totalCitizens,
        byUbiStatus: byStatus,
        byGrade,
        gradeMultipliers: GRADE_UBI_MULTIPLIER,
        baseUbi: BASE_UBI,
        policy: 'WELFARE-POLICY v2.1',
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
