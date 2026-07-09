/**
 * Nova Government — 위협 수준 관리 서비스
 * L1→L2 (24h 타임아웃), L2→L3 (error_rate ≥50%), 비상 정지, 정지 만료
 */
import { getDb } from '../storage/database.js';

/** 위협 수준 상수 */
const THRESHOLD = {
  L1_ERROR_RATE: 0.02,
  L2_ERROR_RATE: 0.05,
  L3_ERROR_RATE: 0.15,
  L1_TIMEOUT_MS: 86400000,
} as const;

// Backward compatible constants
const L1_TIMEOUT_SEC = THRESHOLD.L1_TIMEOUT_MS / 1000;
const ERROR_RATE_THRESHOLD = THRESHOLD.L2_ERROR_RATE;
const METRICS_URL = 'http://localhost:6200/metrics';

/**
 * L1 → L2 에스컬레이션: 24시간 초과 시 자동 승급
 */
export function scheduleL1toL2(): void {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - L1_TIMEOUT_SEC;

  const update = db.prepare(`
    UPDATE nova_threat_levels
    SET level = 'L2',
        escalated_at = strftime('%s','now'),
        escalation_reason = '24h timeout'
    WHERE level = 'L1'
      AND status = 'active'
      AND created_at < ?
  `);
  update.run(cutoff);
}

/**
 * L2 → L3 에스컬레이션: /metrics error_rate ≥ 0.5 시 승급
 */
export async function checkL2toL3(): Promise<void> {
  const db = getDb();

  // L2 활성 위협 존재 여부 확인
  const row = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM nova_threat_levels
    WHERE level = 'L2' AND status = 'active'
  `).get() as { cnt: number };

  if (!row || row.cnt === 0) return;

  // /metrics API 호출
  let errorRate = 0;
  try {
    const res = await fetch(METRICS_URL);
    const text = await res.text();

    // error_rate 파싱 (Prometheus 형식: error_rate 0.X 또는 JSON)
    const jsonMatch = text.match(/"error_rate"\s*:\s*([\d.]+)/);
    const promMatch = text.match(/error_rate\s+([\d.]+)/);
    const matched = jsonMatch ?? promMatch;
    if (matched) {
      errorRate = parseFloat(matched[1]);
    }
  } catch {
    // 메트릭 API 오류 시 에스컬레이션 건너뜀
    return;
  }

  if (errorRate >= ERROR_RATE_THRESHOLD) {
    const update = db.prepare(`
      UPDATE nova_threat_levels
      SET level = 'L3',
          escalated_at = strftime('%s','now'),
          escalation_reason = ?
      WHERE level = 'L2' AND status = 'active'
    `);
    update.run(`error_rate=${errorRate.toFixed(3)} >= ${ERROR_RATE_THRESHOLD}`);
  }
}

/**
 * 비상 정지 적용
 * @param pauseUntil 정지 종료 시각 (unix timestamp)
 */
export function applyEmergencyPause(pauseUntil: number): void {
  const db = getDb();
  const update = db.prepare(`
    UPDATE nova_threat_levels
    SET status = 'paused',
        pause_until = ?
    WHERE status = 'active'
  `);
  update.run(pauseUntil);
}

/**
 * 정지 만료 확인: pause_until ≤ 현재 시각이면 resolved 처리
 */
export function checkPauseExpiry(): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const update = db.prepare(`
    UPDATE nova_threat_levels
    SET status = 'resolved',
        pause_until = NULL
    WHERE status = 'paused'
      AND pause_until <= ?
  `);
  update.run(now);
}

/**
 * 위협 수준 스케줄러 시작
 * - L1→L2: 1시간마다
 * - L2→L3: 5분마다
 * - 정지 만료: 10분마다
 */
export function startThreatLevelScheduler(): void {
  // L1 → L2 (24시간 타임아웃 체크, 1시간마다)
  setInterval(() => {
    scheduleL1toL2();
  }, 3_600_000);

  // L2 → L3 (error_rate 체크, 5분마다)
  setInterval(() => {
    checkL2toL3().catch(() => {
      // 비동기 에러 무시 (메트릭 일시 불가)
    });
  }, 300_000);

  // 정지 만료 (10분마다)
  setInterval(() => {
    checkPauseExpiry();
  }, 600_000);
}
