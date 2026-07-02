/**
 * mem0 라우트 — 에이전트별 장기 기억 CRUD
 *
 * gateway.ts의 mem0 Memory Layer 명세(2026-06-30 메가태스크 이식) 구현:
 *  POST   /api/mem0/:agentId/add     — 기억 저장
 *  POST   /api/mem0/:agentId/search  — 기억 검색 (시맨틱 / BM25 폴백)
 *  GET    /api/mem0/:agentId         — 기억 목록 (최신 순)
 *  DELETE /api/mem0/:agentId/:memId  — 기억 삭제
 *  DELETE /api/mem0/:agentId         — 에이전트 기억 전체 초기화
 *  GET    /api/mem0/stats            — 전체 통계
 *
 * 저장/검색 로직은 core/mem0-bridge.ts가 담당 (NCO_MEM0_NO_EMBED=1이면 BM25만).
 */

import type { FastifyInstance } from 'fastify';
import { mem0Add, mem0Search, mem0List, mem0Delete, mem0Clear, mem0Stats } from '../../core/mem0-bridge.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('mem0-routes');

export async function registerMem0Routes(app: FastifyInstance): Promise<void> {
  // stats를 :agentId 라우트보다 먼저 등록해야 /api/mem0/stats가 agentId='stats'로 매칭되지 않는다
  app.get('/api/mem0/stats', async () => mem0Stats());

  app.post<{
    Params: { agentId: string };
    Body: { content?: string; userId?: string; metadata?: Record<string, unknown> };
  }>('/api/mem0/:agentId/add', async (req, reply) => {
    const { content, userId, metadata } = req.body ?? {};
    if (!content || typeof content !== 'string') {
      return reply.code(400).send({ error: 'content (string) is required' });
    }
    const result = await mem0Add({ agentId: req.params.agentId, content, userId, metadata });
    log.debug({ agentId: req.params.agentId, id: result.id }, 'mem0 add via API');
    return result;
  });

  app.post<{
    Params: { agentId: string };
    Body: { query?: string; limit?: number; userId?: string };
  }>('/api/mem0/:agentId/search', async (req, reply) => {
    const { query, limit, userId } = req.body ?? {};
    if (!query || typeof query !== 'string') {
      return reply.code(400).send({ error: 'query (string) is required' });
    }
    return mem0Search({ agentId: req.params.agentId, query, limit, userId });
  });

  app.get<{
    Params: { agentId: string };
    Querystring: { limit?: string; userId?: string };
  }>('/api/mem0/:agentId', async (req) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    return { memories: mem0List({ agentId: req.params.agentId, limit, userId: req.query.userId }) };
  });

  app.delete<{ Params: { agentId: string; memId: string } }>(
    '/api/mem0/:agentId/:memId',
    async (req, reply) => {
      const deleted = mem0Delete(req.params.memId, req.params.agentId);
      if (!deleted) return reply.code(404).send({ error: 'memory not found' });
      return { deleted: true, id: req.params.memId };
    },
  );

  app.delete<{ Params: { agentId: string } }>('/api/mem0/:agentId', async (req) => {
    const cleared = mem0Clear(req.params.agentId);
    return { cleared };
  });

  log.info('mem0 routes registered');
}
