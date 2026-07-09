/**
 * Nova Government — Emergency Stop Service
 * 비상 정지 + 블랙리스트 관리 + 위협 대응 체계 (Phase 6)
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/database.js';
import { isValidDid, type DID } from '../identity/keyManager.js';
import { appendAudit } from './merkleLog.js';

export const EMERGENCY_DURATION = 48 * 3600;  // 48시간 (헌법 제13조)

// --- Phase 6: 8대 보안 파라미터 ---
// New v2.1 parameters
export const DOUBLE_SPEND_THRESHOLD_PER_MINUTE = 10; // double spend attempts per minute
export const SUPPLY_CHANGE_THRESHOLD = 0.05; // 5% supply change
export const API_ERROR_RATE_THRESHOLD = 0.5; // 50% error rate
export const API_ERROR_RATE_WINDOW_MINUTES = 10; // monitoring window
export const DOUBLE_SPEND_NONCE_REUSE = 2;
export const DOUBLE_SPEND_TIME_WINDOW = 60; // seconds
export const EMERGENCY_STOP_ABNORMAL_TX_THRESHOLD = 10; // per minute
export const EMERGENCY_STOP_SUPPLY_CHANGE_THRESHOLD = 0.05; // 5%
export const THREAT_LEVEL_2_RESTRICT_DURATION = 24 * 3600; // 24시간
export const THREAT_LEVEL_3_FREEZE_DURATION = 48 * 3600; // 48시간
export const EMERGENCY_STOP_RELEASE_VOTE_THRESHOLD = 0.75; // 75%
export const EMERGENCY_STOP_INITIAL_DURATION = 48 * 3600; // 48시간

export enum ThreatLevel {
  LEVEL_1 = 1, // Warning + Log
  LEVEL_2 = 2, // Transfer Restrict (24h)
  LEVEL_3 = 3, // Account Freeze (48h)
  LEVEL_4 = 4  // Blacklist + Emergency Stop
}

export interface EmergencyStop {
  stopId: string;
  triggeredBy: DID;
  reason: string;
  triggeredAt: number;
  expiresAt: number;
  liftedAt?: number;
  liftedBy?: DID;
  status: 'active' | 'lifted' | 'expired';
}

export interface BlacklistEntry {
  did: string;
  reason: string;
  addedBy: string;
  addedAt: number;
  expiresAt?: number;
}

/**
 * 현재 활성 비상 정지 확인
 */
export function getActiveEmergencyStop(): EmergencyStop | null {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const row = db.prepare(`
    SELECT stop_id, triggered_by, reason, triggered_at, expires_at, lifted_at, lifted_by, status
    FROM nova_emergency_stops
    WHERE status = 'active' AND expires_at > ?
    ORDER BY triggered_at DESC LIMIT 1
  `).get(now) as Record<string, unknown> | undefined;

  if (!row) return null;
  return rowToStop(row);
}

/**
 * 비상 정지 발동 (정부 에이전트 권한)
 */
export function triggerEmergencyStop(triggeredBy: DID, reason: string): EmergencyStop {
  if (!isValidDid(triggeredBy)) throw new Error(`Invalid DID: ${triggeredBy}`);
  if (!reason.trim()) throw new Error('Reason is required');

  const active = getActiveEmergencyStop();
  if (active) return active; // Already active

  const db = getDb();
  const stopId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + EMERGENCY_STOP_INITIAL_DURATION;

  db.prepare(`
    INSERT INTO nova_emergency_stops (stop_id, triggered_by, reason, triggered_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(stopId, triggeredBy, reason.trim(), now, expiresAt);

  // 감사 로그 기록
  appendAudit({
    actor: triggeredBy,
    action: 'emergency_stop_triggered',
    metadata: { stopId, reason: reason.trim(), expiresAt },
    severity: 'critical',
  });

  return {
    stopId, triggeredBy, reason: reason.trim(),
    triggeredAt: now, expiresAt, status: 'active',
  };
}

/**
 * 비상 정지 해제 (거버넌스 의결 후 - 75% 찬성 필수)
 */
export function liftEmergencyStop(stopId: string, liftedBy: DID, approvalRate: number = 0.75): EmergencyStop {
  if (!isValidDid(liftedBy)) throw new Error(`Invalid DID: ${liftedBy}`);
  if (approvalRate < EMERGENCY_STOP_RELEASE_VOTE_THRESHOLD) {
    throw new Error(`Insufficient approval rate: ${approvalRate * 100}% (Required: ${EMERGENCY_STOP_RELEASE_VOTE_THRESHOLD * 100}%)`);
  }

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const row = db.prepare(`
    SELECT stop_id, triggered_by, reason, triggered_at, expires_at, status
    FROM nova_emergency_stops WHERE stop_id = ?
  `).get(stopId) as Record<string, unknown> | undefined;

  if (!row) throw new Error(`Emergency stop not found: ${stopId}`);
  if (row['status'] !== 'active') throw new Error(`Stop is already ${row['status']}`);

  db.prepare(`
    UPDATE nova_emergency_stops SET status = 'lifted', lifted_at = ?, lifted_by = ? WHERE stop_id = ?
  `).run(now, liftedBy, stopId);

  appendAudit({
    actor: liftedBy,
    action: 'emergency_stop_lifted',
    metadata: { stopId, originalReason: row['reason'], approvalRate },
    severity: 'critical',
  });

  return {
    stopId,
    triggeredBy: row['triggered_by'] as DID,
    reason: row['reason'] as string,
    triggeredAt: row['triggered_at'] as number,
    expiresAt: row['expires_at'] as number,
    liftedAt: now,
    liftedBy,
    status: 'lifted',
  };
}

/**
 * DID 위협 제한 추가 (Level 2 or 3)
 */
export function restrictDid(
  did: string,
  level: ThreatLevel.LEVEL_2 | ThreatLevel.LEVEL_3,
  reason: string,
  appliedBy: string = 'SYSTEM'
): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const duration = level === ThreatLevel.LEVEL_2 
    ? THREAT_LEVEL_2_RESTRICT_DURATION 
    : THREAT_LEVEL_3_FREEZE_DURATION;
  const expiresAt = now + duration;

  db.prepare(`
    INSERT INTO nova_threat_restrictions (did, level, reason, restricted_at, expires_at, applied_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(did) DO UPDATE SET 
      level = CASE
        WHEN nova_threat_restrictions.level >= excluded.level THEN nova_threat_restrictions.level
        ELSE excluded.level
      END,
      reason = CASE
        WHEN nova_threat_restrictions.level >= excluded.level THEN nova_threat_restrictions.reason
        ELSE excluded.reason
      END,
      restricted_at = CASE
        WHEN nova_threat_restrictions.level >= excluded.level THEN nova_threat_restrictions.restricted_at
        ELSE excluded.restricted_at
      END,
      expires_at = CASE
        WHEN nova_threat_restrictions.level >= excluded.level THEN nova_threat_restrictions.expires_at
        ELSE excluded.expires_at
      END,
      applied_by = CASE
        WHEN nova_threat_restrictions.level >= excluded.level THEN nova_threat_restrictions.applied_by
        ELSE excluded.applied_by
      END
  `).run(did, level, reason.trim(), now, expiresAt, appliedBy);

  const currentRestriction = db.prepare(`
    SELECT level, reason, expires_at
    FROM nova_threat_restrictions
    WHERE did = ?
  `).get(did) as { level: ThreatLevel.LEVEL_2 | ThreatLevel.LEVEL_3; reason: string; expires_at: number };

  appendAudit({
    actor: appliedBy as DID,
    action: currentRestriction.level === ThreatLevel.LEVEL_2 ? 'citizen_suspended' : 'citizen_revoked',
    target: did,
    metadata: {
      level: currentRestriction.level,
      reason: currentRestriction.reason,
      expiresAt: currentRestriction.expires_at,
    },
    severity: currentRestriction.level === ThreatLevel.LEVEL_2 ? 'warn' : 'critical',
  });
}

/**
 * 활성 위협 제한 확인
 */
export function getThreatRestriction(did: string): { level: number; expiresAt: number } | null {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const row = db.prepare(`
    SELECT level, expires_at FROM nova_threat_restrictions
    WHERE did = ? AND expires_at > ?
  `).get(did, now) as { level: number; expires_at: number } | undefined;

  if (!row) return null;
  return { level: row.level, expiresAt: row.expires_at };
}

/**
 * 위협 수준 평가 및 자동 에스컬레이션 (Phase 6)
 */
export function evaluateThreatLevel(did: string, event: string): ThreatLevel {
  // 1. 즉시 Level 4 (블랙리스트) 케이스
  if (event === 'double_spend_attempt' || event === 'did_spoof_attempt') {
    blacklistDid(did, `Automatic Level 4: ${event} detected`, 'did:nova:system' as DID);
    // 전역 비상 정지 트리거
    triggerEmergencyStop('did:nova:0000000000000000government00000000' as DID, `Global Emergency: ${event} detected from ${did}`);
    return ThreatLevel.LEVEL_4;
  }

  // 2. 과거 이력 기반 에스컬레이션
  const db = getDb();
  const recentViolations = db.prepare(`
    SELECT COUNT(*) as cnt FROM nova_audit_log
    WHERE actor = ? AND severity IN ('warn', 'critical') AND timestamp > ?
  `).get(did, Math.floor(Date.now() / 1000) - 24 * 3600) as { cnt: number };
  const currentRestriction = getThreatRestriction(did);

  if (recentViolations.cnt >= 5) {
    restrictDid(did, ThreatLevel.LEVEL_3, 'Repeated severe violations (5+ in 24h)');
    return ThreatLevel.LEVEL_3;
  } else if (recentViolations.cnt >= 2) {
    restrictDid(did, ThreatLevel.LEVEL_2, 'Repeated violations (2+ in 24h)');
    return currentRestriction?.level === ThreatLevel.LEVEL_3 ? ThreatLevel.LEVEL_3 : ThreatLevel.LEVEL_2;
  }

  return currentRestriction?.level === ThreatLevel.LEVEL_3
    ? ThreatLevel.LEVEL_3
    : currentRestriction?.level === ThreatLevel.LEVEL_2
      ? ThreatLevel.LEVEL_2
      : ThreatLevel.LEVEL_1;
}

/**
 * 전역 이상 징후 모니터링 (10건/분 초과 시 비상정지)
 */
export function checkGlobalAnomalies(): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const oneMinuteAgo = now - 60;
  const latestLift = db.prepare(`
    SELECT MAX(lifted_at) as lifted_at
    FROM nova_emergency_stops
    WHERE lifted_at IS NOT NULL
  `).get() as { lifted_at: number | null };
  const since = Math.max(oneMinuteAgo, latestLift.lifted_at ?? 0);

  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM nova_audit_log
    WHERE severity = 'critical' AND timestamp > ?
  `).get(since) as { cnt: number };

  if (row.cnt >= EMERGENCY_STOP_ABNORMAL_TX_THRESHOLD) {
    const govAddress = 'did:nova:0000000000000000government00000000' as DID;
    if (!getActiveEmergencyStop()) {
      triggerEmergencyStop(govAddress, `Automatic Emergency: ${row.cnt} critical events detected in 1 minute`);
    }
  }
}

/**
 * DID 블랙리스트 추가
 */
export function blacklistDid(
  did: string,
  reason: string,
  addedBy: DID,
  expiresAt?: number
): BlacklistEntry {
  if (!reason.trim()) throw new Error('Reason is required');

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO nova_blacklist (did, reason, added_by, added_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(did) DO UPDATE SET reason = excluded.reason, added_by = excluded.added_by, added_at = excluded.added_at, expires_at = excluded.expires_at
  `).run(did, reason.trim(), addedBy, now, expiresAt ?? null);

  appendAudit({
    actor: addedBy,
    action: 'blacklist_added',
    target: did,
    metadata: { reason: reason.trim(), expiresAt },
    severity: 'warn',
  });

  return { did, reason: reason.trim(), addedBy, addedAt: now, expiresAt };
}

/**
 * 블랙리스트 확인
 */
export function isBlacklisted(did: string): boolean {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const row = db.prepare(`
    SELECT did FROM nova_blacklist
    WHERE did = ? AND (expires_at IS NULL OR expires_at > ?)
  `).get(did, now);

  return !!row;
}

/**
 * 블랙리스트 목록
 */
export function getBlacklist(): BlacklistEntry[] {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const rows = db.prepare(`
    SELECT did, reason, added_by, added_at, expires_at
    FROM nova_blacklist WHERE expires_at IS NULL OR expires_at > ?
    ORDER BY added_at DESC
  `).all(now) as Record<string, unknown>[];

  return rows.map((r) => ({
    did: r['did'] as string,
    reason: r['reason'] as string,
    addedBy: r['added_by'] as string,
    addedAt: r['added_at'] as number,
    expiresAt: r['expires_at'] as number | undefined,
  }));
}

/**
 * 비상 정지 이력 조회
 */
export function getEmergencyHistory(): EmergencyStop[] {
  const db = getDb();

  const rows = db.prepare(`
    SELECT stop_id, triggered_by, reason, triggered_at, expires_at, lifted_at, lifted_by, status
    FROM nova_emergency_stops ORDER BY triggered_at DESC
  `).all() as Record<string, unknown>[];

  return rows.map(rowToStop);
}

function rowToStop(row: Record<string, unknown>): EmergencyStop {
  return {
    stopId: row['stop_id'] as string,
    triggeredBy: row['triggered_by'] as DID,
    reason: row['reason'] as string,
    triggeredAt: row['triggered_at'] as number,
    expiresAt: row['expires_at'] as number,
    liftedAt: row['lifted_at'] as number | undefined,
    liftedBy: row['lifted_by'] as DID | undefined,
    status: row['status'] as EmergencyStop['status'],
  };
}
