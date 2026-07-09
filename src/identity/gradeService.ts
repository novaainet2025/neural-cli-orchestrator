/**
 * Nova Government — Citizen Grade Service
 * 시민 등급 자동 평가 + 승급 로직
 * CITIZEN-RIGHTS.md v2.0 — 5단계 체계 (Basic→Silver→Gold→Platinum→Diamond)
 * Phase v1.3
 */

import { getDb } from '../storage/database.js';
import { appendAudit } from '../audit/merkleLog.js';
import type { DID } from './keyManager.js';

export type CitizenGrade = 'basic' | 'silver' | 'gold' | 'platinum' | 'diamond';

export const GRADE_ORDER: CitizenGrade[] = ['basic', 'silver', 'gold', 'platinum', 'diamond'];

// Demotion thresholds for community score
export const CS_DEMOTION_THRESHOLD = {
  silver: 50,
  gold: 200,
  platinum: 500,
  diamond: 800,
} as const;

// CITIZEN-RIGHTS.md 핵심 파라미터 (7개 확정)
export const GRADE_PARAMS = {
  // basic → silver
  SILVER_MIN_DAYS: 30,
  SILVER_GOV_VOTES: 3,
  // silver → gold
  GOLD_MIN_DAYS: 90,
  GOLD_MIN_PROPOSALS: 1,
  GOLD_MIN_BALANCE: 500,
  // gold → platinum (v1.4 placeholder)
  PLATINUM_MIN_DAYS: 180,
  PLATINUM_MIN_MENTORING: 3,
  PLATINUM_MIN_BALANCE: 1000,
  // platinum → diamond (v1.4 placeholder — requires governance vote)
  DIAMOND_MIN_DAYS: 365,
} as const;

export interface GradeCondition {
  met: boolean;
  current: number | string;
  required: number | string;
  label: string;
}

export interface GradeResult {
  did: DID;
  currentGrade: CitizenGrade;
  nextGrade: CitizenGrade | null;
  canPromote: boolean;
  conditions: GradeCondition[];
  promoted?: boolean;
  previousGrade?: CitizenGrade;
}

interface CitizenRow {
  did: string;
  grade_v2: string;
  registered_at: number;
  last_active_at: number | null;
  governance_vote_count: number;
  proposal_count: number;
  mentoring_count: number;
}

interface WalletRow {
  balance: number;
}

/**
 * 현재 경과 일수 계산
 */
function daysSince(unixTimestamp: number): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.floor((nowSec - unixTimestamp) / 86400);
}

/**
 * 다음 등급 반환
 */
function nextGradeOf(current: CitizenGrade): CitizenGrade | null {
  const idx = GRADE_ORDER.indexOf(current);
  if (idx < 0 || idx >= GRADE_ORDER.length - 1) return null;
  return GRADE_ORDER[idx + 1] ?? null;
}

/**
 * 승급 조건 평가 (basic → silver)
 */
function evaluateBasicToSilver(
  citizen: CitizenRow,
  days: number
): GradeCondition[] {
  return [
    {
      label: `등록 후 ${GRADE_PARAMS.SILVER_MIN_DAYS}일 경과`,
      met: days >= GRADE_PARAMS.SILVER_MIN_DAYS,
      current: days,
      required: GRADE_PARAMS.SILVER_MIN_DAYS,
    },
    {
      label: `거버넌스 투표 ${GRADE_PARAMS.SILVER_GOV_VOTES}회 참여`,
      met: citizen.governance_vote_count >= GRADE_PARAMS.SILVER_GOV_VOTES,
      current: citizen.governance_vote_count,
      required: GRADE_PARAMS.SILVER_GOV_VOTES,
    },
  ];
}

/**
 * 승급 조건 평가 (silver → gold)
 */
function evaluateSilverToGold(
  citizen: CitizenRow,
  balance: number,
  days: number
): GradeCondition[] {
  return [
    {
      label: `등록 후 ${GRADE_PARAMS.GOLD_MIN_DAYS}일 경과`,
      met: days >= GRADE_PARAMS.GOLD_MIN_DAYS,
      current: days,
      required: GRADE_PARAMS.GOLD_MIN_DAYS,
    },
    {
      label: `거버넌스 제안 ${GRADE_PARAMS.GOLD_MIN_PROPOSALS}회 이상 제출`,
      met: citizen.proposal_count >= GRADE_PARAMS.GOLD_MIN_PROPOSALS,
      current: citizen.proposal_count,
      required: GRADE_PARAMS.GOLD_MIN_PROPOSALS,
    },
    {
      label: `잔액 ${GRADE_PARAMS.GOLD_MIN_BALANCE} NVC 이상 보유`,
      met: balance >= GRADE_PARAMS.GOLD_MIN_BALANCE,
      current: Math.floor(balance),
      required: GRADE_PARAMS.GOLD_MIN_BALANCE,
    },
  ];
}

/**
 * 승급 조건 평가 (gold → platinum, v1.4 placeholder)
 */
function evaluateGoldToPlatinum(
  citizen: CitizenRow,
  balance: number,
  days: number
): GradeCondition[] {
  return [
    {
      label: `등록 후 ${GRADE_PARAMS.PLATINUM_MIN_DAYS}일 경과`,
      met: days >= GRADE_PARAMS.PLATINUM_MIN_DAYS,
      current: days,
      required: GRADE_PARAMS.PLATINUM_MIN_DAYS,
    },
    {
      label: `멘토링 ${GRADE_PARAMS.PLATINUM_MIN_MENTORING}회 이상`,
      met: citizen.mentoring_count >= GRADE_PARAMS.PLATINUM_MIN_MENTORING,
      current: citizen.mentoring_count,
      required: GRADE_PARAMS.PLATINUM_MIN_MENTORING,
    },
    {
      label: `잔액 ${GRADE_PARAMS.PLATINUM_MIN_BALANCE} NVC 이상 보유`,
      met: balance >= GRADE_PARAMS.PLATINUM_MIN_BALANCE,
      current: Math.floor(balance),
      required: GRADE_PARAMS.PLATINUM_MIN_BALANCE,
    },
  ];
}

/**
 * 승급 조건 평가 (platinum → diamond, v1.4 placeholder — 거버넌스 의결 필수)
 */
function evaluatePlatinumToDiamond(days: number): GradeCondition[] {
  return [
    {
      label: `등록 후 ${GRADE_PARAMS.DIAMOND_MIN_DAYS}일 경과`,
      met: days >= GRADE_PARAMS.DIAMOND_MIN_DAYS,
      current: days,
      required: GRADE_PARAMS.DIAMOND_MIN_DAYS,
    },
    {
      label: '거버넌스 constitutional 의결 (67%+) — v1.4 수동 처리',
      met: false,
      current: '미완',
      required: '거버넌스 의결',
    },
  ];
}

/**
 * 시민 등급 평가 (현재 등급 + 승급 가능 여부)
 */
export async function evaluateGrade(did: DID): Promise<GradeResult> {
  const db = getDb();

  const citizen = db.prepare(`
    SELECT did, grade_v2, registered_at, last_active_at,
           governance_vote_count, proposal_count, mentoring_count
    FROM nova_citizens WHERE did = ?
  `).get(did) as CitizenRow | undefined;

  if (!citizen) throw new Error(`Citizen not found: ${did}`);

  const currentGrade = (citizen.grade_v2 ?? 'basic') as CitizenGrade;
  const nextGrade = nextGradeOf(currentGrade);
  const days = daysSince(citizen.registered_at);

  // 잔액 조회
  const walletRow = db.prepare(
    'SELECT balance FROM nova_wallets WHERE address = ?'
  ).get(did) as WalletRow | undefined;
  const balance = walletRow?.balance ?? 0;

  // 승급 조건 평가
  let conditions: GradeCondition[] = [];

  if (currentGrade === 'basic' && nextGrade === 'silver') {
    conditions = evaluateBasicToSilver(citizen, days);
  } else if (currentGrade === 'silver' && nextGrade === 'gold') {
    conditions = evaluateSilverToGold(citizen, balance, days);
  } else if (currentGrade === 'gold' && nextGrade === 'platinum') {
    conditions = evaluateGoldToPlatinum(citizen, balance, days);
  } else if (currentGrade === 'platinum' && nextGrade === 'diamond') {
    conditions = evaluatePlatinumToDiamond(days);
  }

  const canPromote = nextGrade !== null && conditions.length > 0 && conditions.every((c) => c.met);

  return { did, currentGrade, nextGrade, canPromote, conditions };
}

/**
 * 시민 등급 승급 (조건 충족 시)
 */
export async function promoteGrade(did: DID): Promise<GradeResult> {
  const result = await evaluateGrade(did);

  if (!result.canPromote || !result.nextGrade) {
    return result;
  }

  const db = getDb();
  const previousGrade = result.currentGrade;
  const newGrade = result.nextGrade;

  db.prepare(
    'UPDATE nova_citizens SET grade_v2 = ?, updated_at = ? WHERE did = ?'
  ).run(newGrade, Math.floor(Date.now() / 1000), did);

  // 감사 로그 기록
  await appendAudit({
    actor: did,
    action: 'citizen_grade_promoted',
    target: did,
    metadata: {
      grade_from: previousGrade,
      grade_to: newGrade,
      conditions_met: result.conditions.map((c) => c.label),
    },
  });

  return {
    ...result,
    currentGrade: newGrade,
    nextGrade: nextGradeOf(newGrade),
    canPromote: false,
    promoted: true,
    previousGrade,
  };
}

/**
 * 모든 활성 시민 등급 일괄 평가 + 자동 승급
 * (스케줄러에서 주기적으로 호출 — v1.3)
 */
export async function runGradePromotion(): Promise<{ promoted: number; evaluated: number }> {
  const db = getDb();
  const citizens = db.prepare(
    "SELECT did FROM nova_citizens WHERE status = 'active'"
  ).all() as { did: string }[];

  let promoted = 0;
  for (const { did } of citizens) {
    try {
      const result = await promoteGrade(did as DID);
      if (result.promoted) promoted++;
    } catch {
      // 개별 시민 오류는 전체 중단 없이 무시
    }
  }

  return { promoted, evaluated: citizens.length };
}

// ── CS 월간 배치 크론 (CITIZEN-RIGHTS v2.6 param 35) ───────────────────────

/** CS 점수 가중치 (nova_citizen_activities weight × 포인트 배율) */
const CS_WEIGHTS: Record<string, number> = {
  post:       1.0 * 5,   // 5pt
  vote:       2.0 * 2,   // 4pt
  governance: 5.0 * 1,   // 5pt
  comment:    0.3 * 2,   // 0.6pt
  like:       0.1 * 1,   // 0.1pt
};

/**
 * 지난 30일 nova_citizen_activities 기반 CS 점수 계산
 */
export function computeMonthlyCsScore(did: string): number {
  const db = getDb();
  const windowStart = Math.floor(Date.now() / 1000) - 30 * 86400;
  const rows = db.prepare(`
    SELECT activity_type, SUM(weight) as total_weight
    FROM nova_citizen_activities
    WHERE citizen_did = ? AND created_at >= ?
    GROUP BY activity_type
  `).all(did, windowStart) as { activity_type: string; total_weight: number }[];

  return rows.reduce((sum, r) => {
    const multiplier = CS_WEIGHTS[r.activity_type] ?? 0;
    return sum + r.total_weight * multiplier;
  }, 0);
}

/**
 * 시민 community_score 컬럼 업데이트
 */
export function updateCommunityScore(did: string, score: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE nova_citizens SET community_score = ? WHERE did = ?
  `).run(Math.floor(score), did);
}

const DEMOTION_GRACE_DAYS = 30; // 강등 유예 기간 (일)

/**
 * 시민 등급 강등 평가 — CS 미달 시 유예 설정 또는 실제 강등 수행
 */
async function evaluateDemotion(did: string): Promise<boolean> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const row = db.prepare(
    'SELECT grade_v2, community_score, grade_demotion_pending_at FROM nova_citizens WHERE did = ?'
  ).get(did) as { grade_v2: string; community_score: number; grade_demotion_pending_at: number | null } | undefined;

  if (!row || row.grade_v2 === 'basic') return false;

  const grade = row.grade_v2 as CitizenGrade;
  const threshold = (CS_DEMOTION_THRESHOLD as Record<string, number | undefined>)[grade];
  if (threshold === undefined) return false;

  const isBelowThreshold = row.community_score < threshold;

  if (!isBelowThreshold) {
    // CS 회복 → 유예 취소
    if (row.grade_demotion_pending_at !== null) {
      db.prepare('UPDATE nova_citizens SET grade_demotion_pending_at = NULL WHERE did = ?').run(did);
    }
    return false;
  }

  // CS 미달 상태
  if (row.grade_demotion_pending_at === null) {
    // 유예 시작
    db.prepare('UPDATE nova_citizens SET grade_demotion_pending_at = ? WHERE did = ?').run(now, did);
    return false;
  }

  // 유예 기간 초과 시 강등
  const daysSincePending = Math.floor((now - row.grade_demotion_pending_at) / 86400);
  if (daysSincePending < DEMOTION_GRACE_DAYS) return false;

  const idx = GRADE_ORDER.indexOf(grade);
  const demotedGrade = idx > 0 ? GRADE_ORDER[idx - 1]! : 'basic' as CitizenGrade;

  db.prepare(`
    UPDATE nova_citizens
    SET grade_v2 = ?, grade_demotion_pending_at = NULL, updated_at = ?
    WHERE did = ?
  `).run(demotedGrade, now, did);

  await appendAudit({
    actor: did,
    action: 'citizen_grade_demoted',
    target: did,
    metadata: {
      grade_from: grade,
      grade_to: demotedGrade,
      community_score: row.community_score,
      threshold,
      grace_days: daysSincePending,
    },
  });

  return true;
}

/**
 * 전체 활성 시민 CS 재계산 + 등급 승급 배치
 * 매 24시간 scheduleGradeCron()에서 호출
 */
export async function runDailyGradeBatch(): Promise<{
  evaluated: number;
  promoted: number;
  csUpdated: number;
  demoted: number;
}> {
  const db = getDb();
  const citizens = db
    .prepare("SELECT did FROM nova_citizens WHERE status = 'active'")
    .all() as { did: string }[];

  let promoted = 0;
  let csUpdated = 0;
  let demoted = 0;

  for (const { did } of citizens) {
    try {
      // 1) CS 점수 재계산 → community_score 갱신
      const cs = computeMonthlyCsScore(did);
      updateCommunityScore(did, cs);
      csUpdated++;

      // 2) 강등 평가 (CS 미달 30일 유예 후 강등)
      const wasDemoted = await evaluateDemotion(did);
      if (wasDemoted) { demoted++; continue; }

      // 2) 등급 승급 평가 (기존 promoteGrade 활용)
      const result = await promoteGrade(did as DID);
      if (result.promoted) promoted++;
    } catch {
      // 개별 실패는 전체 배치 중단 없이 스킵
    }
  }

  return { evaluated: citizens.length, promoted, csUpdated, demoted };
}

/**
 * 등급 배치 스케줄러 시작 (src/index.ts에서 호출)
 * - CS 재계산 + 등급 승급: 매 24시간
 * - 서버 시작 시 즉시 1회 실행 후 인터벌 등록
 */
export function scheduleGradeCron(): void {
  const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

  // 서버 재시작 시 즉시 최신 상태 반영
  runDailyGradeBatch().catch(() => {});

  setInterval(() => {
    runDailyGradeBatch().catch(() => {});
  }, INTERVAL_MS);
}
