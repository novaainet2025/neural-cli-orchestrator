/**
 * Nova Government — Proposal Service
 * 제안 생성·조회·실행
 * Phase 3: Governance
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/database.js';
import { isValidDid, type DID } from '../identity/keyManager.js';
import { getCitizen } from '../identity/credentialService.js';

export const PROPOSAL_BOND_NVC = 50; // 거버넌스 제안 예치금 (GOVERNANCE-POLICY v2.0)
const BURN_ADDRESS = 'did:nova:0000000000000000burn0000000000';

export const VOTING_DURATION = {
  general: 7 * 24 * 3600,        // 7일
  constitutional: 14 * 24 * 3600, // 14일
  emergency: 48 * 3600,           // 48시간
};

export const PASS_THRESHOLD = {
  general: 0.5,         // 50%+
  constitutional: 2/3,  // 2/3+
  emergency: 0.5,       // 50%+
};

export interface Proposal {
  proposalId: string;
  creator: DID;
  title: string;
  description: string;
  proposalType: 'general' | 'constitutional' | 'emergency';
  status: 'active' | 'passed' | 'rejected' | 'executed' | 'cancelled';
  votesFor: number;
  votesAgainst: number;
  votesAbstain: number;
  quorumRequired: number;
  startAt: number;
  endAt: number;
  executedAt?: number;
  executionData?: Record<string, unknown>;
  createdAt: number;
}

export interface CreateProposalInput {
  creator: DID;
  title: string;
  description: string;
  proposalType?: 'general' | 'constitutional' | 'emergency';
  executionData?: Record<string, unknown>;
}

/**
 * 제안 생성 (활성 시민만 가능)
 */
export function createProposal(input: CreateProposalInput): Proposal {
  const db = getDb();

  if (!isValidDid(input.creator)) throw new Error(`Invalid creator DID: ${input.creator}`);

  const citizen = getCitizen(input.creator);
  if (!citizen) throw new Error(`Creator not registered: ${input.creator}`);
  if (citizen.status !== 'active') throw new Error(`Citizen is ${citizen.status}`);
  if (!input.title.trim()) throw new Error('Title is required');
  if (!input.description.trim()) throw new Error('Description is required');

  // 50 NVC 예치금 확인 및 잠금 (GOVERNANCE-POLICY v2.0)
  const wallet = db.prepare('SELECT balance, locked FROM nova_wallets WHERE address = ?')
    .get(input.creator) as { balance: number; locked: number } | undefined;
  if (!wallet) throw new Error('Wallet not found — create wallet first');
  const available = wallet.balance - wallet.locked;
  if (available < PROPOSAL_BOND_NVC) {
    throw new Error(`Insufficient balance for proposal bond: need ${PROPOSAL_BOND_NVC} NVC, available ${available}`);
  }
  db.prepare('UPDATE nova_wallets SET locked = locked + ? WHERE address = ?')
    .run(PROPOSAL_BOND_NVC, input.creator);

  const proposalId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const pType = input.proposalType ?? 'general';
  const duration = VOTING_DURATION[pType];

  db.prepare(`
    INSERT INTO nova_proposals
      (proposal_id, creator, title, description, proposal_type, start_at, end_at, execution_data, created_at, bond_amount, bond_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    proposalId,
    input.creator,
    input.title.trim(),
    input.description.trim(),
    pType,
    now,
    now + duration,
    input.executionData ? JSON.stringify(input.executionData) : null,
    now,
    PROPOSAL_BOND_NVC,
    'locked'
  );

  return {
    proposalId,
    creator: input.creator,
    title: input.title.trim(),
    description: input.description.trim(),
    proposalType: pType,
    status: 'active',
    votesFor: 0,
    votesAgainst: 0,
    votesAbstain: 0,
    quorumRequired: 3,
    startAt: now,
    endAt: now + duration,
    executionData: input.executionData,
    createdAt: now,
  };
}

/**
 * 제안 조회
 */
export function getProposal(proposalId: string): Proposal | null {
  const db = getDb();

  const row = db.prepare(`
    SELECT proposal_id, creator, title, description, proposal_type, status,
           votes_for, votes_against, votes_abstain, quorum_required,
           start_at, end_at, executed_at, execution_data, created_at
    FROM nova_proposals WHERE proposal_id = ?
  `).get(proposalId) as Record<string, unknown> | undefined;

  if (!row) return null;
  return rowToProposal(row);
}

/**
 * 제안 목록 조회
 */
export function listProposals(
  status?: Proposal['status'],
  limit = 20,
  offset = 0
): { proposals: Proposal[]; total: number } {
  const db = getDb();

  const where = status ? 'WHERE status = ?' : '';
  const args = status ? [status, limit, offset] : [limit, offset];

  const total = (db.prepare(`SELECT COUNT(*) as cnt FROM nova_proposals ${where}`)
    .get(...(status ? [status] : [])) as { cnt: number }).cnt;

  const rows = db.prepare(`
    SELECT proposal_id, creator, title, description, proposal_type, status,
           votes_for, votes_against, votes_abstain, quorum_required,
           start_at, end_at, executed_at, execution_data, created_at
    FROM nova_proposals ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...args) as Record<string, unknown>[];

  return { total, proposals: rows.map(rowToProposal) };
}

/**
 * 투표 기간 만료 후 결과 확정
 */
export function finalizeProposal(proposalId: string): Proposal {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const proposal = getProposal(proposalId);
  if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);
  if (proposal.status !== 'active') throw new Error(`Proposal is already ${proposal.status}`);
  if (now < proposal.endAt) throw new Error('Voting period has not ended yet');

  const totalVotes = proposal.votesFor + proposal.votesAgainst + proposal.votesAbstain;
  const threshold = PASS_THRESHOLD[proposal.proposalType];
  const passed =
    totalVotes >= proposal.quorumRequired &&
    proposal.votesFor / (proposal.votesFor + proposal.votesAgainst || 1) > threshold;

  const newStatus = passed ? 'passed' : 'rejected';

  db.prepare(`
    UPDATE nova_proposals SET status = ? WHERE proposal_id = ?
  `).run(newStatus, proposalId);

  // 예치금 처리: 가결 → 환급, 부결 → 소각 (GOVERNANCE-POLICY v2.0)
  const bondRow = db.prepare(
    'SELECT bond_amount, bond_status FROM nova_proposals WHERE proposal_id = ?'
  ).get(proposalId) as { bond_amount: number; bond_status: string } | undefined;

  if (bondRow && bondRow.bond_status === 'locked') {
    if (newStatus === 'passed') {
      db.prepare('UPDATE nova_wallets SET locked = locked - ? WHERE address = ?')
        .run(bondRow.bond_amount, proposal.creator);
      db.prepare("UPDATE nova_proposals SET bond_status = 'refunded' WHERE proposal_id = ?")
        .run(proposalId);
    } else {
      db.prepare('UPDATE nova_wallets SET locked = locked - ?, balance = balance - ? WHERE address = ?')
        .run(bondRow.bond_amount, bondRow.bond_amount, proposal.creator);
      db.prepare('UPDATE nova_wallets SET balance = balance + ? WHERE address = ?')
        .run(bondRow.bond_amount, BURN_ADDRESS);
      db.prepare("UPDATE nova_proposals SET bond_status = 'burned' WHERE proposal_id = ?")
        .run(proposalId);
    }
  }

  return { ...proposal, status: newStatus };
}

/**
 * 제안 실행 (passed 상태만)
 */
export function executeProposal(proposalId: string, executorDid: DID): Proposal {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const proposal = getProposal(proposalId);
  if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);
  if (proposal.status !== 'passed') throw new Error(`Cannot execute: proposal is ${proposal.status}`);

  if (!isValidDid(executorDid)) throw new Error(`Invalid executor DID: ${executorDid}`);

  db.prepare(`
    UPDATE nova_proposals SET status = 'executed', executed_at = ? WHERE proposal_id = ?
  `).run(now, proposalId);

  return { ...proposal, status: 'executed', executedAt: now };
}

function rowToProposal(row: Record<string, unknown>): Proposal {
  return {
    proposalId: row['proposal_id'] as string,
    creator: row['creator'] as DID,
    title: row['title'] as string,
    description: row['description'] as string,
    proposalType: row['proposal_type'] as Proposal['proposalType'],
    status: row['status'] as Proposal['status'],
    votesFor: row['votes_for'] as number,
    votesAgainst: row['votes_against'] as number,
    votesAbstain: row['votes_abstain'] as number,
    quorumRequired: row['quorum_required'] as number,
    startAt: row['start_at'] as number,
    endAt: row['end_at'] as number,
    executedAt: row['executed_at'] as number | undefined,
    executionData: row['execution_data']
      ? JSON.parse(row['execution_data'] as string)
      : undefined,
    createdAt: row['created_at'] as number,
  };
}
