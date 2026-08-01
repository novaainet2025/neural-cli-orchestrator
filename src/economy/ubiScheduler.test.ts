import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyChainIntegrity } from '../audit/merkleLog.js';
import { getDb } from '../storage/database.js';
import { runUbiPayment } from './ubiScheduler.js';

describe('runUbiPayment audit chain', () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM nova_audit_log').run();
    db.prepare('DELETE FROM nova_wallets').run();
    db.prepare('DELETE FROM nova_citizens').run();

    for (const suffix of ['01', '02']) {
      const did = `did:nova:${suffix.padStart(32, '0')}`;
      db.prepare(`
        INSERT INTO nova_citizens (did, public_key, status, ubi_status, grade_v2)
        VALUES (?, ?, 'active', 'active', 'basic')
      `).run(did, `public-key-${suffix}`);
      db.prepare(`
        INSERT INTO nova_wallets (address, balance, locked)
        VALUES (?, 0, 0)
      `).run(did);
    }

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T12:34:56.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('appends same-timestamp payments through the canonical Merkle chain', async () => {
    await runUbiPayment();

    const db = getDb();
    const rows = db.prepare(`
      SELECT timestamp, action, prev_hash, hash
      FROM nova_audit_log
      ORDER BY timestamp ASC, rowid ASC
    `).all() as Array<{
      timestamp: number;
      action: string;
      prev_hash: string;
      hash: string;
    }>;

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.timestamp)).size).toBe(1);
    expect(rows.map(row => row.action)).toEqual(['ubi_payment', 'ubi_payment']);
    expect(rows[1]?.prev_hash).toBe(rows[0]?.hash);
    expect(verifyChainIntegrity()).toEqual({ valid: true, checkedCount: 2 });
  });
});
