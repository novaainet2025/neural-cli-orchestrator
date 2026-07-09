/**
 * Nova Government — Voting Service
 * Quadratic Voting 구현
 * Phase 3: Governance
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/database.js';
import { isValidDid, type DID } from '../identity/keyManager.js';
import { getWallet, _updateBalance, _updateLocked } from '../economy/walletService.js';

export interface Vote {
  voteId: string;
  proposalId: string;
  voter: DID;
  direction: 'for' | 'against' | 'abstain';
  stake: number;
  weight: number;   // sqrt(stake) — Quadratic Voting
  createdAt: number;
}

export interface VoteInput {
  proposalId: string;
  voter: DID;
  direction: 'for' | 'against' | 'abstain';
  stake?: number;   // NVC 스테이킹 (0이면 기본 투표권 1)
}

export interface StakeInfo {
  staker: DID;
  amount: number;
  stakedAt: number;
}

/**
 * Quadratic Voting 가중치 계산
 * weight = sqrt(min(stake, totalSupply * 5%)), 최소 1
 * GOVERNANCE-POLICY.md 5회차 합의 — 고래 방지 상한 적용
 */
export function calculateQuadraticWeight(stake: number, totalSupply?: number): number {
  if (stake <= 0) return 1.0;
  const cappedStake = totalSupply
    ? Math.min(stake, totalSupply * 0.05)
    : stake;
  return Math.sqrt(cappedStake);
}

/**
 * 투표 (1인 1표, Quadratic 가중치)
 */
export function castVote(input: VoteInput): Vote {
  const db = getDb();
  const { proposalId, voter, direction, stake = 0 } = input;

  if (!isValidDid(voter)) throw new Error(`Invalid voter DID: ${voter}`);
  if (!['for', 'against', 'abstain'].includes(direction)) {
    throw new Error(`Invalid direction: ${direction}`);
  }

  // 제안 존재 + 활성 확인
  const proposal = db.prepare(`
    SELECT proposal_id, status, end_at, votes_for, votes_against, votes_abstain
    FROM nova_proposals WHERE proposal_id = ?
  `).get(proposalId) as Record<string, unknown> | undefined;

  if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);
  if (proposal['status'] !== 'active') throw new Error(`Proposal is ${proposal['status']}, not active`);

  const now = Math.floor(Date.now() / 1000);
  if (now > (proposal['end_at'] as number)) throw new Error('Voting period has ended');

  // 중복 투표 방지
  const existing = db.prepare(
    'SELECT vote_id FROM nova_votes WHERE proposal_id = ? AND voter = ?'
  ).get(proposalId, voter);
  if (existing) throw new Error(`Already voted on proposal: ${proposalId}`);

  // 스테이킹 처리 (NVC 잠금)
  if (stake > 0) {
    const wallet = getWallet(voter);
    if (!wallet) throw new Error(`Wallet not found: ${voter}`);
    if (wallet.available < stake) {
      throw new Error(`Insufficient balance for stake: available=${wallet.available}, required=${stake}`);
    }
    _updateLocked(voter, stake, db);

    // 스테이킹 기록
    db.prepare(`
      INSERT INTO nova_stakes (staker, amount, staked_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(staker) DO UPDATE SET amount = amount + ?, updated_at = ?
    `).run(voter, stake, now, now, stake, now);
  }

  // 총 공급량 조회 (MAX_CAP 5% 계산용)
  const totalSupply = (db.prepare(
    'SELECT COALESCE(SUM(balance), 0) as s FROM nova_wallets'
  ).get() as { s: number }).s;

  const weight = calculateQuadraticWeight(stake, totalSupply);
  const voteId = randomUUID();

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO nova_votes (vote_id, proposal_id, voter, direction, stake, weight, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(voteId, proposalId, voter, direction, stake, weight, now);

    // 제안 집계 업데이트
    const col = direction === 'for' ? 'votes_for'
      : direction === 'against' ? 'votes_against'
      : 'votes_abstain';

    db.prepare(`
      UPDATE nova_proposals SET ${col} = ${col} + ? WHERE proposal_id = ?
    `).run(weight, proposalId);
  });

  txn();

  return { voteId, proposalId, voter, direction, stake, weight, createdAt: now };
}

/**
 * 제안별 투표 목록
 */
export function getVotes(proposalId: string): Vote[] {
  const db = getDb();

  const rows = db.prepare(`
    SELECT vote_id, proposal_id, voter, direction, stake, weight, created_at
    FROM nova_votes WHERE proposal_id = ?
    ORDER BY created_at ASC
  `).all(proposalId) as Record<string, unknown>[];

  return rows.map((r) => ({
    voteId: r['vote_id'] as string,
    proposalId: r['proposal_id'] as string,
    voter: r['voter'] as DID,
    direction: r['direction'] as Vote['direction'],
    stake: r['stake'] as number,
    weight: r['weight'] as number,
    createdAt: r['created_at'] as number,
  }));
}

/**
 * 내 스테이킹 정보
 */
export function getStake(did: DID): StakeInfo | null {
  const db = getDb();

  const row = db.prepare('SELECT staker, amount, staked_at FROM nova_stakes WHERE staker = ?')
    .get(did) as { staker: string; amount: number; staked_at: number } | undefined;

  if (!row) return null;
  return { staker: row.staker as DID, amount: row.amount, stakedAt: row.staked_at };
}

/**
 * DAO 전체 현황
 */
export function getDAOStatus(): {
  totalProposals: number;
  activeProposals: number;
  totalVoters: number;
  totalStaked: number;
} {
  const db = getDb();

  const total = (db.prepare('SELECT COUNT(*) as n FROM nova_proposals').get() as { n: number }).n;
  const active = (db.prepare("SELECT COUNT(*) as n FROM nova_proposals WHERE status='active'").get() as { n: number }).n;
  const voters = (db.prepare('SELECT COUNT(DISTINCT voter) as n FROM nova_votes').get() as { n: number }).n;
  const staked = (db.prepare('SELECT COALESCE(SUM(amount),0) as s FROM nova_stakes').get() as { s: number }).s;

  return {
    totalProposals: total,
    activeProposals: active,
    totalVoters: voters,
    totalStaked: staked,
  };
}
