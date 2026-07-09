/**
 * Nova Government — Economy API Routes
 * Phase 2: NovaCoin 경제 시스템
 */

import type { FastifyInstance } from 'fastify';
import { isValidDid, type DID } from '../../identity/keyManager.js';
import {
  createWallet,
  getWallet,
  getTotalSupply,
} from '../../economy/walletService.js';
import {
  sendNVC,
  getTransaction,
  getTransactionHistory,
} from '../../economy/transactionService.js';
import {
  createEscrow,
  releaseEscrow,
  refundEscrow,
  disputeEscrow,
  getEscrow,
} from '../../economy/escrowService.js';

export async function registerEconomyRoutes(app: FastifyInstance): Promise<void> {

  /**
   * POST /api/economy/wallets
   * 지갑 생성 (DID 필수, 최초 1000 NVC 지급)
   */
  app.post('/api/economy/wallets', async (request, reply) => {
    const body = request.body as { did?: string } | null;

    if (!body?.did) return reply.code(400).send({ error: 'Required: did' });
    if (!isValidDid(body.did)) return reply.code(400).send({ error: `Invalid DID: ${body.did}` });

    try {
      const wallet = createWallet(body.did as DID);
      reply.code(201).send({
        address: wallet.address,
        balance: wallet.balance,
        locked: wallet.locked,
        available: wallet.available,
        createdAt: wallet.createdAt,
        note: `초기 지급: ${wallet.balance} NVC (시민 기본소득)`,
      });
    } catch (err) {
      const e = err as Error;
      if (e.message.includes('already exists')) return reply.code(409).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  /**
   * GET /api/economy/wallets/:address/balance
   * 잔액 조회
   */
  app.get<{ Params: { address: string } }>(
    '/api/economy/wallets/:address/balance',
    async (request, reply) => {
      const { address } = request.params;

      if (!isValidDid(address)) return reply.code(400).send({ error: `Invalid DID: ${address}` });

      const wallet = getWallet(address as DID);
      if (!wallet) return reply.code(404).send({ error: `Wallet not found: ${address}` });

      return {
        address: wallet.address,
        balance: wallet.balance,
        locked: wallet.locked,
        available: wallet.available,
      };
    }
  );

  /**
   * POST /api/economy/transactions
   * P2P NovaCoin 전송
   */
  app.post('/api/economy/transactions', async (request, reply) => {
    const body = request.body as {
      from?: string;
      to?: string;
      amount?: number;
      memo?: string;
    } | null;

    if (!body?.from || !body?.to || body?.amount === undefined) {
      return reply.code(400).send({ error: 'Required: from, to, amount' });
    }
    if (!isValidDid(body.from)) return reply.code(400).send({ error: `Invalid sender DID: ${body.from}` });
    if (!isValidDid(body.to)) return reply.code(400).send({ error: `Invalid recipient DID: ${body.to}` });

    try {
      const tx = sendNVC({
        from: body.from as DID,
        to: body.to as DID,
        amount: body.amount,
        memo: body.memo,
      });

      reply.code(201).send({
        txId: tx.txId,
        from: tx.fromAddress,
        to: tx.toAddress,
        amount: tx.amount,
        fee: tx.fee,
        status: tx.status,
        createdAt: tx.createdAt,
      });
    } catch (err) {
      const e = err as Error;
      if (e.message.includes('Insufficient')) return reply.code(402).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  /**
   * GET /api/economy/transactions/:txId
   * 트랜잭션 조회
   */
  app.get<{ Params: { txId: string } }>(
    '/api/economy/transactions/:txId',
    async (request, reply) => {
      const tx = getTransaction(request.params.txId);
      if (!tx) return reply.code(404).send({ error: `Transaction not found: ${request.params.txId}` });
      return tx;
    }
  );

  /**
   * GET /api/economy/wallets/:address/transactions
   * 지갑 트랜잭션 이력
   */
  app.get<{
    Params: { address: string };
    Querystring: { limit?: string; offset?: string };
  }>('/api/economy/wallets/:address/transactions', async (request, reply) => {
    const { address } = request.params;
    if (!isValidDid(address)) return reply.code(400).send({ error: `Invalid DID: ${address}` });

    const limit = Math.min(parseInt(request.query.limit ?? '20'), 100);
    const offset = parseInt(request.query.offset ?? '0');

    const result = getTransactionHistory(address as DID, limit, offset);
    return result;
  });

  /**
   * POST /api/economy/escrow
   * 에스크로 생성
   */
  app.post('/api/economy/escrow', async (request, reply) => {
    const body = request.body as {
      from?: string;
      to?: string;
      amount?: number;
      condition?: string;
    } | null;

    if (!body?.from || !body?.to || body?.amount === undefined) {
      return reply.code(400).send({ error: 'Required: from, to, amount' });
    }

    try {
      const escrow = createEscrow({
        from: body.from as DID,
        to: body.to as DID,
        amount: body.amount,
        condition: body.condition,
      });
      reply.code(201).send(escrow);
    } catch (err) {
      const e = err as Error;
      if (e.message.includes('Insufficient')) return reply.code(402).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  /**
   * GET /api/economy/escrow/:escrowId
   * 에스크로 조회
   */
  app.get<{ Params: { escrowId: string } }>(
    '/api/economy/escrow/:escrowId',
    async (request, reply) => {
      const escrow = getEscrow(request.params.escrowId);
      if (!escrow) return reply.code(404).send({ error: `Escrow not found: ${request.params.escrowId}` });
      return escrow;
    }
  );

  /**
   * POST /api/economy/escrow/:escrowId/release
   * 에스크로 해제 (송신자 또는 중재자)
   */
  app.post<{ Params: { escrowId: string } }>(
    '/api/economy/escrow/:escrowId/release',
    async (request, reply) => {
      const body = request.body as { releaserDid?: string } | null;
      if (!body?.releaserDid) return reply.code(400).send({ error: 'Required: releaserDid' });

      try {
        const escrow = releaseEscrow(request.params.escrowId, body.releaserDid as DID);
        return escrow;
      } catch (err) {
        const e = err as Error;
        if (e.message.includes('not found')) return reply.code(404).send({ error: e.message });
        return reply.code(403).send({ error: e.message });
      }
    }
  );

  /**
   * POST /api/economy/escrow/:escrowId/refund
   * 에스크로 환불 (수신자 또는 중재자)
   */
  app.post<{ Params: { escrowId: string } }>(
    '/api/economy/escrow/:escrowId/refund',
    async (request, reply) => {
      const body = request.body as { refunderDid?: string } | null;
      if (!body?.refunderDid) return reply.code(400).send({ error: 'Required: refunderDid' });

      try {
        const escrow = refundEscrow(request.params.escrowId, body.refunderDid as DID);
        return escrow;
      } catch (err) {
        const e = err as Error;
        if (e.message.includes('not found')) return reply.code(404).send({ error: e.message });
        return reply.code(403).send({ error: e.message });
      }
    }
  );

  /**
   * POST /api/economy/escrow/:escrowId/dispute
   * 에스크로 분쟁 (중재자 지정)
   */
  app.post<{ Params: { escrowId: string } }>(
    '/api/economy/escrow/:escrowId/dispute',
    async (request, reply) => {
      const body = request.body as { requesterDid?: string; arbiterDid?: string } | null;
      if (!body?.requesterDid) {
        return reply.code(400).send({ error: 'Required: requesterDid' });
      }

      try {
        const escrow = disputeEscrow(
          request.params.escrowId,
          body.requesterDid as DID,
          body.arbiterDid as DID | undefined
        );
        return escrow;
      } catch (err) {
        const e = err as Error;
        if (e.message.includes('not found')) return reply.code(404).send({ error: e.message });
        return reply.code(403).send({ error: e.message });
      }
    }
  );

  /**
   * GET /api/economy/supply
   * 전체 NVC 공급량 조회
   */
  app.get('/api/economy/supply', async () => {
    return {
      totalSupply: getTotalSupply(),
      unit: 'NVC',
      description: 'Total NovaCoin in circulation',
    };
  });
}
