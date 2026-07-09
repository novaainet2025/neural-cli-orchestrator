/**
 * Nova Government — Wallet Service
 * NovaCoin 지갑 생성·잔액 조회
 * Phase 2: Economy Infrastructure
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/database.js';
import { isValidDid, type DID } from '../identity/keyManager.js';
import { getCitizen } from '../identity/credentialService.js';

export const INITIAL_GRANT = 1000;   // 시민 기본소득 (NVC)
export const GOVT_ADDRESS = 'did:nova:0000000000000000government00000000' as DID;
export const BURN_ADDRESS = 'did:nova:0000000000000000burn0000000000' as DID; // 소각 주소

export interface Wallet {
  address: DID;
  balance: number;
  locked: number;
  available: number;   // balance - locked
  createdAt: number;
}

export interface WalletSummary {
  address: DID;
  balance: number;
  locked: number;
  available: number;
}

/**
 * 지갑 생성 (DID 당 1개, 최초 1000 NVC 지급)
 */
export function createWallet(did: DID): Wallet {
  const db = getDb();

  if (!isValidDid(did)) throw new Error(`Invalid DID: ${did}`);

  const citizen = getCitizen(did);
  if (!citizen) throw new Error(`DID not registered: ${did}`);
  if (citizen.status !== 'active') throw new Error(`Citizen is ${citizen.status}`);

  const existing = db.prepare('SELECT address FROM nova_wallets WHERE address = ?').get(did);
  if (existing) throw new Error(`Wallet already exists for: ${did}`);

  const now = Math.floor(Date.now() / 1000);
  const txId = randomUUID();

  const txn = db.transaction(() => {
    // 지갑 생성
    db.prepare(`
      INSERT INTO nova_wallets (address, balance, locked, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?)
    `).run(did, INITIAL_GRANT, now, now);

    // 초기 지급 트랜잭션 기록 (SYSTEM → 시민)
    db.prepare(`
      INSERT INTO nova_transactions (tx_id, from_address, to_address, amount, fee, memo, tx_type, created_at)
      VALUES (?, 'SYSTEM', ?, ?, 0, '시민 기본소득 (Nova Government)', 'mint', ?)
    `).run(txId, did, INITIAL_GRANT, now);
  });

  txn();

  return {
    address: did,
    balance: INITIAL_GRANT,
    locked: 0,
    available: INITIAL_GRANT,
    createdAt: now,
  };
}

/**
 * 지갑 조회
 */
export function getWallet(did: DID): Wallet | null {
  const db = getDb();

  const row = db.prepare(`
    SELECT address, balance, locked, created_at
    FROM nova_wallets WHERE address = ?
  `).get(did) as { address: string; balance: number; locked: number; created_at: number } | undefined;

  if (!row) return null;

  return {
    address: row.address as DID,
    balance: row.balance,
    locked: row.locked,
    available: row.balance - row.locked,
    createdAt: row.created_at,
  };
}

/**
 * 여러 지갑 잔액 조회
 */
export function getWallets(dids: DID[]): WalletSummary[] {
  const db = getDb();
  if (dids.length === 0) return [];

  const placeholders = dids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT address, balance, locked FROM nova_wallets WHERE address IN (${placeholders})
  `).all(...dids) as { address: string; balance: number; locked: number }[];

  return rows.map((r) => ({
    address: r.address as DID,
    balance: r.balance,
    locked: r.locked,
    available: r.balance - r.locked,
  }));
}

/**
 * 전체 NVC 공급량 조회
 */
export function getTotalSupply(): number {
  const db = getDb();
  const row = db.prepare('SELECT SUM(balance) as total FROM nova_wallets').get() as { total: number | null };
  return row.total ?? 0;
}

/**
 * 잔액 업데이트 (내부용 — transactionService에서만 호출)
 */
export function _updateBalance(did: DID, delta: number, db: ReturnType<typeof getDb>): void {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    UPDATE nova_wallets
    SET balance = balance + ?, updated_at = ?
    WHERE address = ?
  `).run(delta, now, did);

  if (result.changes === 0) throw new Error(`Wallet not found: ${did}`);

  const wallet = db.prepare('SELECT balance FROM nova_wallets WHERE address = ?').get(did) as { balance: number };
  if (wallet.balance < 0) throw new Error(`Insufficient balance: ${did}`);
}

/**
 * 잠금 금액 업데이트 (에스크로용)
 */
export function _updateLocked(did: DID, delta: number, db: ReturnType<typeof getDb>): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE nova_wallets
    SET locked = locked + ?, updated_at = ?
    WHERE address = ?
  `).run(delta, now, did);

  const w = db.prepare('SELECT balance, locked FROM nova_wallets WHERE address = ?')
    .get(did) as { balance: number; locked: number };

  if (w.locked < 0) throw new Error(`Lock underflow: ${did}`);
  if (w.locked > w.balance) throw new Error(`Insufficient balance for lock: ${did}`);
}
