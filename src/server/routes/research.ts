/**
 * Nova Government — 연구 API
 * RESEARCH-POLICY.md v2.3 구현
 * - 연구 프로젝트 등록 및 조회
 * - 연구 보조금 신청 한도 검증
 * - 특허 등록 및 5년 만료 시점 계산
 * - 오픈소스 전환 예정 시점 기록
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getDb } from '../../storage/database.js';

// ── 상수 (RESEARCH-POLICY v2.3) ─────────────────────────────────────────
const MAX_GRANT_NVC = 5000;
const PATENT_DURATION_YEARS = 5;
const OPEN_SOURCE_MONTHS = 12;
const SECONDS_PER_DAY = 24 * 60 * 60;
const SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY;
const SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY;

// ── 스키마 ────────────────────────────────────────────────────────────────
const CreateProjectSchema = z.object({
  did: z.string().min(1),
  title: z.string().min(3).max(200),
  abstract: z.string().max(5000).optional(),
  researchType: z.string().min(1).max(50).optional(),
});

const CreateGrantSchema = z.object({
  projectId: z.string().min(1),
  did: z.string().min(1),
  amount: z.number().int().positive(),
});

const CreatePatentSchema = z.object({
  did: z.string().min(1),
  projectId: z.string().min(1).optional(),
  title: z.string().min(3).max(200),
  description: z.string().max(5000).optional(),
});

export async function registerResearchRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  const insertProject = db.prepare(`
    INSERT INTO nova_research_projects
      (id, did, title, abstract, research_type, status, open_source_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  const selectProjectById = db.prepare('SELECT * FROM nova_research_projects WHERE id = ?');
  const selectGrantById = db.prepare('SELECT * FROM nova_research_grants WHERE id = ?');
  const selectPatentById = db.prepare('SELECT * FROM nova_patents WHERE id = ?');
  const selectProjectExists = db.prepare('SELECT id FROM nova_research_projects WHERE id = ?');
  const insertGrant = db.prepare(`
    INSERT INTO nova_research_grants
      (id, project_id, did, amount, status, approved_at, created_at)
    VALUES (?, ?, ?, ?, 'pending', NULL, ?)
  `);
  const insertPatent = db.prepare(`
    INSERT INTO nova_patents
      (id, did, project_id, title, description, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const countProjects = db.prepare('SELECT COUNT(*) as cnt FROM nova_research_projects');
  const countGrants = db.prepare('SELECT COUNT(*) as cnt FROM nova_research_grants');
  const countPatents = db.prepare('SELECT COUNT(*) as cnt FROM nova_patents');

  // POST /api/research/projects — 연구 프로젝트 등록
  app.post('/api/research/projects', async (req, reply) => {
    const parsed = CreateProjectSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });

    try {
      const { did, title, abstract, researchType } = parsed.data;
      const id = randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const openSourceAt = now + (OPEN_SOURCE_MONTHS * SECONDS_PER_MONTH);

      insertProject.run(
        id,
        did,
        title,
        abstract ?? null,
        researchType ?? 'basic',
        openSourceAt,
        now,
        now,
      );

      const item = selectProjectById.get(id);
      return reply.code(201).send({
        item,
        policy: 'RESEARCH-POLICY v2.3',
        openSourceMonths: OPEN_SOURCE_MONTHS,
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/research/projects — 연구 프로젝트 목록
  app.get('/api/research/projects', async (req, reply) => {
    const { did, status, limit = '20' } = req.query as Record<string, string | undefined>;
    try {
      let query = 'SELECT * FROM nova_research_projects WHERE 1=1';
      const params: unknown[] = [];
      if (did) {
        query += ' AND did = ?';
        params.push(did);
      }
      if (status) {
        query += ' AND status = ?';
        params.push(status);
      }

      const parsedLimit = Number.parseInt(limit ?? '20', 10);
      const safeLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 20;
      query += ` ORDER BY created_at DESC LIMIT ${safeLimit}`;

      const items = db.prepare(query).all(...params);
      return reply.send({ items, total: (items as unknown[]).length });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/research/grants — 연구 보조금 신청
  app.post('/api/research/grants', async (req, reply) => {
    const parsed = CreateGrantSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });

    const { projectId, did, amount } = parsed.data;
    if (amount > MAX_GRANT_NVC) {
      return reply.code(400).send({
        error: `Grant amount exceeds max limit of ${MAX_GRANT_NVC} NVC`,
        maxGrantNvc: MAX_GRANT_NVC,
      });
    }

    const project = selectProjectExists.get(projectId);
    if (!project) return reply.code(404).send({ error: 'Research project not found' });

    try {
      const id = randomUUID();
      const now = Math.floor(Date.now() / 1000);

      insertGrant.run(id, projectId, did, amount, now);

      const item = selectGrantById.get(id);
      return reply.code(201).send({
        item,
        policy: 'RESEARCH-POLICY v2.3',
        maxGrantNvc: MAX_GRANT_NVC,
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/research/patents — 특허 등록
  app.post('/api/research/patents', async (req, reply) => {
    const parsed = CreatePatentSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });

    const { did, projectId, title, description } = parsed.data;
    if (projectId) {
      const project = selectProjectExists.get(projectId);
      if (!project) return reply.code(404).send({ error: 'Research project not found' });
    }

    try {
      const id = randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + (PATENT_DURATION_YEARS * SECONDS_PER_YEAR);

      insertPatent.run(id, did, projectId ?? null, title, description ?? null, expiresAt, now);

      const item = selectPatentById.get(id);
      return reply.code(201).send({
        item,
        policy: 'RESEARCH-POLICY v2.3',
        patentDurationYears: PATENT_DURATION_YEARS,
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/research/stats — 연구 통계
  app.get('/api/research/stats', async (_req, reply) => {
    try {
      const totalProjects = (countProjects.get() as { cnt: number }).cnt;
      const totalGrants = (countGrants.get() as { cnt: number }).cnt;
      const totalPatents = (countPatents.get() as { cnt: number }).cnt;

      return reply.send({
        totalProjects,
        totalGrants,
        totalPatents,
        limits: {
          maxGrantNvc: MAX_GRANT_NVC,
          patentDurationYears: PATENT_DURATION_YEARS,
          openSourceMonths: OPEN_SOURCE_MONTHS,
        },
        policy: 'RESEARCH-POLICY v2.3',
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
