/**
 * Nova Government — Dispute Resolution Service
 * 분쟁 조정·중재·DAO 투표 (3단계)
 * Phase 6: Governance Advanced
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/database.js';
import { type DID } from '../identity/keyManager.js';
import { listCitizens } from '../identity/credentialService.js';
import { refundEscrow } from '../economy/escrowService.js';

export type DisputeType = 'escrow' | 'copyright' | 'citizenship' | 'constitutional';
export type DisputeStatus = 'stage_1' | 'stage_2' | 'stage_3' | 'resolved' | 'dismissed' | 'failed';

const DISPUTE_DEADLINES: Record<DisputeType, number> = {
  escrow: 5 * 24 * 3600,         // 5일
  copyright: 7 * 24 * 3600,      // 7일
  citizenship: 14 * 24 * 3600,   // 14일
  constitutional: 21 * 24 * 3600, // 21일
};

const STAGE_1_DURATION = 72 * 3600; // 72시간
const STAGE_3_DURATION = 7 * 24 * 3600; // 7일 (DAO 투표)

export interface Dispute {
  disputeId: string;
  disputeType: DisputeType;
  claimant: DID;
  defendant: DID;
  targetId?: string;
  description?: string;
  evidenceUrl?: string;
  amount: number;
  cost: number;
  status: DisputeStatus;
  assignedArbitrators: DID[];
  stage1EndAt: number;
  stage2EndAt: number;
  stage3EndAt: number;
  totalDeadlineAt: number;
  createdAt: number;
}

/**
 * 분쟁 생성 (3단계 절차 시작)
 */
export function createDispute(input: {
  type: DisputeType;
  claimant: DID;
  defendant: DID;
  targetId?: string;
  description?: string;
  evidenceUrl?: string;
  amount?: number;
}): Dispute {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const amount = input.amount || 0;

  // 1. 보복 행위 방지 (1년 내 재신고 시 무고 처리 - 여기서는 생성 차단)
  const retaliation = db.prepare(`
    SELECT last_reported_at FROM nova_dispute_retaliation 
    WHERE reporter = ? AND target = ?
  `).get(input.claimant, input.defendant) as { last_reported_at: number } | undefined;

  if (retaliation) {
    const diff = now - retaliation.last_reported_at;
    if (diff < 365 * 24 * 3600) {
      throw new Error(`Retaliation prevention: Cannot report same target within 1 year. (Wait ${Math.ceil((365 * 24 * 3600 - diff) / 86400)} more days)`);
    }
  }

  // 2. 조정 비용 계산 (1%, 최소 5 NVC, 최대 100 NVC)
  const cost = Math.max(5, Math.min(100, Math.floor(amount * 0.01)));

  // 3. 중재자 선발 (무작위 3인 + 전문 분야 가중치 - 여기서는 단순 무작위 3인)
  const allActive = listCitizens('active');
  const pool = allActive.filter(c => c.did !== input.claimant && c.did !== input.defendant);
  if (pool.length < 3) throw new Error('Not enough active citizens to form an arbitrator panel');
  
  const assigned = pool
    .sort(() => 0.5 - Math.random())
    .slice(0, 3)
    .map(c => c.did);

  // 4. 시간 설정
  const totalDuration = DISPUTE_DEADLINES[input.type];
  const totalDeadlineAt = now + totalDuration;
  const stage1EndAt = now + STAGE_1_DURATION;
  
  // Stage 3는 항상 7일, Stage 2는 그 사이의 남은 시간
  const stage3EndAt = totalDeadlineAt;
  const stage2EndAt = Math.max(stage1EndAt, totalDeadlineAt - STAGE_3_DURATION);

  const disputeId = randomUUID();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO nova_disputes (
        dispute_id, dispute_type, claimant, defendant, target_id, description, evidence_url,
        amount, cost, status, assigned_arbitrators,
        stage_1_end_at, stage_2_end_at, stage_3_end_at, total_deadline_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stage_1', ?, ?, ?, ?, ?, ?)
    `).run(
      disputeId, input.type, input.claimant, input.defendant, input.targetId || null,
      input.description || null, input.evidenceUrl || null, amount, cost,
      JSON.stringify(assigned), stage1EndAt, stage2EndAt, stage3EndAt, totalDeadlineAt, now
    );

    // 보복 방지 테이블 업데이트
    db.prepare(`
      INSERT OR REPLACE INTO nova_dispute_retaliation (reporter, target, last_reported_at)
      VALUES (?, ?, ?)
    `).run(input.claimant, input.defendant, now);
  })();

  return {
    disputeId,
    disputeType: input.type,
    claimant: input.claimant,
    defendant: input.defendant,
    targetId: input.targetId,
    description: input.description,
    evidenceUrl: input.evidenceUrl,
    amount,
    cost,
    status: 'stage_1',
    assignedArbitrators: assigned,
    stage1EndAt,
    stage2EndAt,
    stage3EndAt,
    totalDeadlineAt,
    createdAt: now,
  };
}

/**
 * 분쟁 조회
 */
export function getDispute(disputeId: string): Dispute | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM nova_disputes WHERE dispute_id = ?').get(disputeId) as Record<string, any> | undefined;

  if (!row) return null;

  return {
    disputeId: row.dispute_id,
    disputeType: row.dispute_type,
    claimant: row.claimant,
    defendant: row.defendant,
    targetId: row.target_id,
    description: row.description,
    evidenceUrl: row.evidence_url,
    amount: row.amount,
    cost: row.cost,
    status: row.status,
    assignedArbitrators: JSON.parse(row.assigned_arbitrators),
    stage1EndAt: row.stage_1_end_at,
    stage2EndAt: row.stage_2_end_at,
    stage3EndAt: row.stage_3_end_at,
    totalDeadlineAt: row.total_deadline_at,
    createdAt: row.created_at,
  };
}

/**
 * 분쟁 단계 업데이트 (자동 에스컬레이션 또는 판결에 의해 호출)
 */
export function updateDisputeStatus(disputeId: string, newStatus: DisputeStatus): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    UPDATE nova_disputes 
    SET status = ?, updated_at = ? 
    WHERE dispute_id = ?
  `).run(newStatus, now, disputeId);
}

/**
 * 타임아웃 체크 및 자동 단계 이동/실패 처리
 */
export function checkDisputeTimeouts(): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // 1. 전체 마감 시간 경과 -> 실패(failed) 처리
  const timedOut = db.prepare(`
    SELECT dispute_id, dispute_type, target_id, defendant 
    FROM nova_disputes 
    WHERE status NOT IN ('resolved', 'dismissed', 'failed')
      AND total_deadline_at <= ?
  `).all(now) as { dispute_id: string; dispute_type: string; target_id: string; defendant: string }[];

  for (const d of timedOut) {
    db.transaction(() => {
      updateDisputeStatus(d.dispute_id, 'failed');
      
      // 에스크로 분쟁인 경우 자동 환불 (조정 실패 시 자동 에스크로 반환)
      if (d.dispute_type === 'escrow' && d.target_id) {
        try {
          refundEscrow(d.target_id, d.defendant as DID); 
        } catch (e) {
          console.error(`Failed to auto-refund escrow ${d.target_id}:`, e);
        }
      }
    })();
  }

  // 2. 단계별 에스컬레이션 (Stage 1 -> Stage 2)
  db.prepare(`
    UPDATE nova_disputes 
    SET status = 'stage_2', updated_at = ?
    WHERE status = 'stage_1' AND stage_1_end_at <= ?
  `).run(now, now);

  // 3. 단계별 에스컬레이션 (Stage 2 -> Stage 3)
  db.prepare(`
    UPDATE nova_disputes 
    SET status = 'stage_3', updated_at = ?
    WHERE status = 'stage_2' AND stage_2_end_at <= ?
  `).run(now, now);
}
