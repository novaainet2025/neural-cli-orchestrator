/**
 * Nova Government — 공무원 + 플러그인 + 포럼 API 라우트
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getOfficials, getOfficial, getRecentActions, togglePlugin, getPlugins, getPlugin,
  listGovDocs, readGovDoc, getSalaryGoal, getSalaryHistory, setSalaryGoal,
  evaluateAndPaySalary, evaluateAllSalaries,
} from '../../nova/governmentService.js';
import { createPost, getPosts, getPost, getReplies, upvotePost } from '../../nova/forumService.js';
import type { DID } from '../../identity/keyManager.js';

const CreatePostSchema = z.object({
  authorDid: z.string().min(1),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(10000),
  category: z.enum(['general', 'policy', 'culture', 'economy', 'security', 'announcement']).optional(),
  parentId: z.string().uuid().optional(),
});

export async function registerGovernmentOfficialRoutes(app: FastifyInstance): Promise<void> {

  // ── 공무원 ────────────────────────────────────────────────────────────────

  // GET /api/government/officials
  app.get('/api/government/officials', async (request, reply) => {
    try {
      const { ministry } = request.query as Record<string, string>;
      const officials = getOfficials(ministry);
      return reply.send({ officials, total: officials.length });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/government/officials/:did
  app.get('/api/government/officials/:did', async (request, reply) => {
    try {
      const { did } = request.params as { did: string };
      const official = getOfficial(did as DID);
      if (!official) return reply.code(404).send({ error: 'Official not found' });
      return reply.send({ official });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/government/actions
  app.get('/api/government/actions', async (request, reply) => {
    try {
      const { limit } = request.query as Record<string, string>;
      const actions = getRecentActions(limit ? Number(limit) : 50);
      return reply.send({ actions, total: actions.length });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── 플러그인 ──────────────────────────────────────────────────────────────

  // GET /api/government/plugins
  app.get('/api/government/plugins', async (request, reply) => {
    try {
      const { category } = request.query as Record<string, string>;
      const plugins = getPlugins(category);
      return reply.send({ plugins, total: plugins.length });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/government/plugins/:id
  app.get('/api/government/plugins/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const plugin = getPlugin(id);
      if (!plugin) return reply.code(404).send({ error: 'Plugin not found' });
      return reply.send({ plugin });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/government/plugins/:id/toggle
  app.post('/api/government/plugins/:id/toggle', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const plugin = togglePlugin(id);
      return reply.send({ plugin, message: `Plugin ${plugin.status === 'active' ? '활성화' : '비활성화'} 완료` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return reply.code(404).send({ error: msg });
      return reply.code(500).send({ error: msg });
    }
  });

  // ── 포럼 ─────────────────────────────────────────────────────────────────

  // GET /api/forum/posts
  app.get('/api/forum/posts', async (request, reply) => {
    try {
      const { category, limit = '50', offset = '0' } = request.query as Record<string, string>;
      const posts = getPosts(category, Number(limit), Number(offset));
      return reply.send({ posts, total: posts.length });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/forum/posts
  app.post('/api/forum/posts', async (request, reply) => {
    try {
      const parsed = CreatePostSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
      const post = createPost({
        authorDid: parsed.data.authorDid as DID,
        title: parsed.data.title,
        content: parsed.data.content,
        category: parsed.data.category,
        parentId: parsed.data.parentId,
      });
      return reply.code(201).send({ post });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/forum/posts/:id
  app.get('/api/forum/posts/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const post = getPost(id);
      if (!post) return reply.code(404).send({ error: 'Post not found' });
      const replies = getReplies(id);
      return reply.send({ post, replies });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/forum/posts/:id/upvote
  app.post('/api/forum/posts/:id/upvote', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { voterDid } = (request.body as Record<string, string>) ?? {};
      const post = upvotePost(id, (voterDid ?? 'did:nova:anonymous') as DID);
      return reply.send({ post });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return reply.code(404).send({ error: msg });
      return reply.code(500).send({ error: msg });
    }
  });

  // ── 정부 문서 뷰어 ─────────────────────────────────────────────────────────

  // GET /api/nova/docs — 문서 목록
  app.get('/api/nova/docs', async (_request, reply) => {
    try {
      const docs = listGovDocs();
      return reply.send({ docs, total: docs.length });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/nova/docs/:filename — 특정 문서 내용 (마크다운)
  app.get('/api/nova/docs/:filename', async (request, reply) => {
    try {
      const { filename } = request.params as { filename: string };
      const content = readGovDoc(filename);
      return reply.header('Content-Type', 'text/markdown; charset=utf-8').send(content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT') || msg.includes('Invalid filename')) {
        return reply.code(404).send({ error: '문서를 찾을 수 없습니다' });
      }
      return reply.code(500).send({ error: msg });
    }
  });

  // ── 공무원 급여 시스템 ─────────────────────────────────────────────────────

  // GET /api/government/officials/:did/salary — 급여 상태 조회
  app.get('/api/government/officials/:did/salary', async (request, reply) => {
    try {
      const { did } = request.params as { did: string };
      const goal = getSalaryGoal(did);
      const history = getSalaryHistory(did);
      return reply.send({ did, goal, history, total: history.length });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/government/officials/:did/salary/evaluate — 성과 평가 + 월급 지급
  app.post('/api/government/officials/:did/salary/evaluate', async (request, reply) => {
    try {
      const { did } = request.params as { did: string };
      const { period } = (request.body as Record<string, string>) ?? {};
      const payment = evaluateAndPaySalary(did, period);
      const message = payment.goalMet
        ? `✅ 월급 지급 완료 — ${payment.salaryAmount} NVC (${payment.actionsCount}/${payment.goalRequired}회 달성)`
        : `⏭ 월급 지급 건너뜀 — 성과 목표 미달성 (${payment.actionsCount}/${payment.goalRequired}회)`;
      return reply.send({ payment, message });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  });

  // PUT /api/government/officials/:did/salary/goals — 급여 목표 설정
  app.put('/api/government/officials/:did/salary/goals', async (request, reply) => {
    try {
      const { did } = request.params as { did: string };
      const { monthlySalary, goalActions, goalTypes, description } =
        (request.body as Record<string, unknown>) ?? {};
      if (!monthlySalary || !goalActions) {
        return reply.code(400).send({ error: 'monthlySalary와 goalActions는 필수입니다' });
      }
      const goal = setSalaryGoal(did, {
        monthlySalary: Number(monthlySalary),
        goalActions: Number(goalActions),
        goalTypes: Array.isArray(goalTypes) ? goalTypes as string[] : undefined,
        description: typeof description === 'string' ? description : undefined,
      });
      return reply.send({ goal, message: '급여 목표가 설정되었습니다' });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/government/salary/evaluate-all — 전체 공무원 일괄 급여 평가
  app.post('/api/government/salary/evaluate-all', async (request, reply) => {
    try {
      const { period } = (request.body as Record<string, string>) ?? {};
      const results = evaluateAllSalaries(period);
      const paid = results.filter(r => r.goalMet).length;
      const skipped = results.filter(r => !r.goalMet).length;
      return reply.send({
        results,
        summary: { total: results.length, paid, skipped },
        message: `급여 평가 완료 — ${paid}명 지급, ${skipped}명 건너뜀`,
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
