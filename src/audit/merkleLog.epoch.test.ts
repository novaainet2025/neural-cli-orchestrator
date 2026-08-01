import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, runMigrations } from '../storage/database.js';
import {
  appendAudit,
  beginAuditEpoch,
  getCurrentAuditEpoch,
  queryAuditLog,
  verifyAuditIntegrity,
  verifyChainIntegrity,
  verifyEntry,
} from './merkleLog.js';

const incident = { incidentId: 'INC-2026-08-01', evidenceSha256: 'a'.repeat(64) };

function compromiseLegacy(): { firstId: string; invalidId: string } {
  const first = appendAudit({ actor: 'did:nova:test', action: 'wallet_created' });
  const second = appendAudit({ actor: 'did:nova:test', action: 'large_transfer' });
  getDb().prepare('UPDATE nova_audit_log SET prev_hash = ? WHERE id = ?')
    .run('f'.repeat(64), second.id);
  return { firstId: first.id, invalidId: second.id };
}

function beginInput(invalidId: string) {
  return {
    acknowledgeCompromisedHistory: true as const,
    expectedFirstInvalidId: invalidId,
    actor: 'operator:test',
    reason: 'fixture contamination acknowledged with retained evidence',
    incidentEvidence: incident,
  };
}

describe('audit epoch recovery checkpoints', () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM nova_audit_log').run();
    db.prepare('DELETE FROM nova_audit_epochs').run();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps legacy rows and hashes unchanged while anchoring a non-empty current epoch', () => {
    const { invalidId } = compromiseLegacy();
    const db = getDb();
    const before = db.prepare(`
      SELECT id, timestamp, actor, action, target, metadata, severity,
             hash, prev_hash, epoch_id, chain_seq
      FROM nova_audit_log
      ORDER BY chain_seq
    `).all();

    const epoch = beginAuditEpoch(beginInput(invalidId));
    const legacyAfter = db.prepare(`
      SELECT id, timestamp, actor, action, target, metadata, severity,
             hash, prev_hash, epoch_id, chain_seq
      FROM nova_audit_log
      WHERE epoch_id = 'legacy'
      ORDER BY chain_seq
    `).all();
    expect(legacyAfter).toEqual(before);

    const current = queryAuditLog({ scope: 'current' });
    expect(current.total).toBe(1);
    expect(current.entries[0]).toMatchObject({
      action: 'audit_epoch_started',
      epochId: epoch.epochId,
      prevHash: epoch.anchorHash,
    });
    expect(current.entries[0]?.metadata).toMatchObject({
      checkpointHash: epoch.checkpointHash,
      legacyCanonicalDigest: epoch.sourceCanonicalDigest,
      expectedFirstInvalidId: invalidId,
    });

    const history = verifyAuditIntegrity('history');
    expect(history).toMatchObject({
      valid: false,
      firstInvalidId: invalidId,
      historicalInvalid: true,
      currentEpochValid: true,
      currentEpochCheckedCount: 1,
    });
    expect(verifyAuditIntegrity('current')).toMatchObject({
      valid: true,
      checkedCount: 1,
      historicalInvalid: true,
    });
    expect(verifyEntry(current.entries[0]!.id)).toMatchObject({ valid: true });
  });

  it('rejects stale acknowledgment without leaving epoch metadata or an entry', () => {
    const { invalidId } = compromiseLegacy();
    const beforeCount = (getDb().prepare('SELECT COUNT(*) AS n FROM nova_audit_log').get() as { n: number }).n;
    expect(() => beginAuditEpoch(beginInput(`${invalidId}-stale`))).toThrow(/first invalid audit id changed/);
    expect(getCurrentAuditEpoch()).toBeNull();
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM nova_audit_log').get() as { n: number }).n)
      .toBe(beforeCount);
  });

  it('rolls epoch metadata and its canonical first entry back with an outer transaction', () => {
    const { invalidId } = compromiseLegacy();
    const db = getDb();
    const outer = db.transaction(() => {
      beginAuditEpoch(beginInput(invalidId), db);
      throw new Error('force outer rollback');
    });
    expect(() => outer.immediate()).toThrow('force outer rollback');
    expect(getCurrentAuditEpoch()).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM nova_audit_log WHERE epoch_id <> 'legacy'").get() as { n: number }).n)
      .toBe(0);
  });

  it('serializes competing epoch starts across database connections and succeeds after lock release', () => {
    const { invalidId } = compromiseLegacy();
    const primary = getDb();
    const secondary = new Database(process.env.DATABASE_PATH!);
    secondary.pragma('busy_timeout = 0');
    try {
      const contender = primary.transaction(() => {
        beginAuditEpoch(beginInput(invalidId), primary);
        expect(() => beginAuditEpoch(beginInput(invalidId), secondary)).toThrow(/locked|busy/i);
        throw new Error('rollback lock holder');
      });
      expect(() => contender.immediate()).toThrow('rollback lock holder');
      const committed = beginAuditEpoch(beginInput(invalidId), secondary);
      expect(committed.sequenceNo).toBe(1);
      expect(verifyAuditIntegrity('current', secondary)).toMatchObject({ valid: true, checkedCount: 1 });
      expect(verifyAuditIntegrity('current', 7, secondary)).toMatchObject({ valid: true, checkedCount: 1 });
    } finally {
      secondary.close();
    }
  });

  it('serializes multi-connection append tails and retries without a fork', () => {
    const { invalidId } = compromiseLegacy();
    beginAuditEpoch(beginInput(invalidId));
    const primary = getDb();
    const secondary = new Database(process.env.DATABASE_PATH!);
    secondary.pragma('busy_timeout = 0');
    let firstHash = '';
    try {
      const holder = primary.transaction(() => {
        const first = appendAudit({ actor: 'operator:a', action: 'policy_violation' }, primary);
        firstHash = first.hash;
        expect(() => appendAudit({ actor: 'operator:b', action: 'policy_violation' }, secondary))
          .toThrow(/locked|busy/i);
      });
      holder.immediate();
      const retried = appendAudit({ actor: 'operator:b', action: 'policy_violation' }, secondary);
      expect(retried.prevHash).toBe(firstHash);
      expect(verifyAuditIntegrity('current', secondary)).toMatchObject({ valid: true, checkedCount: 3 });
    } finally {
      secondary.close();
    }
  });

  it('uses monotonic chain_seq when the wall clock moves backward', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));
    const first = appendAudit({ actor: 'clock:test', action: 'wallet_created' });
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
    const second = appendAudit({ actor: 'clock:test', action: 'large_transfer' });
    expect(second.timestamp).toBeLessThan(first.timestamp);
    expect(second.chainSeq).toBe(first.chainSeq + 1);
    expect(second.prevHash).toBe(first.hash);
    expect(verifyAuditIntegrity('history')).toMatchObject({ valid: true, checkedCount: 2 });
  });

  it('keeps the checkpoint valid across VACUUM rowid renumbering', () => {
    const first = appendAudit({ actor: 'vacuum:test', action: 'wallet_created' });
    const second = appendAudit({ actor: 'vacuum:test', action: 'large_transfer' });
    appendAudit({ actor: 'vacuum:test', action: 'policy_violation' });
    getDb().prepare('DELETE FROM nova_audit_log WHERE id = ?').run(first.id);
    const epoch = beginAuditEpoch(beginInput(second.id));
    expect(verifyAuditIntegrity('current')).toMatchObject({ valid: true, checkedCount: 1 });

    getDb().exec('VACUUM');

    expect(getCurrentAuditEpoch()).toMatchObject({
      epochId: epoch.epochId,
      sourceMaxChainSeq: epoch.sourceMaxChainSeq,
      sourceTipRowid: epoch.sourceTipRowid,
    });
    expect(verifyAuditIntegrity('current')).toMatchObject({ valid: true, checkedCount: 1 });
  });

  it('validates the actual previous checkpoint hash and contiguous sequence', () => {
    const { invalidId } = compromiseLegacy();
    const firstEpoch = beginAuditEpoch(beginInput(invalidId));
    const currentEntry = queryAuditLog({ scope: 'current' }).entries[0]!;
    getDb().prepare('UPDATE nova_audit_log SET hash = ? WHERE id = ?')
      .run('b'.repeat(64), currentEntry.id);
    const secondEpoch = beginAuditEpoch({
      ...beginInput(currentEntry.id),
      reason: 'second incident checkpoint after current epoch tamper',
    });
    expect(secondEpoch.previousCheckpointHash).toBe(firstEpoch.checkpointHash);
    expect(verifyAuditIntegrity('current')).toMatchObject({ valid: true, checkedCount: 1 });

    getDb().prepare('UPDATE nova_audit_epochs SET checkpoint_hash = ? WHERE epoch_id = ?')
      .run('c'.repeat(64), firstEpoch.epochId);
    expect(verifyAuditIntegrity('current')).toMatchObject({
      valid: false,
      currentEpochValid: false,
      currentEpochError: expect.stringMatching(/checkpoint|lineage/),
    });
  });

  it('records migration once and remains idempotent through the migration ledger', () => {
    const before = (getDb().prepare(
      "SELECT COUNT(*) AS n FROM schema_migrations WHERE filename = '125_audit_epochs.sql'",
    ).get() as { n: number }).n;
    runMigrations();
    const after = (getDb().prepare(
      "SELECT COUNT(*) AS n FROM schema_migrations WHERE filename = '125_audit_epochs.sql'",
    ).get() as { n: number }).n;
    expect(before).toBe(1);
    expect(after).toBe(1);
  });

  it('verifies a large chain through bounded keyset pages', () => {
    const db = getDb();
    db.transaction(() => {
      for (let index = 0; index < 5_005; index += 1) {
        appendAudit({
          actor: 'stream:test',
          action: 'policy_violation',
          metadata: { index },
        }, db);
      }
    }).immediate();
    expect(verifyChainIntegrity(7)).toEqual({ valid: true, checkedCount: 5_005 });
  });
});
