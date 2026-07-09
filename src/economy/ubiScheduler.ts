/**
 * Nova Government — UBI 주간 자동 지급 스케줄러
 * WELFARE-POLICY.md 13회차 합의:
 *   - 7일 주기 자동 지급 (1,000 NVC 기본, 반감기 적용)
 *   - 비활동 30일 초과 → 50% 삭감 (ubi_status='reduced')
 *   - 비활동 90일 초과 → 중단 (ubi_status='suspended')
 * TREASURY-POLICY.md 8회차: 하드캡 10억 NVC, 반감기 10,000명/50%
 */

import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { getDb } from '../storage/database.js';
import { type DID } from '../identity/keyManager.js';
import { GOVT_ADDRESS, _updateBalance } from './walletService.js';

// ── 상수 (TREASURY-POLICY.md 확정값) ──────────────────────────────────────
const HARD_CAP = 1_000_000_000;
const MIN_INCOME = 62;
const BASE_INCOME = 1_000;
const HALVING_INTERVAL = 10_000;
const UBI_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;  // 7일
const CHECK_INTERVAL_MS = 60_000;                    // 1분마다 체크

export const GRADE_UBI_MULTIPLIER = {
  basic: 1.0,
  silver: 1.1,
  gold: 1.25,
  platinum: 1.4,
  diamond: 1.5,
};

// ── 반감기 계산 ────────────────────────────────────────────────────────────
export function getBaseUbiAmount(citizenCount: number, totalSupply: number): number {
  // 하드캡 99% 초과 시 0
  if (totalSupply >= HARD_CAP * 0.99) return 0;
  const halvings = Math.floor(citizenCount / HALVING_INTERVAL);
  const income = Math.floor(BASE_INCOME / Math.pow(2, halvings));
  return Math.max(income, MIN_INCOME);
}

// ── 등급별 UBI 배율 적용 ──────────────────────────────────────────────────
export function getGradedUbiAmount(baseAmount: number, grade_v2: string): number {
  const multiplier = GRADE_UBI_MULTIPLIER[grade_v2 as keyof typeof GRADE_UBI_MULTIPLIER] || GRADE_UBI_MULTIPLIER.basic;
  return Math.round(baseAmount * multiplier);
}

// ── 비활동 기간별 UBI 보정 ─────────────────────────────────────────────────
export function getUbiForCitizen(
  baseAmount: number,
  lastActiveAt: number | null,
  ubiStatus: string
): number {
  if (ubiStatus === 'suspended') return 0;
  if (lastActiveAt === null) return baseAmount; // 신규 등록 시민 — 초기 지급

  const nowSec = Math.floor(Date.now() / 1000);
  const inactiveDays = (nowSec - lastActiveAt) / 86400;

  if (inactiveDays > 90) return 0;       // 90일 초과 → 중단
  if (inactiveDays > 30) return Math.floor(baseAmount * 0.5); // 30일 초과 → 50%
  return baseAmount;
}

// ── UBI 지급 실행 ──────────────────────────────────────────────────────────
export async function runUbiPayment(): Promise<void> {
  const db = getDb();

  // 총 공급량 · 시민 수 조회
  const totalSupply = (db.prepare('SELECT COALESCE(SUM(balance),0) as s FROM nova_wallets').get() as { s: number }).s;
  const citizenCount = (db.prepare("SELECT COUNT(*) as c FROM nova_citizens WHERE status='active'").get() as { c: number }).c;
  const baseAmount = getBaseUbiAmount(citizenCount, totalSupply);

  if (baseAmount === 0) return; // 하드캡 또는 조건 미충족

  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffSec = nowSec - UBI_INTERVAL_MS / 1000; // 7일 전

  // 지급 대상: ubi_last_paid_at이 null 또는 7일+ 경과한 active 시민
  type CitizenRow = { did: string; last_active_at: number | null; ubi_status: string; grade_v2: string };
  const eligibleCitizens = db.prepare(`
    SELECT did, last_active_at, ubi_status, grade_v2
    FROM nova_citizens
    WHERE status = 'active'
      AND (ubi_last_paid_at IS NULL OR ubi_last_paid_at <= ?)
  `).all(cutoffSec) as CitizenRow[];

  if (eligibleCitizens.length === 0) return;

  // Merkle 이전 해시 조회
  const lastEntry = db.prepare('SELECT hash FROM nova_audit_log ORDER BY timestamp DESC LIMIT 1').get() as { hash: string } | undefined;
  let prevHash = lastEntry?.hash ?? '0'.repeat(64);

  // 트랜잭션으로 일괄 지급
  const pay = db.transaction(() => {
    for (const citizen of eligibleCitizens) {
      const ubiAmountAfterActivity = getUbiForCitizen(baseAmount, citizen.last_active_at, citizen.ubi_status);
      const finalAmount = getGradedUbiAmount(ubiAmountAfterActivity, citizen.grade_v2);
      const newUbiStatus = (() => {
        if (citizen.last_active_at === null) return 'active';
        const days = (nowSec - citizen.last_active_at) / 86400;
        if (days > 90) return 'suspended';
        if (days > 30) return 'reduced';
        return 'active';
      })();

      // UBI 상태 갱신
      db.prepare(`
        UPDATE nova_citizens
        SET ubi_status = ?, ubi_last_paid_at = ?, updated_at = ?
        WHERE did = ?
      `).run(newUbiStatus, nowSec, nowSec, citizen.did);

      if (finalAmount <= 0) continue;

      // 잔액 지급 (GOVT_ADDRESS가 없으면 신규 발행)
      _updateBalance(citizen.did as DID, finalAmount, db);

      // nova_audit_log 기록
      const entryId = randomUUID();
      const metadata = JSON.stringify({ amount: finalAmount, ubi_status: newUbiStatus, base_amount: baseAmount, grade_v2: citizen.grade_v2 });
      const entryData = `${entryId}${nowSec}SYSTEM:ubi_scheduler:ubi_payment:${citizen.did}:${metadata}:${prevHash}`;
      const hash = createHash('sha256').update(entryData).digest('hex');

      db.prepare(`
        INSERT INTO nova_audit_log (id, timestamp, actor, action, target, metadata, severity, hash, prev_hash)
        VALUES (?, ?, 'SYSTEM', 'ubi_payment', ?, ?, 'info', ?, ?)
      `).run(entryId, nowSec, citizen.did, metadata, hash, prevHash);

      prevHash = hash;
    }
  });

  pay();
}

// ── 스케줄러 시작 ──────────────────────────────────────────────────────────
let _schedulerRunning = false;

export function scheduleUbi(): void {
  if (_schedulerRunning) return;
  _schedulerRunning = true;

  // 1분마다 체크 (7일 경과 시민만 실제 지급)
  setInterval(async () => {
    try {
      await runUbiPayment();
    } catch (err) {
      // 스케줄러 오류는 로그만 기록 (서버 중단 금지)
      console.error('[UBI Scheduler] Error during payment run:', err);
    }
  }, CHECK_INTERVAL_MS);

  console.log('[UBI Scheduler] Started — checking every 1 min, paying every 7 days');
}
