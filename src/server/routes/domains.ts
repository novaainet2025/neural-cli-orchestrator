/**
 * Nova Government — Domain Registry API Routes
 * Phase 4: .nova 도메인 소유권
 */

import type { FastifyInstance } from 'fastify';
import { isValidDid, type DID } from '../../identity/keyManager.js';
import {
  registerDomain,
  getDomain,
  transferDomain,
  getDomainHistory,
  getOwnerDomains,
  detectSquatting,
  isValidDomainName,
} from '../../domain/domainService.js';

export async function registerDomainRoutes(app: FastifyInstance): Promise<void> {

  /**
   * POST /api/domains/register
   * 도메인 등록 (.nova NFT 발행)
   */
  app.post('/api/domains/register', async (request, reply) => {
    const body = request.body as {
      name?: string;
      owner?: string;
      years?: number;
      metadata?: Record<string, unknown>;
    } | null;

    if (!body?.name || !body?.owner) {
      return reply.code(400).send({ error: 'Required: name, owner' });
    }
    if (!isValidDid(body.owner)) {
      return reply.code(400).send({ error: `Invalid owner DID: ${body.owner}` });
    }

    const cleanName = body.name.toLowerCase().replace(/\.nova$/, '');
    if (!isValidDomainName(cleanName)) {
      return reply.code(400).send({
        error: `Invalid domain name: "${cleanName}". Use 2-32 lowercase alphanumeric chars + hyphens.`,
      });
    }

    try {
      const domain = registerDomain({
        name: cleanName,
        owner: body.owner as DID,
        years: body.years,
        metadata: body.metadata,
      });

      const squatting = detectSquatting(body.owner as DID);

      reply.code(201).send({
        ...domain,
        squattingWarning: squatting
          ? 'Warning: This owner holds many domains — squatting detection triggered'
          : undefined,
      });
    } catch (err) {
      const e = err as Error;
      if (e.message.includes('already registered')) return reply.code(409).send({ error: e.message });
      return reply.code(400).send({ error: e.message });
    }
  });

  /**
   * GET /api/domains/:name
   * 도메인 조회
   */
  app.get<{ Params: { name: string } }>(
    '/api/domains/:name',
    async (request, reply) => {
      const domain = getDomain(request.params.name);
      if (!domain) return reply.code(404).send({ error: `Domain not found: ${request.params.name}` });
      return domain;
    }
  );

  /**
   * POST /api/domains/:name/transfer
   * 도메인 소유권 이전
   */
  app.post<{ Params: { name: string } }>(
    '/api/domains/:name/transfer',
    async (request, reply) => {
      const body = request.body as {
        fromOwner?: string;
        toOwner?: string;
        price?: number;
      } | null;

      if (!body?.fromOwner || !body?.toOwner) {
        return reply.code(400).send({ error: 'Required: fromOwner, toOwner' });
      }

      try {
        const domain = transferDomain({
          domainName: request.params.name,
          fromOwner: body.fromOwner as DID,
          toOwner: body.toOwner as DID,
          price: body.price ?? 0,
        });
        return domain;
      } catch (err) {
        const e = err as Error;
        if (e.message.includes('not found')) return reply.code(404).send({ error: e.message });
        if (e.message.includes('Not the domain owner')) return reply.code(403).send({ error: e.message });
        return reply.code(400).send({ error: e.message });
      }
    }
  );

  /**
   * GET /api/domains/:name/history
   * 도메인 소유 이력
   */
  app.get<{ Params: { name: string } }>(
    '/api/domains/:name/history',
    async (request, reply) => {
      const domain = getDomain(request.params.name);
      if (!domain) return reply.code(404).send({ error: `Domain not found: ${request.params.name}` });

      const history = getDomainHistory(request.params.name);
      return { domainName: domain.domainName, history };
    }
  );

  /**
   * GET /api/domains/owner/:did
   * 시민 보유 도메인 목록
   */
  app.get<{ Params: { did: string } }>(
    '/api/domains/owner/:did',
    async (request, reply) => {
      if (!isValidDid(request.params.did)) {
        return reply.code(400).send({ error: `Invalid DID: ${request.params.did}` });
      }
      const domains = getOwnerDomains(request.params.did as DID);
      const squatting = detectSquatting(request.params.did as DID);
      return {
        owner: request.params.did,
        total: domains.length,
        squattingDetected: squatting,
        domains,
      };
    }
  );
}
