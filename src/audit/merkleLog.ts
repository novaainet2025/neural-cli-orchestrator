/**
 * Nova Government — Merkle Audit Log
 * 변조 불가 SHA-256 체인 감사 기록
 * Phase 6: Audit & Protection
 */

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../storage/database.js';

const GENESIS_HASH = '0'.repeat(64);
const LEGACY_EPOCH_ID = 'legacy';
const CANONICAL_DIGEST_VERSION = 'nco-audit-canonical-v1';
const CHECKPOINT_HASH_VERSION = 'nco-audit-checkpoint-v1';

export type AuditAction =
  // Identity
  | 'citizen_registered' | 'citizen_suspended' | 'citizen_revoked'
  // Credentials
  | 'vc_issued' | 'vc_revoked'
  // Economy
  | 'wallet_created' | 'large_transfer' | 'escrow_created' | 'escrow_disputed' | 'ubi_payment'
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
  | 'diplomacy_nation_register' | 'diplomacy_treaty_signed' | 'diplomacy_message_sent'
  // Security policy evaluation
  | 'policy_violation'
  // Memory (TEMPORAL-POLICY)
  | 'memory_create' | 'memory_delete' | 'memory_share'
  // Identity — Grade
  | 'citizen_grade_promoted'
  | 'citizen_grade_demoted'
  // AI Rights (AIRIGHTS-POLICY v2.1)
  | 'rights_violation'
  | 'rights_guardian_activated'
  // Audit recovery (explicit operator checkpoint)
  | 'audit_epoch_started';

export type AuditSeverity = 'debug' | 'info' | 'warn' | 'critical';
export type AuditVerificationScope = 'history' | 'current';

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
  epochId: string;
  chainSeq: number;
}

export interface AuditEpoch {
  epochId: string;
  sequenceNo: number;
  createdAt: number;
  actor: string;
  reason: string;
  incidentEvidence: Record<string, unknown>;
  expectedFirstInvalidId: string;
  sourceRowCount: number;
  sourceMaxChainSeq: number;
  sourceTipRowid: number;
  sourceTipId?: string;
  sourceTipHash?: string;
  sourceCanonicalDigest: string;
  anchorHash: string;
  previousCheckpointHash: string;
  checkpointHash: string;
}

export interface AppendAuditInput {
  actor: string;
  action: AuditAction;
  target?: string;
  metadata?: Record<string, unknown>;
  severity?: AuditSeverity;
}

export interface BeginAuditEpochInput {
  acknowledgeCompromisedHistory: true;
  expectedFirstInvalidId: string;
  actor: string;
  reason: string;
  incidentEvidence: Record<string, unknown>;
}

export interface ChainVerificationResult {
  valid: boolean;
  checkedCount: number;
  firstInvalidId?: string;
  error?: string;
}

export interface ScopedAuditVerification extends ChainVerificationResult {
  scope: AuditVerificationScope;
  currentEpochId: string;
  currentEpochValid: boolean;
  currentEpochCheckedCount: number;
  currentEpochFirstInvalidId?: string;
  currentEpochError?: string;
  historicalInvalid: boolean;
}

interface AuditRow extends Record<string, unknown> {
  rowid: number;
  chain_seq: number;
  id: string;
  timestamp: number;
  actor: string;
  action: string;
  target: string | null;
  metadata: string;
  severity: AuditSeverity;
  hash: string;
  prev_hash: string;
  epoch_id: string;
}

interface EpochRow extends Record<string, unknown> {
  epoch_id: string;
  sequence_no: number;
  created_at: number;
  actor: string;
  reason: string;
  incident_evidence: string;
  expected_first_invalid_id: string;
  source_row_count: number;
  source_max_chain_seq: number;
  source_tip_rowid: number;
  source_tip_id: string | null;
  source_tip_hash: string | null;
  source_canonical_digest: string;
  anchor_hash: string;
  previous_checkpoint_hash: string;
  checkpoint_hash: string;
}

/**
 * 감사 엔트리 해시 계산.
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
  prevHash: string,
): string {
  return createHash('sha256')
    .update(`${id}|${timestamp}|${actor}|${action}|${target}|${metadata}|${severity}|${prevHash}`)
    .digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Value is not JSON serializable');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

function updateLengthPrefixed(hash: ReturnType<typeof createHash>, value: unknown): void {
  const text = value === null || value === undefined ? '<null>' : String(value);
  hash.update(`${Buffer.byteLength(text, 'utf8')}:`);
  hash.update(text);
}

function getLatestEpoch(database: Database.Database): AuditEpoch | null {
  const row = database.prepare(`
    SELECT epoch_id, sequence_no, created_at, actor, reason, incident_evidence,
           expected_first_invalid_id, source_row_count, source_max_chain_seq,
           source_tip_rowid, source_tip_id, source_tip_hash,
           source_canonical_digest, anchor_hash, previous_checkpoint_hash, checkpoint_hash
    FROM nova_audit_epochs
    ORDER BY sequence_no DESC
    LIMIT 1
  `).get() as EpochRow | undefined;
  return row ? rowToEpoch(row) : null;
}

export function getCurrentAuditEpoch(database: Database.Database = getDb()): AuditEpoch | null {
  return getLatestEpoch(database);
}

function canonicalDigestUpTo(
  database: Database.Database,
  maxChainSeq: number,
): { digest: string; rowCount: number } {
  const hash = createHash('sha256');
  hash.update(`${CANONICAL_DIGEST_VERSION}\n`);
  const rows = database.prepare(`
    SELECT rowid, chain_seq, id, timestamp, actor, action, target, metadata, severity,
           hash, prev_hash, epoch_id
    FROM nova_audit_log
    WHERE chain_seq <= ?
    ORDER BY chain_seq ASC
  `).iterate(maxChainSeq) as IterableIterator<AuditRow>;

  let rowCount = 0;
  for (const row of rows) {
    updateCanonicalDigest(hash, row);
    rowCount += 1;
  }

  return { digest: hash.digest('hex'), rowCount };
}

function updateCanonicalDigest(hash: ReturnType<typeof createHash>, row: AuditRow): void {
  for (const field of [
    row.chain_seq,
    row.id,
    row.timestamp,
    row.actor,
    row.action,
    row.target,
    row.metadata,
    row.severity,
    row.hash,
    row.prev_hash,
    row.epoch_id,
  ]) {
    updateLengthPrefixed(hash, field);
  }
  hash.update('\n');
}

function computeCheckpointHash(epoch: Omit<AuditEpoch, 'checkpointHash'>): string {
  const hash = createHash('sha256');
  hash.update(`${CHECKPOINT_HASH_VERSION}\n`);
  for (const field of [
    epoch.epochId,
    epoch.sequenceNo,
    epoch.createdAt,
    epoch.actor,
    epoch.reason,
    stableJson(epoch.incidentEvidence),
    epoch.expectedFirstInvalidId,
    epoch.sourceRowCount,
    epoch.sourceMaxChainSeq,
    epoch.sourceTipRowid,
    epoch.sourceTipId,
    epoch.sourceTipHash,
    epoch.sourceCanonicalDigest,
    epoch.anchorHash,
    epoch.previousCheckpointHash,
  ]) {
    updateLengthPrefixed(hash, field);
  }
  return hash.digest('hex');
}

function validateEpochSnapshot(
  epoch: AuditEpoch,
  digest: string,
  rowCount: number,
  sourceTip: Pick<AuditRow, 'id' | 'hash'> | undefined,
): { valid: true } | { valid: false; error: string } {
  if (rowCount !== epoch.sourceRowCount) {
    return { valid: false, error: 'epoch source row count mismatch' };
  }
  if (digest !== epoch.sourceCanonicalDigest || epoch.anchorHash !== digest) {
    return { valid: false, error: 'epoch anchor mismatch' };
  }
  if (
    (epoch.sourceMaxChainSeq > 0 && !sourceTip)
    || sourceTip?.id !== epoch.sourceTipId
    || sourceTip?.hash !== epoch.sourceTipHash
  ) {
    return { valid: false, error: 'epoch source tip mismatch' };
  }
  const { checkpointHash: _storedCheckpointHash, ...epochWithoutHash } = epoch;
  const expectedCheckpointHash = computeCheckpointHash(epochWithoutHash);
  if (epoch.checkpointHash !== expectedCheckpointHash) {
    return { valid: false, error: 'epoch checkpoint metadata mismatch' };
  }
  return { valid: true };
}

function validateEpochLineage(
  database: Database.Database,
  throughSequence: number,
): { valid: true } | { valid: false; error: string } {
  const rows = database.prepare(`
    SELECT epoch_id, sequence_no, created_at, actor, reason, incident_evidence,
           expected_first_invalid_id, source_row_count, source_max_chain_seq,
           source_tip_rowid, source_tip_id, source_tip_hash,
           source_canonical_digest, anchor_hash, previous_checkpoint_hash, checkpoint_hash
    FROM nova_audit_epochs
    WHERE sequence_no <= ?
    ORDER BY sequence_no ASC
  `).all(throughSequence) as EpochRow[];
  if (rows.length !== throughSequence) {
    return { valid: false, error: 'epoch sequence gap' };
  }

  let expectedPreviousCheckpointHash = GENESIS_HASH;
  let expectedSequence = 1;
  const epochs = rows.map(rowToEpoch);
  for (const epoch of epochs) {
    if (epoch.sequenceNo !== expectedSequence) {
      return { valid: false, error: 'epoch sequence mismatch' };
    }
    if (epoch.previousCheckpointHash !== expectedPreviousCheckpointHash) {
      return { valid: false, error: 'epoch checkpoint lineage mismatch' };
    }
    expectedPreviousCheckpointHash = epoch.checkpointHash;
    expectedSequence += 1;
  }

  const digest = createHash('sha256');
  digest.update(`${CANONICAL_DIGEST_VERSION}\n`);
  let rowCount = 0;
  let epochIndex = 0;
  const maxChainSeq = epochs.at(-1)?.sourceMaxChainSeq ?? 0;

  const validateReadyEpochs = (tip: AuditRow | undefined) => {
    while (epochIndex < epochs.length && epochs[epochIndex]!.sourceMaxChainSeq === (tip?.chain_seq ?? 0)) {
      const snapshot = validateEpochSnapshot(
        epochs[epochIndex]!,
        digest.copy().digest('hex'),
        rowCount,
        tip,
      );
      if (!snapshot.valid) return snapshot;
      epochIndex += 1;
    }
    return { valid: true } as const;
  };

  const emptySnapshot = validateReadyEpochs(undefined);
  if (!emptySnapshot.valid) return emptySnapshot;
  const sourceRows = database.prepare(`
    SELECT rowid, chain_seq, id, timestamp, actor, action, target, metadata, severity,
           hash, prev_hash, epoch_id
    FROM nova_audit_log
    WHERE chain_seq <= ?
    ORDER BY chain_seq ASC
  `).iterate(maxChainSeq) as IterableIterator<AuditRow>;
  for (const row of sourceRows) {
    updateCanonicalDigest(digest, row);
    rowCount += 1;
    const snapshot = validateReadyEpochs(row);
    if (!snapshot.valid) return snapshot;
  }
  if (epochIndex !== epochs.length) return { valid: false, error: 'epoch source boundary missing' };
  return { valid: true };
}

/** 감사 로그 추가. 현재 epoch 선택과 tail 조회/INSERT는 한 write transaction이다. */
export function appendAudit(
  input: AppendAuditInput,
  database: Database.Database = getDb(),
): AuditEntry {
  const id = randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);
  const target = input.target ?? '';
  const metadata = JSON.stringify(input.metadata ?? {});
  const severity = input.severity ?? 'info';
  let epochId = LEGACY_EPOCH_ID;
  let chainSeq = 0;
  let prevHash = GENESIS_HASH;
  let hash = '';

  const perform = () => {
    const epoch = getLatestEpoch(database);
    epochId = epoch?.epochId ?? LEGACY_EPOCH_ID;
    const lastRow = database.prepare(`
      SELECT hash
      FROM nova_audit_log
      WHERE epoch_id = ?
      ORDER BY chain_seq DESC
      LIMIT 1
    `).get(epochId) as { hash: string } | undefined;

    prevHash = lastRow?.hash ?? epoch?.anchorHash ?? GENESIS_HASH;
    chainSeq = (database.prepare(
      'SELECT COALESCE(MAX(chain_seq), 0) + 1 AS next_seq FROM nova_audit_log',
    ).get() as { next_seq: number }).next_seq;
    hash = computeHash(id, timestamp, input.actor, input.action, target, metadata, severity, prevHash);
    database.prepare(`
      INSERT INTO nova_audit_log
        (id, timestamp, actor, action, target, metadata, severity, hash, prev_hash, epoch_id, chain_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, timestamp, input.actor, input.action, target, metadata, severity, hash, prevHash, epochId, chainSeq);
  };

  const transaction = database.transaction(perform);
  if (database.inTransaction) transaction();
  else transaction.immediate();

  return {
    id,
    timestamp,
    actor: input.actor,
    action: input.action,
    target: target || undefined,
    metadata: input.metadata ?? {},
    severity,
    hash,
    prevHash,
    epochId,
    chainSeq,
  };
}

/**
 * Start an epoch only after an operator explicitly acknowledges the exact
 * invalid row observed in the scope being recovered. Existing audit rows and
 * hashes are read-only; the canonical digest becomes the new epoch anchor.
 */
export function beginAuditEpoch(
  input: BeginAuditEpochInput,
  database: Database.Database = getDb(),
): AuditEpoch {
  if (input.acknowledgeCompromisedHistory !== true) {
    throw new Error('Explicit compromised-history acknowledgment is required');
  }
  const actor = input.actor.trim();
  const reason = input.reason.trim();
  const expectedFirstInvalidId = input.expectedFirstInvalidId.trim();
  if (!actor || !reason || !expectedFirstInvalidId) {
    throw new Error('actor, reason and expectedFirstInvalidId are required');
  }
  if (
    !input.incidentEvidence
    || Array.isArray(input.incidentEvidence)
    || typeof input.incidentEvidence !== 'object'
    || Object.keys(input.incidentEvidence).length === 0
  ) {
    throw new Error('incidentEvidence must be a non-empty object');
  }
  let canonicalIncidentEvidence: Record<string, unknown>;
  try {
    canonicalIncidentEvidence = JSON.parse(JSON.stringify(input.incidentEvidence)) as Record<string, unknown>;
  } catch {
    throw new Error('incidentEvidence must be JSON serializable');
  }
  if (Object.keys(canonicalIncidentEvidence).length === 0) {
    throw new Error('incidentEvidence must retain at least one JSON field');
  }
  const incidentEvidenceJson = stableJson(canonicalIncidentEvidence);
  if (Buffer.byteLength(incidentEvidenceJson, 'utf8') > 65_536) {
    throw new Error('incidentEvidence exceeds 64 KiB');
  }

  let created: AuditEpoch | null = null;
  const perform = () => {
    const priorEpoch = getLatestEpoch(database);
    const compromised = priorEpoch
      ? verifyEpoch(database, priorEpoch)
      : verifyLegacy(database);
    if (compromised.valid || !compromised.firstInvalidId) {
      throw new Error('Current audit scope is valid; a recovery epoch is not permitted');
    }
    if (compromised.firstInvalidId !== expectedFirstInvalidId) {
      throw new Error(
        `first invalid audit id changed: expected ${expectedFirstInvalidId}, observed ${compromised.firstInvalidId}`,
      );
    }

    const boundary = database.prepare(`
      SELECT COALESCE(MAX(chain_seq), 0) AS max_chain_seq, COUNT(*) AS row_count
      FROM nova_audit_log
    `).get() as { max_chain_seq: number; row_count: number };
    const tip = database.prepare(`
      SELECT rowid, id, hash
      FROM nova_audit_log
      ORDER BY chain_seq DESC
      LIMIT 1
    `).get() as { rowid: number; id: string; hash: string } | undefined;
    const canonical = canonicalDigestUpTo(database, boundary.max_chain_seq);
    if (canonical.rowCount !== boundary.row_count) {
      throw new Error('Audit history changed while computing the epoch anchor');
    }

    const sequenceNo = (priorEpoch?.sequenceNo ?? 0) + 1;
    const epochWithoutHash: Omit<AuditEpoch, 'checkpointHash'> = {
      epochId: randomUUID(),
      sequenceNo,
      createdAt: Math.floor(Date.now() / 1000),
      actor,
      reason,
      incidentEvidence: canonicalIncidentEvidence,
      expectedFirstInvalidId,
      sourceRowCount: canonical.rowCount,
      sourceMaxChainSeq: boundary.max_chain_seq,
      sourceTipRowid: tip?.rowid ?? 0,
      sourceTipId: tip?.id,
      sourceTipHash: tip?.hash,
      sourceCanonicalDigest: canonical.digest,
      anchorHash: canonical.digest,
      previousCheckpointHash: priorEpoch?.checkpointHash ?? GENESIS_HASH,
    };
    const epoch: AuditEpoch = {
      ...epochWithoutHash,
      checkpointHash: computeCheckpointHash(epochWithoutHash),
    };

    database.prepare(`
      INSERT INTO nova_audit_epochs (
        epoch_id, sequence_no, created_at, actor, reason, incident_evidence,
        expected_first_invalid_id, source_row_count, source_max_chain_seq,
        source_tip_rowid, source_tip_id, source_tip_hash,
        source_canonical_digest, anchor_hash, previous_checkpoint_hash, checkpoint_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      epoch.epochId,
      epoch.sequenceNo,
      epoch.createdAt,
      epoch.actor,
      epoch.reason,
      incidentEvidenceJson,
      epoch.expectedFirstInvalidId,
      epoch.sourceRowCount,
      epoch.sourceMaxChainSeq,
      epoch.sourceTipRowid,
      epoch.sourceTipId ?? null,
      epoch.sourceTipHash ?? null,
      epoch.sourceCanonicalDigest,
      epoch.anchorHash,
      epoch.previousCheckpointHash,
      epoch.checkpointHash,
    );
    appendAudit({
      actor: epoch.actor,
      action: 'audit_epoch_started',
      target: epoch.epochId,
      metadata: {
        checkpointHash: epoch.checkpointHash,
        legacyCanonicalDigest: epoch.sourceCanonicalDigest,
        expectedFirstInvalidId: epoch.expectedFirstInvalidId,
      },
      severity: 'critical',
    }, database);
    created = epoch;
  };

  const transaction = database.transaction(perform);
  if (database.inTransaction) transaction();
  else transaction.immediate();
  if (!created) throw new Error('Audit epoch transaction did not produce a checkpoint');
  return created;
}

/** 감사 로그 조회 (페이징). */
export function queryAuditLog(opts: {
  actor?: string;
  action?: AuditAction;
  target?: string;
  severity?: AuditSeverity;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
  scope?: 'all' | 'current';
}): { entries: AuditEntry[]; total: number; scope: 'all' | 'current'; epochId?: string } {
  const database = getDb();
  const conditions: string[] = [];
  const args: unknown[] = [];

  if (opts.actor) { conditions.push('actor = ?'); args.push(opts.actor); }
  if (opts.action) { conditions.push('action = ?'); args.push(opts.action); }
  if (opts.target) { conditions.push('target = ?'); args.push(opts.target); }
  if (opts.severity) { conditions.push('severity = ?'); args.push(opts.severity); }
  if (opts.from) { conditions.push('timestamp >= ?'); args.push(opts.from); }
  if (opts.to) { conditions.push('timestamp <= ?'); args.push(opts.to); }

  const scope = opts.scope ?? 'all';
  const currentEpochId = scope === 'current'
    ? getLatestEpoch(database)?.epochId ?? LEGACY_EPOCH_ID
    : undefined;
  if (currentEpochId) {
    conditions.push('epoch_id = ?');
    args.push(currentEpochId);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  const total = (database.prepare(`SELECT COUNT(*) as n FROM nova_audit_log ${where}`)
    .get(...args) as { n: number }).n;
  const rows = database.prepare(`
    SELECT rowid, chain_seq, id, timestamp, actor, action, target, metadata, severity,
           hash, prev_hash, epoch_id
    FROM nova_audit_log ${where}
    ORDER BY chain_seq DESC
    LIMIT ? OFFSET ?
  `).all(...args, limit, offset) as AuditRow[];

  return {
    total,
    scope,
    ...(currentEpochId ? { epochId: currentEpochId } : {}),
    entries: rows.map(rowToEntry),
  };
}

function verifyRows(
  rows: Iterable<AuditRow>,
  initialPrevHash: string,
): ChainVerificationResult {
  let prevHash = initialPrevHash;
  let checkedCount = 0;
  for (const row of rows) {
    const expectedHash = computeHash(
      row.id,
      row.timestamp,
      row.actor,
      row.action,
      row.target ?? '',
      row.metadata,
      row.severity,
      row.prev_hash,
    );
    if (row.prev_hash !== prevHash) {
      return { valid: false, checkedCount, firstInvalidId: row.id, error: 'prev_hash mismatch' };
    }
    if (row.hash !== expectedHash) {
      return { valid: false, checkedCount, firstInvalidId: row.id, error: 'hash mismatch (tampered)' };
    }
    prevHash = row.hash;
    checkedCount += 1;
  }
  return { valid: true, checkedCount };
}

function normalizedPageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize)) return 1000;
  return Math.max(1, Math.min(10_000, Math.floor(pageSize)));
}

function* rowsForEpoch(
  database: Database.Database,
  epochId: string,
  requestedPageSize: number,
): Generator<AuditRow> {
  const pageSize = normalizedPageSize(requestedPageSize);
  const statement = database.prepare(`
    SELECT rowid, chain_seq, id, timestamp, actor, action, target, metadata, severity,
           hash, prev_hash, epoch_id
    FROM nova_audit_log
    WHERE epoch_id = ? AND chain_seq > ?
    ORDER BY chain_seq ASC
    LIMIT ?
  `);
  let lastChainSeq = -1;
  for (;;) {
    const page = statement.all(epochId, lastChainSeq, pageSize) as AuditRow[];
    if (page.length === 0) return;
    yield* page;
    lastChainSeq = page[page.length - 1]!.chain_seq;
  }
}

function verifyLegacy(database: Database.Database, pageSize = 1000): ChainVerificationResult {
  return verifyRows(rowsForEpoch(database, LEGACY_EPOCH_ID, pageSize), GENESIS_HASH);
}

function verifyEpoch(
  database: Database.Database,
  epoch: AuditEpoch,
  pageSize = 1000,
): ChainVerificationResult {
  const lineage = validateEpochLineage(database, epoch.sequenceNo);
  if (!lineage.valid) return { valid: false, checkedCount: 0, error: lineage.error };
  return verifyRows(rowsForEpoch(database, epoch.epochId, pageSize), epoch.anchorHash);
}

function verifyWholeHistory(database: Database.Database, pageSize = 1000): ChainVerificationResult {
  const legacy = verifyLegacy(database, pageSize);
  if (!legacy.valid) return legacy;
  const epochRows = database.prepare(`
    SELECT epoch_id, sequence_no, created_at, actor, reason, incident_evidence,
           expected_first_invalid_id, source_row_count, source_max_chain_seq,
           source_tip_rowid, source_tip_id, source_tip_hash,
           source_canonical_digest, anchor_hash, previous_checkpoint_hash, checkpoint_hash
    FROM nova_audit_epochs
    ORDER BY sequence_no ASC
  `).all() as EpochRow[];
  let checkedCount = legacy.checkedCount;
  for (const epochRow of epochRows) {
    const result = verifyEpoch(database, rowToEpoch(epochRow), pageSize);
    if (!result.valid) return { ...result, checkedCount: checkedCount + result.checkedCount };
    checkedCount += result.checkedCount;
  }
  return { valid: true, checkedCount };
}

/** 이전 API 호환: 전체 history 결과만 반환한다. */
export function verifyChainIntegrity(pageSize = 1000): ChainVerificationResult {
  return verifyWholeHistory(getDb(), pageSize);
}

export function verifyAuditIntegrity(
  scope: AuditVerificationScope = 'history',
  pageSizeOrDatabase: number | Database.Database = 1000,
  explicitDatabase?: Database.Database,
): ScopedAuditVerification {
  // Backward compatible with the existing `(scope, database)` API while also
  // allowing HTTP callers to bound verification memory via `(scope, pageSize)`.
  const pageSize = typeof pageSizeOrDatabase === 'number' ? pageSizeOrDatabase : 1000;
  const database = typeof pageSizeOrDatabase === 'number'
    ? explicitDatabase ?? getDb()
    : pageSizeOrDatabase;
  const history = verifyWholeHistory(database, pageSize);
  const currentEpoch = getLatestEpoch(database);
  const current = currentEpoch
    ? verifyEpoch(database, currentEpoch, pageSize)
    : verifyLegacy(database, pageSize);
  const selected = scope === 'current' ? current : history;
  return {
    ...selected,
    scope,
    currentEpochId: currentEpoch?.epochId ?? LEGACY_EPOCH_ID,
    currentEpochValid: current.valid,
    currentEpochCheckedCount: current.checkedCount,
    ...(current.firstInvalidId ? { currentEpochFirstInvalidId: current.firstInvalidId } : {}),
    ...(current.error ? { currentEpochError: current.error } : {}),
    historicalInvalid: !history.valid,
  };
}

/** 특정 해시를 해당 epoch 경계 기준으로 검증한다. */
export function verifyEntry(
  entryId: string,
  database: Database.Database = getDb(),
): { valid: boolean; entry?: AuditEntry; error?: string } {
  const row = database.prepare(`
    SELECT rowid, chain_seq, id, timestamp, actor, action, target, metadata, severity,
           hash, prev_hash, epoch_id
    FROM nova_audit_log
    WHERE id = ?
  `).get(entryId) as AuditRow | undefined;
  if (!row) return { valid: false };

  const epoch = row.epoch_id === LEGACY_EPOCH_ID
    ? null
    : database.prepare(`
        SELECT epoch_id, sequence_no, created_at, actor, reason, incident_evidence,
               expected_first_invalid_id, source_row_count, source_max_chain_seq,
               source_tip_rowid, source_tip_id, source_tip_hash,
               source_canonical_digest, anchor_hash, previous_checkpoint_hash, checkpoint_hash
        FROM nova_audit_epochs
        WHERE epoch_id = ?
      `).get(row.epoch_id) as EpochRow | undefined;
  if (row.epoch_id !== LEGACY_EPOCH_ID && !epoch) {
    return { valid: false, entry: rowToEntry(row), error: 'epoch metadata missing' };
  }
  if (epoch) {
    const lineage = validateEpochLineage(database, epoch.sequence_no);
    if (!lineage.valid) {
      return { valid: false, entry: rowToEntry(row), error: lineage.error };
    }
  }

  const previousRow = database.prepare(`
    SELECT rowid, chain_seq, id, timestamp, actor, action, target, metadata, severity,
           hash, prev_hash, epoch_id
    FROM nova_audit_log
    WHERE epoch_id = ?
      AND chain_seq < ?
    ORDER BY chain_seq DESC
    LIMIT 1
  `).get(row.epoch_id, row.chain_seq) as AuditRow | undefined;

  const expectedHash = computeHash(
    row.id,
    row.timestamp,
    row.actor,
    row.action,
    row.target ?? '',
    row.metadata,
    row.severity,
    row.prev_hash,
  );
  const expectedPrevHash = previousRow?.hash
    ?? (epoch ? epoch.anchor_hash : GENESIS_HASH);
  const previousHashValid = previousRow
    ? previousRow.hash === computeHash(
        previousRow.id,
        previousRow.timestamp,
        previousRow.actor,
        previousRow.action,
        previousRow.target ?? '',
        previousRow.metadata,
        previousRow.severity,
        previousRow.prev_hash,
      )
    : true;

  return {
    valid: row.hash === expectedHash && row.prev_hash === expectedPrevHash && previousHashValid,
    entry: rowToEntry(row),
  };
}

function rowToEpoch(row: EpochRow): AuditEpoch {
  return {
    epochId: row.epoch_id,
    sequenceNo: row.sequence_no,
    createdAt: row.created_at,
    actor: row.actor,
    reason: row.reason,
    incidentEvidence: JSON.parse(row.incident_evidence) as Record<string, unknown>,
    expectedFirstInvalidId: row.expected_first_invalid_id,
    sourceRowCount: row.source_row_count,
    sourceMaxChainSeq: row.source_max_chain_seq,
    sourceTipRowid: row.source_tip_rowid,
    sourceTipId: row.source_tip_id ?? undefined,
    sourceTipHash: row.source_tip_hash ?? undefined,
    sourceCanonicalDigest: row.source_canonical_digest,
    anchorHash: row.anchor_hash,
    previousCheckpointHash: row.previous_checkpoint_hash,
    checkpointHash: row.checkpoint_hash,
  };
}

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    actor: row.actor,
    action: row.action as AuditAction,
    target: row.target || undefined,
    metadata: JSON.parse(row.metadata ?? '{}') as Record<string, unknown>,
    severity: row.severity,
    hash: row.hash,
    prevHash: row.prev_hash,
    epochId: row.epoch_id,
    chainSeq: row.chain_seq,
  };
}
