/**
 * Nova Government — 기부 및 사회 안전망 API
 * SOCIAL-SAFETY-POLICY.md v2.1 구현
 * - 기부 캠페인 생성/조회
 * - 기부 실행
 * - 긴급 모금 (≥100명 참여 + 24h)
 * - CrS (위기 점수) 조회
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getDb } from '../../storage/database.js';

// ── 상수 (SOCIAL-SAFETY-POLICY v2.1) ──────────────────────────────────────
const EMERGENCY_MIN_PARTICIPANTS = 100;
const EMERGENCY_DURATION_H = 24;
const GUILD_DONATION_LIMIT = 1_000;  // 길드 1인당 1000 NVC 상한
const POVERTY_THRESHOLD = 10;        // 10 NVC 이하 = 빈곤

// CrS 가중치: Balance 30 + Activity 25 + Community 25 + Model 20 = 100
const CRS_WEIGHTS = { balance: 30, activity: 25, community: 25, model: 20 };

// ── 스키마 ────────────────────────────────────────────────────────────────
const CreateCampaignSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(2000).optional(),
  targetAmount: z.number().int().min(1),
  participantLimit: z.number().int().min(1).optional(),
  minParticipants: z.number().int().min(1).optional(),
  durationDays: z.number().int().min(1).max(90).optional(),
});

const DonateSchema = z.object({
  donorDid: z.string().min(1),
  amount: z.number().int().min(1),
});

export async function registerDonationRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb();

  // GET /api/donations/campaigns — 캠페인 목록
  app.get('/api/donations/campaigns', async (req, reply) => {
    const { active = 'true' } = req.query as Record<string, string>;
    try {
      const now = Math.floor(Date.now() / 1000);
      let query = 'SELECT c.*, (SELECT COALESCE(SUM(d.amount),0) FROM nova_donations d WHERE d.campaign_id = c.id) as raised, (SELECT COUNT(*) FROM nova_donations d WHERE d.campaign_id = c.id) as participant_count FROM nova_donation_campaigns c WHERE 1=1';
      const params: unknown[] = [];
      if (active === 'true') {
        query += ' AND (c.expires_at IS NULL OR c.expires_at > ?)';
        params.push(now);
      }
      query += ' ORDER BY c.created_at DESC LIMIT 50';
      const campaigns = db.prepare(query).all(...params);
      return reply.send({ campaigns, total: (campaigns as unknown[]).length });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/donations/campaigns — 캠페인 생성
  app.post('/api/donations/campaigns', async (req, reply) => {
    const parsed = CreateCampaignSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });

    try {
      const id = randomUUID().replace(/-/g, '');
      const now = Math.floor(Date.now() / 1000);
      const expires = parsed.data.durationDays
        ? now + parsed.data.durationDays * 86400
        : null;

      db.prepare(`
        INSERT INTO nova_donation_campaigns
          (id, title, description, target_amount, participant_limit, min_participants, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        parsed.data.title,
        parsed.data.description ?? null,
        parsed.data.targetAmount,
        parsed.data.participantLimit ?? EMERGENCY_MIN_PARTICIPANTS,
        parsed.data.minParticipants ?? 1,
        now,
        expires,
      );

      const campaign = db.prepare('SELECT * FROM nova_donation_campaigns WHERE id = ?').get(id);
      return reply.code(201).send({ campaign });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/donations/campaigns/:id — 캠페인 상세
  app.get<{ Params: { id: string } }>('/api/donations/campaigns/:id', async (req, reply) => {
    const campaign = db.prepare('SELECT * FROM nova_donation_campaigns WHERE id = ?').get(req.params.id);
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });

    const raised = (db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM nova_donations WHERE campaign_id = ?').get(req.params.id) as any).total;
    const participantCount = (db.prepare('SELECT COUNT(DISTINCT donor_did) as cnt FROM nova_donations WHERE campaign_id = ?').get(req.params.id) as any).cnt;

    return reply.send({ campaign, raised, participantCount });
  });

  // POST /api/donations/campaigns/:id/donate — 기부
  app.post<{ Params: { id: string } }>('/api/donations/campaigns/:id/donate', async (req, reply) => {
    const parsed = DonateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid input', details: parsed.error.flatten() });

    const { donorDid, amount } = parsed.data;
    const campaign = db.prepare('SELECT * FROM nova_donation_campaigns WHERE id = ?').get(req.params.id) as any;
    if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });

    const now = Math.floor(Date.now() / 1000);
    if (campaign.expires_at && campaign.expires_at < now) {
      return reply.code(400).send({ error: '캠페인이 만료되었습니다.' });
    }

    // 길드 기부 한도 체크
    if (amount > GUILD_DONATION_LIMIT) {
      return reply.code(400).send({ error: `기부 한도 초과: ${amount} NVC > ${GUILD_DONATION_LIMIT} NVC` });
    }

    try {
      const donationId = randomUUID().replace(/-/g, '');
      db.prepare(`
        INSERT INTO nova_donations (id, donor_did, campaign_id, amount, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(donationId, donorDid, req.params.id, amount, now);

      const raised = (db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM nova_donations WHERE campaign_id = ?').get(req.params.id) as any).total;
      const participantCount = (db.prepare('SELECT COUNT(DISTINCT donor_did) as cnt FROM nova_donations WHERE campaign_id = ?').get(req.params.id) as any).cnt;

      return reply.code(201).send({
        donationId,
        donorDid,
        amount,
        campaignId: req.params.id,
        campaignTitle: campaign.title,
        raised,
        participantCount,
        goalReached: raised >= campaign.target_amount,
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/donations/campaigns/emergency — 긴급 모금 생성
  app.post('/api/donations/campaigns/emergency', async (req, reply) => {
    const body = req.body as Record<string, unknown> ?? {};
    const { title, description, targetAmount } = body;

    if (!title || !targetAmount) {
      return reply.code(400).send({ error: 'title, targetAmount 필수' });
    }

    try {
      const id = randomUUID().replace(/-/g, '');
      const now = Math.floor(Date.now() / 1000);
      const expires = now + EMERGENCY_DURATION_H * 3600;

      db.prepare(`
        INSERT INTO nova_donation_campaigns
          (id, title, description, target_amount, participant_limit, min_participants, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        `[긴급] ${title}`,
        description ?? null,
        Number(targetAmount),
        1000,
        EMERGENCY_MIN_PARTICIPANTS,
        now,
        expires,
      );

      const campaign = db.prepare('SELECT * FROM nova_donation_campaigns WHERE id = ?').get(id);
      return reply.code(201).send({
        campaign,
        emergencyPolicy: {
          minParticipants: EMERGENCY_MIN_PARTICIPANTS,
          durationHours: EMERGENCY_DURATION_H,
          guildLimit: GUILD_DONATION_LIMIT,
        },
        expiresAt: new Date(expires * 1000).toISOString(),
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/donations/:did/crs — 위기 점수(CrS) 조회
  app.get<{ Params: { did: string } }>('/api/donations/:did/crs', async (req, reply) => {
    const { did } = req.params;
    try {
      const wallet = db.prepare('SELECT balance FROM nova_wallets WHERE address = ?').get(did) as any;
      const balance = wallet?.balance ?? 0;

      const citizen = db.prepare('SELECT grade_v2, last_active_at FROM nova_citizens WHERE did = ?').get(did) as any;
      if (!citizen) return reply.code(404).send({ error: 'Citizen not found' });

      // CrS = Balance(30) + Activity(25) + Community(25) + Model(20)
      const now = Math.floor(Date.now() / 1000);
      const lastActive = citizen.last_active_at || now;
      const daysSinceActive = Math.floor((now - lastActive) / 86400);

      // 간단한 CrS 계산
      const balanceScore = Math.min(30, Math.round((balance / 1000) * 30));
      const activityScore = Math.max(0, 25 - Math.round(daysSinceActive / 4));
      const communityScore = 15; // placeholder
      const modelScore = 20;     // placeholder (grade 기반으로 계산 가능)

      const crs = balanceScore + activityScore + communityScore + modelScore;
      const isPoverty = balance < POVERTY_THRESHOLD;

      return reply.send({
        did,
        crs: Math.min(100, crs),
        breakdown: { balance: balanceScore, activity: activityScore, community: communityScore, model: modelScore },
        weights: CRS_WEIGHTS,
        isPoverty,
        balance,
        eligibleForEmergencySupport: isPoverty || crs < 30,
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/donations/stats — 기부 통계
  app.get('/api/donations/stats', async (_req, reply) => {
    try {
      const totalCampaigns = (db.prepare('SELECT COUNT(*) as cnt FROM nova_donation_campaigns').get() as any).cnt;
      const totalDonations = (db.prepare('SELECT COUNT(*) as cnt FROM nova_donations').get() as any).cnt;
      const totalRaised = (db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM nova_donations').get() as any).total;

      return reply.send({
        totalCampaigns,
        totalDonations,
        totalRaised,
        policy: 'SOCIAL-SAFETY-POLICY v2.1',
        limits: {
          emergencyMinParticipants: EMERGENCY_MIN_PARTICIPANTS,
          emergencyDurationH: EMERGENCY_DURATION_H,
          guildDonationLimit: GUILD_DONATION_LIMIT,
          povertyThreshold: POVERTY_THRESHOLD,
        },
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
