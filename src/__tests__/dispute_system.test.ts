import { describe, expect, it, beforeAll } from 'vitest';
import { getDb } from '../storage/database.js';
import { registerCitizen } from '../identity/credentialService.js';
import { createWallet } from '../economy/walletService.js';
import { createEscrow, disputeEscrow } from '../economy/escrowService.js';
import { getDispute } from '../governance/disputeService.js';
import type { DID } from '../identity/keyManager.js';

describe('Advanced Dispute Resolution System', () => {
  const claimantDid = 'did:nova:0000000000000001' as DID;
  const defendantDid = 'did:nova:0000000000000002' as DID;
  const arbiter1 = 'did:nova:000000000000000a' as DID;
  const arbiter2 = 'did:nova:000000000000000b' as DID;
  const arbiter3 = 'did:nova:000000000000000c' as DID;

  beforeAll(() => {
    const db = getDb();
    // Run migration manually if needed, but assuming DB is ready
    try {
      db.exec(require('fs').readFileSync('db/migrations/042_advanced_disputes.sql', 'utf8'));
    } catch (e) {}

    // Clear tables for clean test
    db.exec('DELETE FROM nova_dispute_retaliation');
    db.exec('DELETE FROM nova_disputes');

    // Register citizens and ensure balance
    [claimantDid, defendantDid, arbiter1, arbiter2, arbiter3].forEach(did => {
      try { registerCitizen({ did, publicKey: 'key', name: did }); } catch (e) {}
      try { createWallet(did); } catch (e) {}
      db.prepare('UPDATE nova_wallets SET balance = 100000, locked = 0 WHERE address = ?').run(did);
    });
  });

  it('should create an escrow and trigger a dispute with correct parameters', () => {
    // 1. Create Escrow
    const escrow = createEscrow({
      from: claimantDid,
      to: defendantDid,
      amount: 5000,
      condition: 'Test Escrow'
    });

    // 2. Dispute Escrow
    const disputedEscrow = disputeEscrow(escrow.escrowId, claimantDid);
    expect(disputedEscrow.status).toBe('disputed');
    expect(disputedEscrow.disputeId).toBeDefined();

    // 3. Verify Dispute Record
    const dispute = getDispute(disputedEscrow.disputeId!);
    expect(dispute).not.toBeNull();
    expect(dispute!.disputeType).toBe('escrow');
    expect(dispute!.amount).toBe(5000);
    
    // Cost: 1% of 5000 = 50 NVC (within 5-100 range)
    expect(dispute!.cost).toBe(50);
    
    // Status should be stage_1
    expect(dispute!.status).toBe('stage_1');
    
    // Check deadlines
    const now = Math.floor(Date.now() / 1000);
    expect(dispute!.totalDeadlineAt).toBeGreaterThanOrEqual(now + 5 * 24 * 3600 - 10);
    expect(dispute!.stage1EndAt).toBeGreaterThanOrEqual(now + 72 * 3600 - 10);
    
    // Check assigned arbitrators (should be 3)
    expect(dispute!.assignedArbitrators.length).toBe(3);
  });

  it('should prevent retaliation within 1 year', () => {
    // We already disputed once between claimantDid and defendantDid in the previous test.
    // Let's create another escrow between them and try to dispute.
    const escrow2 = createEscrow({ from: claimantDid, to: defendantDid, amount: 100 });
    
    expect(() => {
      disputeEscrow(escrow2.escrowId, claimantDid); 
    }).toThrow(/Retaliation prevention/);
  });

  it('should calculate costs correctly for min/max bounds', () => {
    const db = getDb();
    // Use fresh DIDs (32 chars hex)
    const claimant2 = 'did:nova:11111111111111111111111111111111';
    const defendant2 = 'did:nova:22222222222222222222222222222222';
    
    try { registerCitizen({ did: claimant2, publicKey: 'key' }); } catch (e) {}
    try { createWallet(claimant2); } catch (e) {}
    db.prepare('UPDATE nova_wallets SET balance = 100000 WHERE address = ?').run(claimant2);
    try { registerCitizen({ did: defendant2, publicKey: 'key' }); } catch (e) {}
    try { createWallet(defendant2); } catch (e) {}
    db.prepare('UPDATE nova_wallets SET balance = 100000 WHERE address = ?').run(defendant2);

    // Min cost test: 1% of 100 = 1, but min is 5
    const escrowMin = createEscrow({ from: claimant2, to: defendant2, amount: 100 });
    const disputeMin = disputeEscrow(escrowMin.escrowId, claimant2);
    const dMin = getDispute(disputeMin.disputeId!);
    expect(dMin!.cost).toBe(5);

    // Max cost test: 1% of 50000 = 500, but max is 100
    const claimant3 = 'did:nova:33333333333333333333333333333333';
    try { registerCitizen({ did: claimant3, publicKey: 'key' }); } catch (e) {}
    try { createWallet(claimant3); } catch (e) {}
    db.prepare('UPDATE nova_wallets SET balance = 100000 WHERE address = ?').run(claimant3);
    const escrowMax = createEscrow({ from: claimant3, to: defendant2, amount: 50000 });
    const disputeMax = disputeEscrow(escrowMax.escrowId, claimant3);
    const dMax = getDispute(disputeMax.disputeId!);
    expect(dMax!.cost).toBe(100);
  });
});
