import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sendNVC } from '../src/economy/transactionService.js';
import { createWallet, getTotalSupply } from '../src/economy/walletService.js';
import { closeDb, getDb, runMigrations } from '../src/storage/database.js';
import { appendAudit, verifyChainIntegrity } from '../src/audit/merkleLog.js';
import { 
  getThreatRestriction, 
  evaluateThreatLevel, 
  isBlacklisted, 
  getActiveEmergencyStop,
  liftEmergencyStop,
  ThreatLevel
} from '../src/audit/emergencyService.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('Security Policy v1.1 Implementation', () => {
  const alice = 'did:nova:11111111111111111111111111111111' as any;
  const bob = 'did:nova:22222222222222222222222222222222' as any;
  const govt = 'did:nova:0000000000000000government00000000' as any;
  let originalDatabasePath: string | undefined;
  let testDirectory: string;
  let testDatabasePath: string;

  beforeAll(() => {
    closeDb();
    originalDatabasePath = process.env.DATABASE_PATH;
    testDirectory = mkdtempSync(join(tmpdir(), 'nco-security-policy-'));
    testDatabasePath = join(testDirectory, 'security-policy.db');
    process.env.DATABASE_PATH = testDatabasePath;
    runMigrations();

    const db = getDb();

    // Setup citizens
    db.prepare("INSERT INTO nova_citizens (did, public_key, status) VALUES (?, 'pk1', 'active')").run(alice);
    db.prepare("INSERT INTO nova_citizens (did, public_key, status) VALUES (?, 'pk2', 'active')").run(bob);
    db.prepare("INSERT INTO nova_citizens (did, public_key, status) VALUES (?, 'pk3', 'active')").run(govt);

    createWallet(alice);
    createWallet(bob);
  });

  afterAll(() => {
    closeDb();
    if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalDatabasePath;
    rmSync(testDirectory, { recursive: true, force: true });
  });

  it('0. Uses a dedicated temporary SQLite database', () => {
    expect(resolve(getDb().name)).toBe(resolve(testDatabasePath));
    expect(resolve(testDatabasePath).startsWith(resolve(tmpdir()))).toBe(true);
  });

  it('1. Double Spending Detection - Nonce Reuse', () => {
    const nonce = 'nonce-1';
    sendNVC({ from: alice, to: bob, amount: 10, nonce });
    
    // Same nonce again should fail
    expect(() => {
      sendNVC({ from: alice, to: bob, amount: 10, nonce });
    }).toThrow(/Double spend detected/);

    // Should be Level 4 (Blacklisted + Emergency Stop)
    expect(isBlacklisted(alice)).toBe(true);
    expect(getActiveEmergencyStop()).not.toBeNull();
  });

  it('2. Emergency Stop Blocks All Transfers', () => {
    // System is in emergency stop from previous test
    expect(() => {
      sendNVC({ from: bob, to: alice, amount: 10 });
    }).toThrow(/System is in Emergency Stop mode/);
  });

  it('3. Governance Lift Emergency Stop (Approval >= 75%)', () => {
    const active = getActiveEmergencyStop();
    if (!active) throw new Error('No active emergency stop');

    // Fail with 50% approval
    expect(() => {
      liftEmergencyStop(active.stopId, govt, 0.5);
    }).toThrow(/Insufficient approval rate/);

    // Success with 75% approval
    liftEmergencyStop(active.stopId, govt, 0.75);
    expect(getActiveEmergencyStop()).toBeNull();
  });

  it('4. Double Spending Detection - Time Window (60s)', () => {
    // Clear blacklist for testing
    const db = getDb();
    db.prepare('DELETE FROM nova_blacklist').run();
    
    sendNVC({ from: bob, to: alice, amount: 50 });
    
    // Same amount within 60s without nonce should fail
    expect(() => {
      sendNVC({ from: bob, to: alice, amount: 50 });
    }).toThrow(/Double spend suspected/);
  });

  it('5. Threat Level Escalation (Level 2 & 3)', () => {
    // Lift emergency stop from previous test
    const db = getDb();
    db.prepare("UPDATE nova_emergency_stops SET status = 'lifted' WHERE status = 'active'").run();

    const charlie = 'did:nova:33333333333333333333333333333333' as any;
    db.prepare("INSERT INTO nova_citizens (did, public_key, status) VALUES (?, 'pk4', 'active')").run(charlie);
    createWallet(charlie);

    // Simulate 2 warnings (Severity warn)
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 2; i++) {
      appendAudit({
        actor: charlie,
        action: 'policy_violation',
        metadata: { fixture: true, sequence: i, timestamp: now },
        severity: 'warn',
      });
    }
    expect(verifyChainIntegrity().valid).toBe(true);

    // Evaluate should escalate to Level 2
    const level = evaluateThreatLevel(charlie, 'minor_event');
    expect(level).toBe(ThreatLevel.LEVEL_2);
    expect(getThreatRestriction(charlie)?.level).toBe(2);

    // Transfers should be blocked
    expect(() => {
      sendNVC({ from: charlie, to: alice, amount: 10 });
    }).toThrow(/DID is restricted \(Level 2\)/);

    // Simulate 3 more warnings (Total 5)
    for (let i = 0; i < 3; i++) {
      appendAudit({
        actor: charlie,
        action: 'policy_violation',
        metadata: { fixture: true, sequence: i + 2, timestamp: now },
        severity: 'warn',
      });
    }
    expect(verifyChainIntegrity().valid).toBe(true);

    // Evaluate should escalate to Level 3
    const finalLevel = evaluateThreatLevel(charlie, 'minor_event');
    expect(finalLevel).toBe(ThreatLevel.LEVEL_3);
    expect(getThreatRestriction(charlie)?.level).toBe(3);
  });

  it('6. Emergency Stop - Supply Change Threshold (5%)', () => {
    // Lift emergency stop from previous test
    const db = getDb();
    db.prepare("UPDATE nova_emergency_stops SET status = 'lifted' WHERE status = 'active'").run();

    const dave = 'did:nova:44444444444444444444444444444444' as any;
    db.prepare("INSERT INTO nova_citizens (did, public_key, status) VALUES (?, 'pk5', 'active')").run(dave);
    createWallet(dave);
    
    const supply = getTotalSupply();
    const excessiveAmount = Math.floor(supply * 0.06); // 6%

    // Govt mint to Dave to allow large transfer
    db.prepare('UPDATE nova_wallets SET balance = balance + ? WHERE address = ?').run(excessiveAmount, dave);

    expect(() => {
      sendNVC({ from: dave, to: alice, amount: excessiveAmount });
    }).toThrow(/Excessive supply change/);

    expect(getActiveEmergencyStop()).not.toBeNull();
  });
});
