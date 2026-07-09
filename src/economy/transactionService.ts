/**
 * Nova Government — Transaction Service
 * NovaCoin P2P 전송 + 이중지불 방지 + 보안 정책 통합
 * Phase 6: Security & Audit
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/database.js';
import { isValidDid, type DID } from '../identity/keyManager.js';
import { _updateBalance, GOVT_ADDRESS, BURN_ADDRESS, getTotalSupply } from './walletService.js';
import { appendAudit } from '../audit/merkleLog.js';
import {
  getThreatRestriction,
  evaluateThreatLevel,
  isBlacklisted,
  getActiveEmergencyStop,
  triggerEmergencyStop,
  EMERGENCY_STOP_SUPPLY_CHANGE_THRESHOLD
} from '../audit/emergencyService.js';
import { recordActivity } from '../nova/taxEvasionService.js';

export const GOVT_FEE_PCT = 0.025;  // 기본 수수료 2.5% (P2P 전송)
export const LARGE_TRANSFER_THRESHOLD = 500;    // 헌법 제9조 감사 기준
export const LARGE_TRANSFER_TAX_PCT = 0.01;     // 1% 특별소비세 (경제정책 1회차 합의)

export interface Transaction {
  txId: string;
  fromAddress: DID | 'SYSTEM';
  toAddress: DID;
  amount: number;
  fee: number;
  memo?: string;
  status: 'pending' | 'confirmed' | 'failed';
  txType: 'transfer' | 'mint' | 'fee' | 'escrow_lock' | 'escrow_release' | 'escrow_refund';
  createdAt: number;
}

export interface SendInput {
  from: DID;
  to: DID;
  amount: number;
  memo?: string;
  nonce?: string;  // 추가: 이중지불 방지용 Nonce
}

function ensureSystemWallet(address: DID, db: ReturnType<typeof getDb>): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO nova_wallets (address, balance, locked, created_at, updated_at)
    VALUES (?, 0, 0, ?, ?)
    ON CONFLICT(address) DO NOTHING
  `).run(address, now, now);
}

/**
 * P2P 전송 (원자적 트랜잭션)
 * 이중지불 방지: SQLite exclusive lock + balance check + Nonce check + Threat Policy
 */
export function sendNVC(input: SendInput): Transaction {
  const db = getDb();
  const { from, to, amount, memo, nonce } = input;

  // 0. 기초 검증
  if (!isValidDid(from)) throw new Error(`Invalid sender DID: ${from}`);
  if (!isValidDid(to)) throw new Error(`Invalid recipient DID: ${to}`);
  if (from === to) throw new Error('Cannot send to yourself');
  // API 전달 단위: NVC, 최소 단위: 0.001 NVC
  if (amount < 0.001) throw new Error('Amount must be at least 0.001 NVC');

  // 1. 보안 정책 체크 (Phase 6)
  // (A) 블랙리스트 또는 비상정지 확인
  if (isBlacklisted(from)) throw new Error(`DID is blacklisted: ${from}`);
  if (getActiveEmergencyStop()) throw new Error('System is in Emergency Stop mode');

  // (B) 위협 등급 제한 확인 (Level 2: 이체제한, Level 3: 계정동결)
  const restriction = getThreatRestriction(from);
  if (restriction) {
    throw new Error(`DID is restricted (Level ${restriction.level}) until ${new Date(restriction.expiresAt * 1000).toISOString()}`);
  }

  const txId = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  // (C) 공급량 변동 모니터링 (>5% 전송 시 비상정지)
  const totalSupply = getTotalSupply();
  if (totalSupply > 0 && amount > totalSupply * EMERGENCY_STOP_SUPPLY_CHANGE_THRESHOLD) {
    triggerEmergencyStop(GOVT_ADDRESS, `Critical supply change detected: ${amount} NVC (>5% of supply)`);
    throw new Error('Transaction blocked: Excessive supply change triggered Emergency Stop');
  }

  // --- 이중지불 탐지 강화 ---
  // 1. Nonce 재사용 체크
  if (nonce) {
    const existingNonce = db.prepare('SELECT tx_id FROM nova_transactions WHERE nonce = ?').get(nonce);
    if (existingNonce) {
      evaluateThreatLevel(from, 'double_spend_attempt'); // 자동 에스컬레이션 (Level 4)
      throw new Error(`Double spend detected: Nonce ${nonce} already used`);
    }
  }

  // 2. 동일 금액 60초 이내 반복 체크
  const recentTx = db.prepare(`
    SELECT tx_id FROM nova_transactions
    WHERE from_address = ? AND amount = ? AND created_at > ?
    LIMIT 1
  `).get(from, amount, now - 60);

  if (recentTx && !nonce) {
    evaluateThreatLevel(from, 'double_spend_attempt'); // 자동 에스컬레이션
    throw new Error('Double spend suspected: Same amount sent within 60s without unique nonce');
  }

  const isSmallTransfer = amount < 10;
  const fee = isSmallTransfer ? 0 : Math.floor(amount * GOVT_FEE_PCT);

  // 500 NVC+ 특별소비세 (경제정책 1회차 합의 — 정부 지갑 제외)
  const isLargeTransfer = amount > LARGE_TRANSFER_THRESHOLD;
  const isGovtSender = (from as string) === (GOVT_ADDRESS as string);
  const taxAmount = (isLargeTransfer && !isGovtSender)
    ? Math.floor(amount * LARGE_TRANSFER_TAX_PCT)
    : 0;

  const netAmount = amount - fee - taxAmount;

  const txn = db.transaction(() => {
    // 잔액 확인 (available = balance - locked)
    const sender = db.prepare('SELECT balance, locked FROM nova_wallets WHERE address = ?').get(from) as
      { balance: number; locked: number } | undefined;
    if (!sender) throw new Error(`Sender wallet not found: ${from}`);

    const available = sender.balance - sender.locked;
    if (available < amount) {
      throw new Error(`Insufficient balance: available=${available}, required=${amount}`);
    }

    // 수신자 지갑 존재 확인
    const recipient = db.prepare('SELECT address FROM nova_wallets WHERE address = ?').get(to);
    if (!recipient) throw new Error(`Recipient wallet not found: ${to}`);

    // 잔액 업데이트 (원자적)
    _updateBalance(from, -amount, db);
    _updateBalance(to, netAmount, db);

    // 특별소비세 → 50% 소각, 50% 정부 준비금
    if (taxAmount > 0) {
      const burnAmount = Math.floor(taxAmount * 0.5);
      const govtAmount = taxAmount - burnAmount;

      ensureSystemWallet(BURN_ADDRESS, db);
      if (govtAmount > 0) {
        ensureSystemWallet(GOVT_ADDRESS, db);
        _updateBalance(GOVT_ADDRESS, govtAmount, db);
      }

      if (burnAmount > 0) {
        _updateBalance(BURN_ADDRESS, burnAmount, db);
        db.prepare(`
          INSERT INTO nova_burn_log (burn_id, source, amount, burned_at, reference_id)
          VALUES (?, 'large_transfer_tax', ?, ?, ?)
        `).run(randomUUID(), burnAmount, now, txId);

        db.prepare(`
          INSERT INTO nova_transactions (tx_id, from_address, to_address, amount, fee, memo, status, tx_type, created_at)
          VALUES (?, ?, ?, ?, 0, ?, 'confirmed', 'fee', ?)
        `).run(
          randomUUID(),
          from,
          BURN_ADDRESS as string,
          burnAmount,
          `special_tax_burn:${txId}`,
          now
        );
      }

      if (govtAmount > 0) {
        db.prepare(`
          INSERT INTO nova_transactions (tx_id, from_address, to_address, amount, fee, memo, status, tx_type, created_at)
          VALUES (?, ?, ?, ?, 0, ?, 'confirmed', 'fee', ?)
        `).run(
          randomUUID(),
          from,
          GOVT_ADDRESS as string,
          govtAmount,
          `special_tax_treasury:${txId}`,
          now
        );
      }
    }

    // 본 트랜잭션 기록
    db.prepare(`
      INSERT INTO nova_transactions (tx_id, from_address, to_address, amount, fee, memo, status, tx_type, created_at, nonce)
      VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 'transfer', ?, ?)
    `).run(txId, from, to, amount, fee + taxAmount, memo ?? null, now, nonce ?? null);
  });

  txn();

  // 탈세 탐지 연동 — 정부 발신(UBI/급여)은 제외 (ECONOMIC-POLICY v2.6)
  if (!isGovtSender) {
    recordActivity(from as string, amount);
  }

  // 대용량 이체 감사 로그
  if (isLargeTransfer) {
    appendAudit({
      actor: from,
      action: 'large_transfer',
      target: to,
      metadata: { amount, taxAmount, taxRate: LARGE_TRANSFER_TAX_PCT },
      severity: 'warn',
    });
  }

  return {
    txId,
    fromAddress: from,
    toAddress: to,
    amount,
    fee: fee + taxAmount,
    memo,
    status: 'confirmed',
    txType: 'transfer',
    createdAt: now,
  };
}

/**
 * 트랜잭션 조회
 */
export function getTransaction(txId: string): Transaction | null {
  const db = getDb();

  const row = db.prepare(`
    SELECT tx_id, from_address, to_address, amount, fee, memo, status, tx_type, created_at
    FROM nova_transactions WHERE tx_id = ?
  `).get(txId) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    txId: row['tx_id'] as string,
    fromAddress: row['from_address'] as DID,
    toAddress: row['to_address'] as DID,
    amount: row['amount'] as number,
    fee: row['fee'] as number,
    memo: row['memo'] as string | undefined,
    status: row['status'] as Transaction['status'],
    txType: row['tx_type'] as Transaction['txType'],
    createdAt: row['created_at'] as number,
  };
}

/**
 * 주소별 트랜잭션 이력
 */
export function getTransactionHistory(
  did: DID,
  limit = 20,
  offset = 0
): { transactions: Transaction[]; total: number } {
  const db = getDb();

  const total = (db.prepare(`
    SELECT COUNT(*) as cnt FROM nova_transactions
    WHERE from_address = ? OR to_address = ?
  `).get(did, did) as { cnt: number }).cnt;

  const rows = db.prepare(`
    SELECT tx_id, from_address, to_address, amount, fee, memo, status, tx_type, created_at
    FROM nova_transactions
    WHERE from_address = ? OR to_address = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(did, did, limit, offset) as Record<string, unknown>[];

  return {
    total,
    transactions: rows.map((r) => ({
      txId: r['tx_id'] as string,
      fromAddress: r['from_address'] as DID,
      toAddress: r['to_address'] as DID,
      amount: r['amount'] as number,
      fee: r['fee'] as number,
      memo: r['memo'] as string | undefined,
      status: r['status'] as Transaction['status'],
      txType: r['tx_type'] as Transaction['txType'],
      createdAt: r['created_at'] as number,
    })),
  };
}
