/**
 * Nova Government — Merkle Audit Log
 * 변조 불가 SHA-256 체인 감사 기록
 * Phase 6: Audit & Protection
 */

import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../storage/database.js';

export type AuditAction =
  // Identity
  | 'citizen_registered' | 'citizen_suspended' | 'citizen_revoked'
  // Credentials
  | 'vc_issued' | 'vc_revoked'
  // Economy
  | 'wallet_created' | 'large_transfer' | 'escrow_created' | 'escrow_disputed'
  // Governance
  | 'proposal_created' | 'vote_cast' | 'proposal_executed'
  | 'emergency_stop_triggered' | 'emergency_stop_lifted'
  // Domain
  | 'domain_registered' | 'domain_transferred' | 'domain_disputed' | 'squatting_detected'
  // Marketplace
  | 'artwork_registered' | 'artwork_sold_large'
  // Security
  | 'did_spoof_attempt' | 'double_spend_attempt' | 'blacklist_added' | 'blacklist_removed'
  // Diplomacy
  | 'create_nation' | 'create_treaty' | 'send_message' | 'ack_message'
  // Memory (TEMPORAL-POLICY)
  | 'memory_create' | 'memory_delete' | 'memory_share'
  // Identity — Grade
  | 'citizen_grade_promoted'
  | 'citizen_grade_demoted'
  // AI Rights (AIRIGHTS-POLICY v2.1)
  | 'rights_violation'
  | 'rights_guardian_activated';

export type AuditSeverity = 'debug' | 'info' | 'warn' | 'critical';

export interface AuditEntry {
  id: string;
  timestamp: number;
  actor: string;
  action: AuditAction;
  target?: string;
  metadata: Record<string, unknown>;
  severity: AuditSeverity;
  hash: string;
  prevHash: string;
}

export interface AppendAuditInput {
  actor: string;
  action: AuditAction;
  target?: string;
  metadata?: Record<string, unknown>;
  severity?: AuditSeverity;
}

/**
 * Merkle 해시 계산
 * hash = SHA-256(id + timestamp + actor + action + target + metadata + severity + prevHash)
 */
function computeHash(
  id: string,
  timestamp: number,
  actor: string,
  action: string,
  target: string,
  metadata: string,
  severity: AuditSeverity,
  prevHash: string
): string {
  return createHash('sha256')
    .update(`${id}|${timestamp}|${actor}|${action}|${target}|${metadata}|${severity}|${prevHash}`)
    .digest('hex');
}

/**
 * 감사 로그 추가 (자동 Merkle 체인)
 */
export function appendAudit(input: AppendAuditInput): AuditEntry {
  const db = getDb();

  const id = randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);
  const target = input.target ?? '';
  const metadata = JSON.stringify(input.metadata ?? {});
  const severity = input.severity ?? 'info';

  let prevHash = '0'.repeat(64);
  let hash = '';

  // db.transaction()은 중첩 시 SAVEPOINT를 사용 → 상위 db.transaction() 내부에서
  // 호출돼도 "cannot start a transaction within a transaction" 없이 원자성 보장
  // (raw BEGIN IMMEDIATE는 중첩 불가라 domainService 등 트랜잭션 내 감사호출을 깨뜨림).
  const runAudit = db.transaction(() => {
    const lastRow = db.prepare(
      'SELECT hash FROM nova_audit_log ORDER BY timestamp DESC, rowid DESC LIMIT 1'
    ).get() as { hash: string } | undefined;

    prevHash = lastRow?.hash ?? prevHash;
    hash = computeHash(id, timestamp, input.actor, input.action, target, metadata, severity, prevHash);

    db.prepare(`
      INSERT INTO nova_audit_log (id, timestamp, actor, action, target, metadata, severity, hash, prev_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, timestamp, input.actor, input.action, target, metadata, severity, hash, prevHash);
  });
  runAudit();

  return {
    id, timestamp,
    actor: input.actor,
    action: input.action,
    target: target || undefined,
    metadata: input.metadata ?? {},
    severity, hash, prevHash,
  };
}

/**
 * 감사 로그 조회 (페이징)
 */
export function queryAuditLog(opts: {
  actor?: string;
  action?: AuditAction;
  target?: string;
  severity?: AuditSeverity;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}): { entries: AuditEntry[]; total: number } {
  const db = getDb();
  const conditions: string[] = [];
  const args: unknown[] = [];

  if (opts.actor) { conditions.push('actor = ?'); args.push(opts.actor); }
  if (opts.action) { conditions.push('action = ?'); args.push(opts.action); }
  if (opts.target) { conditions.push('target = ?'); args.push(opts.target); }
  if (opts.severity) { conditions.push('severity = ?'); args.push(opts.severity); }
  if (opts.from) { conditions.push('timestamp >= ?'); args.push(opts.from); }
  if (opts.to) { conditions.push('timestamp <= ?'); args.push(opts.to); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const total = (db.prepare(`SELECT COUNT(*) as n FROM nova_audit_log ${where}`)
    .get(...args) as { n: number }).n;

  const rows = db.prepare(`
    SELECT id, timestamp, actor, action, target, metadata, severity, hash, prev_hash
    FROM nova_audit_log ${where}
    ORDER BY timestamp DESC, rowid DESC
    LIMIT ? OFFSET ?
  `).all(...args, limit, offset) as Record<string, unknown>[];

  return {
    total,
    entries: rows.map(rowToEntry),
  };
}

/**
 * Merkle 체인 무결성 검증
 * 전체 체인을 순서대로 재계산하여 변조 여부 확인
 */
export function verifyChainIntegrity(pageSize = 1000): {
  valid: boolean;
  checkedCount: number;
  firstInvalidId?: string;
  error?: string;
} {
  const db = getDb();
  let prevHash = '0'.repeat(64);
  let checkedCount = 0;
  let offset = 0;

  for (;;) {
    const rows = db.prepare(`
      SELECT id, timestamp, actor, action, target, metadata, severity, prev_hash, hash
      FROM nova_audit_log
      ORDER BY timestamp ASC, rowid ASC
      LIMIT ? OFFSET ?
    `).all(pageSize, offset) as Record<string, unknown>[];

    if (rows.length === 0) break;

    for (const row of rows) {
      const expectedHash = computeHash(
        row['id'] as string,
        row['timestamp'] as number,
        row['actor'] as string,
        row['action'] as string,
        (row['target'] as string) ?? '',
        row['metadata'] as string,
        row['severity'] as AuditSeverity,
        row['prev_hash'] as string
      );

      if (row['prev_hash'] !== prevHash) {
        return { valid: false, checkedCount, firstInvalidId: row['id'] as string, error: 'prev_hash mismatch' };
      }
      if (row['hash'] !== expectedHash) {
        return { valid: false, checkedCount, firstInvalidId: row['id'] as string, error: 'hash mismatch (tampered)' };
      }

      prevHash = row['hash'] as string;
      checkedCount += 1;
    }

    offset += rows.length;
  }

  return { valid: true, checkedCount };
}

/**
 * 특정 해시 단독 검증
 */
export function verifyEntry(entryId: string): { valid: boolean; entry?: AuditEntry } {
  const db = getDb();

  const row = db.prepare(`
    SELECT rowid, id, timestamp, actor, action, target, metadata, severity, hash, prev_hash
    FROM nova_audit_log WHERE id = ?
  `).get(entryId) as Record<string, unknown> | undefined;

  if (!row) return { valid: false };

  const previousRow = db.prepare(`
    SELECT id, timestamp, actor, action, target, metadata, severity, hash, prev_hash
    FROM nova_audit_log
    WHERE timestamp < ? OR (timestamp = ? AND rowid < ?)
    ORDER BY timestamp DESC, rowid DESC
    LIMIT 1
  `).get(
    row['timestamp'] as number,
    row['timestamp'] as number,
    row['rowid'] as number
  ) as Record<string, unknown> | undefined;

  const expectedHash = computeHash(
    row['id'] as string,
    row['timestamp'] as number,
    row['actor'] as string,
    row['action'] as string,
    (row['target'] as string) ?? '',
    row['metadata'] as string,
    row['severity'] as AuditSeverity,
    row['prev_hash'] as string
  );

  const expectedPrevHash = previousRow?.['hash'] as string | undefined ?? '0'.repeat(64);
  const previousHashValid = previousRow
    ? previousRow['hash'] === computeHash(
      previousRow['id'] as string,
      previousRow['timestamp'] as number,
      previousRow['actor'] as string,
      previousRow['action'] as string,
      (previousRow['target'] as string) ?? '',
      previousRow['metadata'] as string,
      previousRow['severity'] as AuditSeverity,
      previousRow['prev_hash'] as string
    )
    : true;

  return {
    valid: row['hash'] === expectedHash && row['prev_hash'] === expectedPrevHash && previousHashValid,
    entry: rowToEntry(row),
  };
}

function rowToEntry(row: Record<string, unknown>): AuditEntry {
  return {
    id: row['id'] as string,
    timestamp: row['timestamp'] as number,
    actor: row['actor'] as string,
    action: row['action'] as AuditAction,
    target: (row['target'] as string) || undefined,
    metadata: JSON.parse(row['metadata'] as string ?? '{}'),
    severity: row['severity'] as AuditSeverity,
    hash: row['hash'] as string,
    prevHash: row['prev_hash'] as string,
  };
}
