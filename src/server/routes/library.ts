import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { submitToLibrary, publishLibraryItem, searchLibrary, getLibraryItem } from '../../nova/libraryService.js';
import type { DID } from '../../identity/keyManager.js';

const SubmitSchema = z.object({
  author: z.string().min(1),
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  itemType: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const PublishSchema = z.object({
  reviewedBy: z.string().min(1),
});

export async function registerLibraryRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/library/submit — 아이템 제출
  app.post('/api/library/submit', async (request, reply) => {
    try {
      const parsed = SubmitSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const { author, title, content, itemType, tags } = parsed.data;
      const item = await submitToLibrary(author as DID, title, content, itemType, tags);
      return reply.code(201).send({ item });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  });

  // POST /api/library/:itemId/publish — 게시
  app.post('/api/library/:itemId/publish', async (request, reply) => {
    try {
      const { itemId } = request.params as { itemId: string };
      const parsed = PublishSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      }
      const item = await publishLibraryItem(itemId, parsed.data.reviewedBy as DID);
      if (!item) {
        return reply.code(404).send({ error: 'Item not found or already published' });
      }
      return reply.send({ item });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  });

  // GET /api/library/items — 목록 (status, itemType 필터)
  app.get('/api/library/items', async (request, reply) => {
    try {
      const { q = '', limit = '20', offset = '0' } = request.query as Record<string, string>;
      const items = searchLibrary(q, Number(limit), Number(offset));
      return reply.send({ items, total: items.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  });

  // GET /api/library/:itemId — 단일 조회
  app.get('/api/library/:itemId', async (request, reply) => {
    try {
      const { itemId } = request.params as { itemId: string };
      const item = getLibraryItem(itemId);
      if (!item) {
        return reply.code(404).send({ error: 'Item not found' });
      }
      return reply.send({ item });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  });
}
