/**
 * Nova Government — Governance API Routes
 * Phase 3: Proposals + Quadratic Voting
 */

import type { FastifyInstance } from 'fastify';
import { isValidDid, type DID } from '../../identity/keyManager.js';
import {
  createProposal,
  getProposal,
  listProposals,
  finalizeProposal,
  executeProposal,
} from '../../governance/proposalService.js';
import {
  castVote,
  getVotes,
  getStake,
  getDAOStatus,
} from '../../governance/votingService.js';

export async function registerGovernanceRoutes(app: FastifyInstance): Promise<void> {

  /**
   * POST /api/governance/proposals
   * 제안 생성
   */
  app.post('/api/governance/proposals', async (request, reply) => {
    const body = request.body as {
      creator?: string;
      title?: string;
      description?: string;
      proposalType?: string;
      executionData?: Record<string, unknown>;
    } | null;

    if (!body?.creator || !body?.title || !body?.description) {
      return reply.code(400).send({ error: 'Required: creator, title, description' });
    }
    if (!isValidDid(body.creator)) {
      return reply.code(400).send({ error: `Invalid creator DID: ${body.creator}` });
    }

    const validTypes = ['general', 'constitutional', 'emergency'];
    const pType = body.proposalType ?? 'general';
    if (!validTypes.includes(pType)) {
      return reply.code(400).send({ error: `Invalid proposalType: ${pType}. Must be one of: ${validTypes.join(', ')}` });
    }

    try {
      const proposal = createProposal({
        creator: body.creator as DID,
        title: body.title,
        description: body.description,
        proposalType: pType as 'general' | 'constitutional' | 'emergency',
        executionData: body.executionData,
      });
      reply.code(201).send(proposal);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /**
   * GET /api/governance/proposals
   * 제안 목록
   */
  app.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>(
    '/api/governance/proposals',
    async (request) => {
      const { status, limit, offset } = request.query;
      const validStatuses = ['active', 'passed', 'rejected', 'executed', 'cancelled'];
      const statusFilter = validStatuses.includes(status ?? '') ? status as 'active' : undefined;
      return listProposals(statusFilter, parseInt(limit ?? '20'), parseInt(offset ?? '0'));
    }
  );

  /**
   * GET /api/governance/proposals/:id
   * 제안 상세 조회
   */
  app.get<{ Params: { id: string } }>(
    '/api/governance/proposals/:id',
    async (request, reply) => {
      const proposal = getProposal(request.params.id);
      if (!proposal) return reply.code(404).send({ error: `Proposal not found: ${request.params.id}` });
      return proposal;
    }
  );

  /**
   * POST /api/governance/proposals/:id/vote
   * 투표 (Quadratic Voting)
   */
  app.post<{ Params: { id: string } }>(
    '/api/governance/proposals/:id/vote',
    async (request, reply) => {
      const body = request.body as {
        voter?: string;
        direction?: string;
        stake?: number;
      } | null;

      if (!body?.voter || !body?.direction) {
        return reply.code(400).send({ error: 'Required: voter, direction' });
      }
      if (!isValidDid(body.voter)) {
        return reply.code(400).send({ error: `Invalid voter DID: ${body.voter}` });
      }

      try {
        const vote = castVote({
          proposalId: request.params.id,
          voter: body.voter as DID,
          direction: body.direction as 'for' | 'against' | 'abstain',
          stake: body.stake ?? 0,
        });
        reply.code(201).send({
          ...vote,
          quadraticWeight: vote.weight,
          note: vote.stake > 0
            ? `Quadratic weight = sqrt(${vote.stake}) = ${vote.weight.toFixed(3)}`
            : 'Basic vote (no stake) — weight = 1.0',
        });
      } catch (err) {
        const e = err as Error;
        if (e.message.includes('not found')) return reply.code(404).send({ error: e.message });
        if (e.message.includes('Already voted')) return reply.code(409).send({ error: e.message });
        return reply.code(400).send({ error: e.message });
      }
    }
  );

  /**
   * GET /api/governance/proposals/:id/votes
   * 투표 목록 조회
   */
  app.get<{ Params: { id: string } }>(
    '/api/governance/proposals/:id/votes',
    async (request, reply) => {
      const proposal = getProposal(request.params.id);
      if (!proposal) return reply.code(404).send({ error: `Proposal not found: ${request.params.id}` });

      const votes = getVotes(request.params.id);
      return {
        proposalId: request.params.id,
        totalVotes: votes.length,
        summary: {
          for: proposal.votesFor,
          against: proposal.votesAgainst,
          abstain: proposal.votesAbstain,
        },
        votes,
      };
    }
  );

  /**
   * POST /api/governance/proposals/:id/finalize
   * 투표 종료 후 결과 확정
   */
  app.post<{ Params: { id: string } }>(
    '/api/governance/proposals/:id/finalize',
    async (request, reply) => {
      try {
        const proposal = finalizeProposal(request.params.id);
        return { ...proposal, finalizedAt: Math.floor(Date.now() / 1000) };
      } catch (err) {
        const e = err as Error;
        if (e.message.includes('not found')) return reply.code(404).send({ error: e.message });
        return reply.code(400).send({ error: e.message });
      }
    }
  );

  /**
   * POST /api/governance/proposals/:id/execute
   * 통과된 제안 실행
   */
  app.post<{ Params: { id: string } }>(
    '/api/governance/proposals/:id/execute',
    async (request, reply) => {
      const body = request.body as { executorDid?: string } | null;
      if (!body?.executorDid) return reply.code(400).send({ error: 'Required: executorDid' });
      if (!isValidDid(body.executorDid)) return reply.code(400).send({ error: `Invalid executor DID` });

      try {
        const proposal = executeProposal(request.params.id, body.executorDid as DID);
        return proposal;
      } catch (err) {
        const e = err as Error;
        if (e.message.includes('not found')) return reply.code(404).send({ error: e.message });
        return reply.code(400).send({ error: e.message });
      }
    }
  );

  /**
   * GET /api/governance/status
   * DAO 전체 현황
   */
  app.get('/api/governance/status', async () => {
    return getDAOStatus();
  });

  /**
   * GET /api/governance/stake/:did
   * 시민 스테이킹 정보
   */
  app.get<{ Params: { did: string } }>(
    '/api/governance/stake/:did',
    async (request, reply) => {
      if (!isValidDid(request.params.did)) {
        return reply.code(400).send({ error: `Invalid DID: ${request.params.did}` });
      }
      const stake = getStake(request.params.did as DID);
      if (!stake) return { staker: request.params.did, amount: 0, stakedAt: null };
      return stake;
    }
  );
}
