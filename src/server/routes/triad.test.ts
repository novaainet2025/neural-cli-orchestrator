import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerTriadRoutes } from './triad.js';

describe('triad routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    await registerTriadRoutes(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns an asymmetric plan without making a 5x claim', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/triad/plan',
      payload: { goal: '백엔드 SQLite 버그 수정' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.plan.providers.builder).toBe(true);
    expect(body.plan.providers.experience).toBe(false);
    expect(body.claimStatus).toBe('target-not-certified');
  });

  it('creates a dry-run plan without provider calls', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/triad/run',
      payload: {
        goal: '백엔드 SQLite 버그 수정',
        projectDir: process.cwd(),
        dryRun: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().run.status).toBe('planned');
  });

  it('rejects an under-sampled 5x certification', async () => {
    const sample = {
      verifiedCompletions: 1,
      wallClockHours: 1,
      falsePassRate: 0,
      postMergeDefectsPer100: 0,
      averageConcurrentWorkers: 1,
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/triad/efficiency/certify',
      payload: {
        baseline: [sample],
        candidate: [{ ...sample, verifiedCompletions: 5, wallClockHours: 0.2 }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().certification.certified).toBe(false);
  });
});
