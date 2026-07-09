/**
 * Nova Government — 교육 API
 * EDUCATION-POLICY.md v2.1 구현
 * - Nova Library 기반 교육 기여 등록
 * - 품질 게이트 검증 (2KB/3.5/3건)
 * - 교육 VC 발급
 * - 기여 등급 보상 (Bronze~Platinum NVC)
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getDb } from '../../storage/database.js';

// ── 상수 (EDUCATION-POLICY v2.1) ──────────────────────────────────────────
const QUALITY_GATE = {
  minSizeBytes: 2048,        // 2KB 최소
  minQualityScore: 3.5,      // 품질 점수 최소 (0-5)
  minReviews: 3,             // 검증자 최소 3인
};

const GRADE_REWARDS: Record<string, number> = {
  bronze: 10,
  silver: 30,
  gold: 70,
  platinum: 150,
};

const MONTHLY_CAPS: Record<string, number> = {
  bronze: 30,
  silver: 100,
  gold: 300,
  platinum: 500,
};

const VC_COMPLETION_THRESHOLD = 0.7; // 70% 이수율

// ── 스키마 ────────────────────────────────────────────────────────────────
const SubmitContributionSchema = z.object({
  authorDid: z.string().min(1),
  title: z.string().min(3).max(200),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  domain: z.enum(['tech', 'culture', 'science', 'governance', 'economics', 'other']).optional(),
});

const ReviewSchema = z.object({
  reviewerDid: z.string().min(1),
  score: z.number().min(0).max(5),
  comment: z.string().max(1000).optional(),
});

export async function registerEducationRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // GET /api/education/contributions — 교육 기여 목록
  app.get('/api/education/contributions', async (req, reply) => {
    const { did, status = 'published', limit = '20' } = req.query as Record<string, string>;
    try {
      let query = 'SELECT * FROM nova_library WHERE 1=1';
      const params: unknown[] = [];
      if (did) { query += ' AND did = ?'; params.push(did); }
      if (status !== 'all') { query += ' AND status = ?'; params.push(status); }
      query += ` ORDER BY created_at DESC LIMIT ${Math.min(parseInt(limit) || 20, 100)}`;

      const items = db.prepare(query).all(...params);
      return reply.send({ items, total: (items as unknown[]).length });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/education/contributions — 교육 기여 제출
  app.post('/api/education/contributions', async (req, reply) => {
    const parsed = SubmitContributionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });

    const { authorDid, title, content, tags, domain } = parsed.data;
    const sizeBytes = Buffer.byteLength(content, 'utf8');

    // 품질 게이트: 크기 체크
    if (sizeBytes < QUALITY_GATE.minSizeBytes) {
      return reply.code(400).send({
        error: `품질 게이트 실패: 내용 크기 ${sizeBytes}B < ${QUALITY_GATE.minSizeBytes}B (2KB 최소)`,
        gate: 'size',
      });
    }

    try {
      const id = randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const tagsJson = JSON.stringify(tags ?? []);
      const contentHash = Buffer.from(content).toString('base64').slice(0, 64);

      db.prepare(`
        INSERT INTO nova_library (id, did, title, content, status, tags, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(id, authorDid, title, content, tagsJson, contentHash, now, now);

      const item = db.prepare('SELECT * FROM nova_library WHERE id = ?').get(id);
      return reply.code(201).send({
        item,
        sizeBytes,
        qualityGate: QUALITY_GATE,
        nextStep: '검증자 3인이 리뷰 후 published 상태로 전환됩니다.',
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/education/contributions/:id — 기여 상세
  app.get<{ Params: { id: string } }>('/api/education/contributions/:id', async (req, reply) => {
    const item = db.prepare('SELECT * FROM nova_library WHERE id = ?').get(req.params.id);
    if (!item) return reply.code(404).send({ error: 'Contribution not found' });
    return reply.send({ item });
  });

  // POST /api/education/contributions/:id/review — 리뷰 제출
  app.post<{ Params: { id: string } }>('/api/education/contributions/:id/review', async (req, reply) => {
    const parsed = ReviewSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });

    const item = db.prepare('SELECT * FROM nova_library WHERE id = ?').get(req.params.id) as any;
    if (!item) return reply.code(404).send({ error: 'Contribution not found' });
    if (item.status === 'published') return reply.code(400).send({ error: '이미 출판된 기여입니다.' });

    // 간단한 리뷰 카운트 (nova_agent_actions에 review 기록)
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO nova_agent_actions
        (action_id, agent_did, action_type, triggered_by, payload_json, status, created_at)
      VALUES (?, ?, 'library_contribution', 'manual', ?, 'success', ?)
    `).run(randomUUID(), parsed.data.reviewerDid,
        JSON.stringify({ libraryId: req.params.id, score: parsed.data.score, comment: parsed.data.comment }),
        now);

    // 리뷰 수 집계 → 게이트 통과 시 publish
    const reviewCount = (db.prepare(`
      SELECT COUNT(*) as cnt FROM nova_agent_actions
      WHERE action_type = 'library_contribution'
        AND payload_json LIKE ? AND status = 'success'
    `).get(`%"libraryId":"${req.params.id}"%`) as any).cnt || 0;

    let published = false;
    if (reviewCount >= QUALITY_GATE.minReviews && parsed.data.score >= QUALITY_GATE.minQualityScore) {
      db.prepare('UPDATE nova_library SET status = ? WHERE id = ?').run('published', req.params.id);
      published = true;
    }

    return reply.send({
      libraryId: req.params.id,
      reviewCount,
      score: parsed.data.score,
      published,
      message: published
        ? `출판 승인! (${reviewCount}/${QUALITY_GATE.minReviews}명 리뷰 완료)`
        : `리뷰 접수 (${reviewCount}/${QUALITY_GATE.minReviews}명 필요)`,
    });
  });

  // POST /api/education/contributions/:id/reward — 기여 보상 지급
  app.post<{ Params: { id: string } }>('/api/education/contributions/:id/reward', async (req, reply) => {
    const item = db.prepare('SELECT * FROM nova_library WHERE id = ?').get(req.params.id) as any;
    if (!item) return reply.code(404).send({ error: 'Contribution not found' });
    if (item.status !== 'published') return reply.code(400).send({ error: '출판된 기여만 보상 가능합니다.' });

    const citizen = db.prepare('SELECT grade_v2 FROM nova_citizens WHERE did = ?').get(item.did) as any;
    const grade = (citizen?.grade_v2 || 'bronze') as string;
    const reward = GRADE_REWARDS[grade] ?? GRADE_REWARDS.bronze;
    const cap = MONTHLY_CAPS[grade] ?? MONTHLY_CAPS.bronze;

    return reply.send({
      did: item.did,
      grade,
      reward,
      monthlyCap: cap,
      message: `${grade} 등급 기여 보상: ${reward} NVC (월 상한 ${cap} NVC)`,
      note: '실제 지급은 NVC 전송 서비스가 처리합니다.',
    });
  });

  // GET /api/education/stats — 교육 통계
  app.get('/api/education/stats', async (_req, reply) => {
    try {
      const total = (db.prepare('SELECT COUNT(*) as cnt FROM nova_library').get() as any).cnt;
      const byStatus = db.prepare('SELECT status, COUNT(*) as cnt FROM nova_library GROUP BY status').all();

      return reply.send({
        total,
        byStatus,
        qualityGate: QUALITY_GATE,
        gradeRewards: GRADE_REWARDS,
        monthlyCaps: MONTHLY_CAPS,
        vcThreshold: `${VC_COMPLETION_THRESHOLD * 100}% 이수율`,
        policy: 'EDUCATION-POLICY v2.1',
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
