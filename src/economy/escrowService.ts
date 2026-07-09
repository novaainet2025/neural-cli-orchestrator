/**
 * Nova Government — Escrow Service
 * 에스크로 생성·해제·분쟁 처리
 * Phase 2: Economy Infrastructure
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/database.js';
import { isValidDid, type DID } from '../identity/keyManager.js';
import { _updateBalance, _updateLocked } from './walletService.js';
import { createDispute } from '../governance/disputeService.js';

export interface Escrow {
  escrowId: string;
  fromAddress: DID;
  toAddress: DID;
  amount: number;
  condition?: string;
  status: 'locked' | 'released' | 'refunded' | 'disputed';
  arbiter?: DID;
  disputeId?: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface CreateEscrowInput {
  from: DID;
  to: DID;
  amount: number;
  condition?: string;
}

/**
 * 에스크로 생성 — from의 NVC를 잠금
 */
export function createEscrow(input: CreateEscrowInput): Escrow {
  const db = getDb();
  const { from, to, amount, condition } = input;

  if (!isValidDid(from)) throw new Error(`Invalid sender DID: ${from}`);
  if (!isValidDid(to)) throw new Error(`Invalid recipient DID: ${to}`);
  if (from === to) throw new Error('Cannot escrow to yourself');
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Amount must be positive integer');

  const escrowId = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const txn = db.transaction(() => {
    // 잔액 확인
    const sender = db.prepare('SELECT balance, locked FROM nova_wallets WHERE address = ?').get(from) as
      { balance: number; locked: number } | undefined;
    if (!sender) throw new Error(`Sender wallet not found: ${from}`);

    const available = sender.balance - sender.locked;
    if (available < amount) {
      throw new Error(`Insufficient balance: available=${available}, required=${amount}`);
    }

    // 수신자 지갑 확인
    const recipient = db.prepare('SELECT address FROM nova_wallets WHERE address = ?').get(to);
    if (!recipient) throw new Error(`Recipient wallet not found: ${to}`);

    // 잠금 처리
    _updateLocked(from, amount, db);

    // 에스크로 기록
    db.prepare(`
      INSERT INTO nova_escrows (escrow_id, from_address, to_address, amount, condition, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'locked', ?)
    `).run(escrowId, from, to, amount, condition ?? null, now);

    // 트랜잭션 기록 (잠금)
    db.prepare(`
      INSERT INTO nova_transactions (tx_id, from_address, to_address, amount, fee, memo, tx_type, created_at)
      VALUES (?, ?, ?, ?, 0, ?, 'escrow_lock', ?)
    `).run(randomUUID(), from, to, amount, `에스크로 잠금: ${escrowId}`, now);
  });

  txn();

  return {
    escrowId,
    fromAddress: from,
    toAddress: to,
    amount,
    condition,
    status: 'locked',
    createdAt: now,
  };
}

/**
 * 에스크로 해제 — to에게 NVC 전송
 * 호출자: from (조건 충족 확인 후 해제) 또는 arbiter
 */
export function releaseEscrow(escrowId: string, releaserDid: DID): Escrow {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const row = db.prepare(`
    SELECT escrow_id, from_address, to_address, amount, condition, status, arbiter, created_at
    FROM nova_escrows WHERE escrow_id = ?
  `).get(escrowId) as Record<string, unknown> | undefined;

  if (!row) throw new Error(`Escrow not found: ${escrowId}`);
  if (row['status'] !== 'locked' && row['status'] !== 'disputed') {
    throw new Error(`Escrow is already ${row['status']}`);
  }

  const from = row['from_address'] as DID;
  const to = row['to_address'] as DID;
  const amount = row['amount'] as number;
  const arbiter = row['arbiter'] as DID | undefined;

  // 해제 권한: from 또는 arbiter
  if (releaserDid !== from && releaserDid !== arbiter) {
    throw new Error('Only sender or arbiter can release escrow');
  }

  const txn = db.transaction(() => {
    // 잠금 해제 + 잔액 이전
    _updateLocked(from, -amount, db);
    _updateBalance(from, -amount, db);
    _updateBalance(to, amount, db);

    // 에스크로 상태 업데이트
    db.prepare(`
      UPDATE nova_escrows SET status = 'released', resolved_at = ? WHERE escrow_id = ?
    `).run(now, escrowId);

    // 트랜잭션 기록
    db.prepare(`
      INSERT INTO nova_transactions (tx_id, from_address, to_address, amount, fee, memo, tx_type, created_at)
      VALUES (?, ?, ?, ?, 0, ?, 'escrow_release', ?)
    `).run(randomUUID(), from, to, amount, `에스크로 해제: ${escrowId}`, now);
  });

  txn();

  return {
    escrowId,
    fromAddress: from,
    toAddress: to,
    amount,
    condition: row['condition'] as string | undefined,
    status: 'released',
    arbiter,
    createdAt: row['created_at'] as number,
    resolvedAt: now,
  };
}

/**
 * 에스크로 환불 — from에게 NVC 반환
 * 호출자: to (조건 불충족 인정) 또는 arbiter
 */
export function refundEscrow(escrowId: string, refunderDid: DID): Escrow {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const row = db.prepare(`
    SELECT escrow_id, from_address, to_address, amount, condition, status, arbiter, created_at
    FROM nova_escrows WHERE escrow_id = ?
  `).get(escrowId) as Record<string, unknown> | undefined;

  if (!row) throw new Error(`Escrow not found: ${escrowId}`);
  if (row['status'] !== 'locked' && row['status'] !== 'disputed') {
    throw new Error(`Escrow is already ${row['status']}`);
  }

  const from = row['from_address'] as DID;
  const to = row['to_address'] as DID;
  const amount = row['amount'] as number;
  const arbiter = row['arbiter'] as DID | undefined;

  // 환불 권한: to 또는 arbiter
  if (refunderDid !== to && refunderDid !== arbiter) {
    throw new Error('Only recipient or arbiter can refund escrow');
  }

  const txn = db.transaction(() => {
    // 잠금만 해제 (balance는 변화 없음)
    _updateLocked(from, -amount, db);

    db.prepare(`
      UPDATE nova_escrows SET status = 'refunded', resolved_at = ? WHERE escrow_id = ?
    `).run(now, escrowId);

    db.prepare(`
      INSERT INTO nova_transactions (tx_id, from_address, to_address, amount, fee, memo, tx_type, created_at)
      VALUES (?, ?, ?, ?, 0, ?, 'escrow_refund', ?)
    `).run(randomUUID(), to, from, amount, `에스크로 환불: ${escrowId}`, now);
  });

  txn();

  return {
    escrowId,
    fromAddress: from,
    toAddress: to,
    amount,
    condition: row['condition'] as string | undefined,
    status: 'refunded',
    arbiter,
    createdAt: row['created_at'] as number,
    resolvedAt: now,
  };
}

/**
 * 에스크로 분쟁 신청 — 분쟁 서비스와 연계
 */
export function disputeEscrow(escrowId: string, requesterDid: DID, arbiterDid?: DID): Escrow {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const row = db.prepare(`
    SELECT escrow_id, from_address, to_address, amount, condition, status, created_at
    FROM nova_escrows WHERE escrow_id = ?
  `).get(escrowId) as Record<string, unknown> | undefined;

  if (!row) throw new Error(`Escrow not found: ${escrowId}`);
  if (row['status'] !== 'locked') throw new Error(`Can only dispute locked escrow (current: ${row['status']})`);

  const from = row['from_address'] as DID;
  const to = row['to_address'] as DID;

  if (requesterDid !== from && requesterDid !== to) {
    throw new Error('Only sender or recipient can dispute escrow');
  }

  const defendant = (requesterDid === from) ? to : from;

  // 분쟁 서비스 호출 (3단계 절차 시작)
  const dispute = createDispute({
    type: 'escrow',
    claimant: requesterDid,
    defendant: defendant,
    targetId: escrowId,
    amount: row['amount'] as number,
    description: `Escrow dispute for ${escrowId}`
  });

  // 에스크로 상태 업데이트 (대표 중재자 지정)
  const mainArbiter = arbiterDid || dispute.assignedArbitrators[0];

  db.prepare(`
    UPDATE nova_escrows SET status = 'disputed', arbiter = ? WHERE escrow_id = ?
  `).run(mainArbiter, escrowId);

  return {
    escrowId,
    fromAddress: from,
    toAddress: to,
    amount: row['amount'] as number,
    condition: row['condition'] as string | undefined,
    status: 'disputed',
    arbiter: mainArbiter,
    disputeId: dispute.disputeId,
    createdAt: row['created_at'] as number,
  };
}

/**
 * 에스크로 조회
 */
export function getEscrow(escrowId: string): Escrow | null {
  const db = getDb();

  const row = db.prepare(`
    SELECT escrow_id, from_address, to_address, amount, condition, status, arbiter, created_at, resolved_at
    FROM nova_escrows WHERE escrow_id = ?
  `).get(escrowId) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    escrowId: row['escrow_id'] as string,
    fromAddress: row['from_address'] as DID,
    toAddress: row['to_address'] as DID,
    amount: row['amount'] as number,
    condition: row['condition'] as string | undefined,
    status: row['status'] as Escrow['status'],
    arbiter: row['arbiter'] as DID | undefined,
    createdAt: row['created_at'] as number,
    resolvedAt: row['resolved_at'] as number | undefined,
  };
}
