/**
 * Nova Government — 탈세 탐지 서비스
 * 60초 슬라이딩 윈도우, 5초 버킷(12개) 분할이체 탐지
 */
import { getDb } from '../storage/database.js';

/** 슬라이딩 윈도우 설정 */
const WINDOW_SEC = 60;
const THRESHOLD = 5; // 60초 내 이체 횟수 임계값

/**
 * 이체 활동 기록 및 rapid_cycle 탐지
 * nova_tax_evasion_log 스키마: suspect_did, timestamp, type, details
 * @param did 이체 주체 DID
 * @param amount 이체 금액
 */
export function recordActivity(did: string, amount: number): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // 이체 기록 저장 (large_tx 타입 — 기존 check constraint 재사용)
  const insert = db.prepare(`
    INSERT INTO nova_tax_evasion_log (suspect_did, timestamp, type, details)
    VALUES (?, ?, 'large_tx', ?)
  `);
  insert.run(did, now, JSON.stringify({ amount, window_check: true }));

  // 슬라이딩 윈도우 검사 → 임계값 초과 시 rapid_cycle 기록
  const result = checkSlidingWindow(did);
  if (result.flagged) {
    const flag = db.prepare(`
      INSERT INTO nova_tax_evasion_log (suspect_did, timestamp, type, details)
      VALUES (?, ?, 'rapid_cycle', ?)
    `);
    flag.run(did, now, JSON.stringify({ count: result.count, window_sec: WINDOW_SEC, amount }));
  }
}

/**
 * 60초 슬라이딩 윈도우 내 이체 횟수 조회
 * @param did 조회 대상 DID
 * @returns flagged: 임계값 초과 여부, count: 60초 내 이체 횟수
 */
export function checkSlidingWindow(did: string): { flagged: boolean; count: number } {
  const db = getDb();
  const windowStart = Math.floor(Date.now() / 1000) - WINDOW_SEC;

  const row = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM nova_tax_evasion_log
    WHERE suspect_did = ?
      AND timestamp >= ?
      AND type = 'large_tx'
  `).get(did, windowStart) as { cnt: number };

  const count = row?.cnt ?? 0;
  return {
    flagged: count >= THRESHOLD,
    count,
  };
}
