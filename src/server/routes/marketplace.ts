/**
 * Nova Government — Marketplace API Routes
 * Phase 5: AI 창작물 거래 플랫폼
 */

import type { FastifyInstance } from 'fastify';
import { isValidDid, type DID } from '../../identity/keyManager.js';
import {
  registerArtwork,
  buyArtwork,
  getArtwork,
  listArtworks,
  setForSale,
} from '../../marketplace/artworkService.js';

export async function registerMarketplaceRoutes(app: FastifyInstance): Promise<void> {

  /**
   * POST /api/marketplace/items
   * 창작물 NFT 등록
   */
  app.post('/api/marketplace/items', async (request, reply) => {
    const body = request.body as {
      creator?: string;
      title?: string;
      description?: string;
      category?: string;
      tags?: string[];
      price?: number;
      royaltyPct?: number;
      contentCid?: string;
    } | null;

    if (!body?.creator || !body?.title) {
      return reply.code(400).send({ error: 'Required: creator, title' });
    }
    if (!isValidDid(body.creator)) {
      return reply.code(400).send({ error: `Invalid creator DID: ${body.creator}` });
    }

    const validCategories = ['art', 'music', 'text', 'code', 'data'];
    if (body.category && !validCategories.includes(body.category)) {
      return reply.code(400).send({ error: `Invalid category. Must be one of: ${validCategories.join(', ')}` });
    }

    try {
      const artwork = registerArtwork({
        creator: body.creator as DID,
        title: body.title,
        description: body.description,
        category: body.category as 'art' | undefined,
        tags: body.tags ?? [],
        price: body.price,
        royaltyPct: body.royaltyPct,
        contentCid: body.contentCid,
      });
      reply.code(201).send(artwork);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /**
   * GET /api/marketplace/items
   * 마켓플레이스 목록
   */
  app.get<{ Querystring: { category?: string; creator?: string; all?: string; limit?: string; offset?: string } }>(
    '/api/marketplace/items',
    async (request) => {
      const { category, creator, all, limit, offset } = request.query;
      return listArtworks({
        category,
        creator,
        forSaleOnly: all !== 'true',
        limit: parseInt(limit ?? '20'),
        offset: parseInt(offset ?? '0'),
      });
    }
  );

  /**
   * GET /api/marketplace/items/:id
   * 창작물 조회
   */
  app.get<{ Params: { id: string } }>(
    '/api/marketplace/items/:id',
    async (request, reply) => {
      const artwork = getArtwork(request.params.id);
      if (!artwork) return reply.code(404).send({ error: `Artwork not found: ${request.params.id}` });
      return artwork;
    }
  );

  /**
   * POST /api/marketplace/items/:id/buy
   * 창작물 구매 (로열티 + 수수료 자동 분배)
   */
  app.post<{ Params: { id: string } }>(
    '/api/marketplace/items/:id/buy',
    async (request, reply) => {
      const body = request.body as { buyer?: string } | null;
      if (!body?.buyer) return reply.code(400).send({ error: 'Required: buyer' });
      if (!isValidDid(body.buyer)) return reply.code(400).send({ error: `Invalid buyer DID: ${body.buyer}` });

      try {
        const result = await Promise.resolve(buyArtwork(request.params.id, body.buyer as DID));
        return {
          ...result,
          breakdown: {
            totalPaid: result.price,
            sellerReceives: result.price - result.govtFee - result.royaltyAmount,
            royaltyToCreator: result.royaltyAmount,
            govtFee: result.govtFee,
          },
        };
      } catch (err) {
        const e = err as Error;
        if (e.message.includes('not found')) return reply.code(404).send({ error: e.message });
        if (e.message.includes('Insufficient')) return reply.code(402).send({ error: e.message });
        return reply.code(400).send({ error: e.message });
      }
    }
  );

  /**
   * PATCH /api/marketplace/items/:id/price
   * 판매 가격 설정 / 판매 취소
   */
  app.patch<{ Params: { id: string } }>(
    '/api/marketplace/items/:id/price',
    async (request, reply) => {
      const body = request.body as { ownerDid?: string; price?: number | null } | null;
      if (!body?.ownerDid) return reply.code(400).send({ error: 'Required: ownerDid' });
      if (!isValidDid(body.ownerDid)) return reply.code(400).send({ error: 'Invalid ownerDid' });

      try {
        const artwork = setForSale(request.params.id, body.ownerDid as DID, body.price ?? null);
        return artwork;
      } catch (err) {
        const e = err as Error;
        if (e.message.includes('not found')) return reply.code(404).send({ error: e.message });
        if (e.message.includes('Not the artwork')) return reply.code(403).send({ error: e.message });
        return reply.code(400).send({ error: e.message });
      }
    }
  );

  /**
   * GET /api/marketplace/creator/:did
   * 창작자 작품 목록
   */
  app.get<{ Params: { did: string } }>(
    '/api/marketplace/creator/:did',
    async (request, reply) => {
      if (!isValidDid(request.params.did)) {
        return reply.code(400).send({ error: `Invalid DID: ${request.params.did}` });
      }
      return listArtworks({ creator: request.params.did, forSaleOnly: false });
    }
  );
}
