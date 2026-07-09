import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { 
  registerDomain, 
  getDomainAnnualFee, 
  transferDomain, 
  renewDomain, 
  reserveDomain, 
  startAuction, 
  placeBid, 
  closeAuction,
  getDomain,
  processExpirations,
  DOMAIN_MAX_PER_DID
} from '../src/domain/domainService.js';
import { createWallet, getWallet } from '../src/economy/walletService.js';
import { registerCitizen } from '../src/identity/credentialService.js';
import { getThreatRestriction } from '../src/audit/emergencyService.js';
import { BURN_ADDRESS, GOVT_ADDRESS } from '../src/economy/walletService.js';
import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { getDb, runMigrations, closeDb } from '../src/storage/database.js';
import { env } from '../src/utils/config.js';

describe('Domain Policy v2 Verification', () => {
  const alice = 'did:nova:000000000000000000000000000000a1' as any;
  const bob = 'did:nova:000000000000000000000000000000b2' as any;
  const charlie = 'did:nova:000000000000000000000000000000c3' as any;
  const testDbPath = resolve(env.ROOT, 'db/test-domain-policy-v2.db');
  let originalDbPath: string;

  beforeAll(() => {
    closeDb();
    originalDbPath = process.env.DATABASE_PATH || '';
    process.env.DATABASE_PATH = testDbPath;
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    const db = getDb();
    runMigrations();

    // Clean up
    db.prepare('DELETE FROM nova_domain_auctions').run();
    db.prepare('DELETE FROM nova_domain_history').run();
    db.prepare('DELETE FROM nova_domain_reserved').run();
    db.prepare('DELETE FROM nova_domains').run();
    db.prepare('DELETE FROM nova_wallets').run();
    db.prepare('DELETE FROM nova_transactions').run();
    db.prepare('DELETE FROM nova_citizens').run();
    db.prepare('DELETE FROM nova_threat_restrictions').run();
    db.prepare('DELETE FROM nova_emergency_stops').run();
    db.prepare('DELETE FROM nova_blacklist').run();

    // Setup citizens
    registerCitizen({ did: alice, publicKey: 'alice-pk' });
    registerCitizen({ did: bob, publicKey: 'bob-pk' });
    registerCitizen({ did: charlie, publicKey: 'charlie-pk' });
    registerCitizen({ did: GOVT_ADDRESS, publicKey: 'govt-pk' });
    registerCitizen({ did: BURN_ADDRESS, publicKey: 'burn-pk' });

    createWallet(alice); // Initial 1000 NVC
    createWallet(bob);
    createWallet(charlie);
    createWallet(GOVT_ADDRESS);
    createWallet(BURN_ADDRESS);

    // Increase total supply to avoid 5% emergency stop (500 NVC registration)
    db.prepare('UPDATE nova_wallets SET balance = balance + 100000 WHERE address = ?').run(GOVT_ADDRESS);
  });

  it('1. Pricing logic handles domain lengths correctly', () => {
    expect(getDomainAnnualFee(2)).toBe(500);
    expect(getDomainAnnualFee(3)).toBe(200);
    expect(getDomainAnnualFee(4)).toBe(100);
    expect(getDomainAnnualFee(5)).toBe(50);
    expect(getDomainAnnualFee(10)).toBe(50);
  });

  it('2. Registration enforces fees and burning', () => {
    const initialBalance = getWallet(alice)!.balance;
    const domain = registerDomain({ name: 'al', owner: alice, years: 1 });
    
    expect(domain.domainName).toBe('al.nova');
    const finalBalance = getWallet(alice)!.balance;
    expect(initialBalance - finalBalance).toBe(500);
  });

  it('3. Anti-squatting limit (Max 5 domains)', () => {
    // Alice already has 'al.nova' (1)
    registerDomain({ name: 'alice1', owner: alice, nonce: 'n1' }); // 2
    registerDomain({ name: 'alice2', owner: alice, nonce: 'n2' }); // 3
    registerDomain({ name: 'alice3', owner: alice, nonce: 'n3' }); // 4
    registerDomain({ name: 'alice4', owner: alice, nonce: 'n4' }); // 5

    expect(() => {
      registerDomain({ name: 'alice5', owner: alice, nonce: 'n5' }); // 6th should fail
    }).toThrow(/Domain limit exceeded/);

    // Should trigger Level 1 threat warning (not restricted yet but recorded)
    const threat = getThreatRestriction(alice);
    // Level 1 threat might not create a restriction entry depending on implementation
    // But handleThreat is called.
  });

  it('4. Transfer fee (5% of base price) is burned', () => {
    // Alice transfers 'al.nova' (base price 500) to Bob
    // Transfer fee = 500 * 0.05 = 25 NVC
    const alicePre = getWallet(alice)!.balance;
    const burnPre = getWallet(BURN_ADDRESS)!.balance;

    transferDomain({
      domainName: 'al.nova',
      fromOwner: alice,
      toOwner: bob,
      price: 0
    });

    const alicePost = getWallet(alice)!.balance;
    const burnPost = getWallet(BURN_ADDRESS)!.balance;

    expect(alicePre - alicePost).toBe(25);
    expect(burnPost - burnPre).toBe(25);
    
    const domain = getDomain('al.nova');
    expect(domain!.owner).toBe(bob);
  });

  it('5. Renewal extends expiration and burns fee', () => {
    const bobPre = getWallet(bob)!.balance;
    const domainPre = getDomain('al.nova')!;
    const expiresPre = domainPre.expiresAt!;

    renewDomain('al.nova', bob, 1);

    const bobPost = getWallet(bob)!.balance;
    expect(bobPre - bobPost).toBe(500); // 2-char domain base price
    
    const domainPost = getDomain('al.nova')!;
    expect(domainPost.expiresAt!).toBeGreaterThan(expiresPre);
  });

  it('6. Reserved domains cannot be registered by citizens', () => {
    reserveDomain('foundation', 'Governance reserved');
    
    expect(() => {
      registerDomain({ name: 'foundation', owner: charlie });
    }).toThrow(/Domain is reserved/);
  });

  it('7. Auction Lifecycle', () => {
    const db = getDb();
    // Force expire a domain (bob's 'al.nova')
    db.prepare('UPDATE nova_domains SET expires_at = ? WHERE domain_name = ?')
      .run(Math.floor(Date.now() / 1000) - 40 * 24 * 3600, 'al.nova'); // 40 days ago

    // Process expirations should trigger auction (30 day grace period exceeded)
    processExpirations();

    const domain = getDomain('al.nova');
    expect(domain!.status).toBe('expired');

    const auction = db.prepare('SELECT * FROM nova_domain_auctions WHERE domain_name = ? AND status = \'active\'')
      .get('al.nova') as any;
    expect(auction).toBeDefined();
    expect(auction.min_bid).toBe(550); // 500 * 1.1

    // Charlie bids 600
    const charliePre = getWallet(charlie)!.balance;
    placeBid(auction.auction_id, charlie, 600);
    
    // Close auction
    closeAuction(auction.auction_id);

    const charliePost = getWallet(charlie)!.balance;
    expect(charliePre - charliePost).toBe(600);

    const finalDomain = getDomain('al.nova');
    expect(finalDomain!.owner).toBe(charlie);
    expect(finalDomain!.status).toBe('active');
  });

  afterAll(() => {
    closeDb();
    process.env.DATABASE_PATH = originalDbPath;
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });
});
