import type { FastifyInstance } from 'fastify';
import { z } from 'zod/v4';
import {
  buildTriadPlan,
  certifyEfficiencyRuns,
  loadTriadPolicy,
} from '../../core/triad-policy.js';
import { triadOrchestrator } from '../../core/triad-orchestrator.js';
import { resolveInternalProjectDir } from '../../utils/project-dir.js';

const ProfileSchema = z.enum(['fast', 'standard', 'experience', 'ultra']);
const ProofKindSchema = z.enum([
  'verifier_exit_0',
  'behavior_probe',
  'a11y',
  'user_path',
  'visual_or_dom',
]);
const ProofCommandSchema = z.object({
  name: z.string().trim().min(1).max(120),
  command: z.string().trim().min(1).max(2_000),
  kind: ProofKindSchema,
  timeoutMs: z.number().int().min(1_000).max(900_000).optional(),
});
const RunSchema = z.object({
  goal: z.string().trim().min(1).max(100_000),
  projectDir: z.string().trim().min(1).optional(),
  profile: ProfileSchema.optional(),
  ownedFiles: z.array(z.string().trim().min(1).max(1_000)).max(500).optional(),
  proofCommands: z.array(ProofCommandSchema).max(20).optional(),
  dryRun: z.boolean().optional(),
});
const PlanSchema = RunSchema.pick({ goal: true, profile: true });
const EfficiencySampleSchema = z.object({
  verifiedCompletions: z.number().nonnegative(),
  wallClockHours: z.number().positive(),
  falsePassRate: z.number().min(0).max(1),
  postMergeDefectsPer100: z.number().nonnegative(),
  averageConcurrentWorkers: z.number().positive(),
  serialWallClockHours: z.number().positive().optional(),
});
const CertificationSchema = z.object({
  baseline: z.array(EfficiencySampleSchema).min(1).max(100),
  candidate: z.array(EfficiencySampleSchema).min(1).max(100),
});

function issues(error: z.ZodError): string[] {
  return error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`);
}

export async function registerTriadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/triad/policy', async () => {
    const policy = loadTriadPolicy();
    return {
      policy,
      claimStatus: 'target-not-certified',
      claimRule: policy.kpi.claimPolicy,
    };
  });

  app.post('/api/triad/plan', async (req, reply) => {
    const parsed = PlanSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_triad_plan', issues: issues(parsed.error) };
    }
    return {
      plan: buildTriadPlan(parsed.data.goal, parsed.data.profile),
      claimStatus: 'target-not-certified',
    };
  });

  app.post('/api/triad/run', async (req, reply) => {
    const parsed = RunSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_triad_run', issues: issues(parsed.error) };
    }
    try {
      const run = triadOrchestrator.start(app, {
        ...parsed.data,
        projectDir: parsed.data.projectDir ?? resolveInternalProjectDir(),
      });
      reply.code(parsed.data.dryRun ? 200 : 202);
      return { run };
    } catch (error) {
      reply.code(400);
      return {
        error: 'triad_run_rejected',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });

  app.get('/api/triad/runs', async (req) => {
    const raw = Number((req.query as { limit?: string } | undefined)?.limit ?? 20);
    const limit = Math.max(1, Math.min(Number.isFinite(raw) ? Math.trunc(raw) : 20, 100));
    const runs = triadOrchestrator.list(limit);
    return { runs, count: runs.length };
  });

  app.get<{ Params: { id: string } }>('/api/triad/runs/:id', async (req, reply) => {
    const run = triadOrchestrator.get(req.params.id);
    if (!run) {
      reply.code(404);
      return { error: 'triad_run_not_found' };
    }
    return { run };
  });

  app.post('/api/triad/efficiency/certify', async (req, reply) => {
    const parsed = CertificationSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_efficiency_receipts', issues: issues(parsed.error) };
    }
    return {
      certification: certifyEfficiencyRuns(parsed.data.baseline, parsed.data.candidate),
      claimPolicy: loadTriadPolicy().kpi.claimPolicy,
    };
  });
}
