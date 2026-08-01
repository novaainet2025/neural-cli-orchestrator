import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createGateway } from './gateway.js';
import { taskQueue } from '../core/task-queue.js';
import { getDb } from '../storage/database.js';

describe('Provider Registry v2 HTTP contract', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    vi.spyOn(taskQueue, 'enqueue').mockResolvedValue({
      success: true,
      output: 'provider registry route test completed',
      status: 'completed',
    });
    app = await createGateway();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it('serves a secret-free revision and returns 304 for its ETag', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/ai-providers/registry',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      generatedAt: expect.any(String),
      providers: expect.any(Array),
    });
    expect(response.headers.etag).toBe(`"${body.revision}"`);
    expect(response.body).not.toContain('apiKey');
    expect(response.body).not.toContain('healthCheck');
    expect(response.body).not.toContain('systemPrompt');

    const unchanged = await app.inject({
      method: 'GET',
      url: '/api/ai-providers/registry',
      headers: { 'if-none-match': response.headers.etag! },
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe('');
  });

  it('serves secret-free compatibility catalogs without internal commands', async () => {
    for (const url of ['/api/ai-providers', '/api/ai-providers/enabled']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ providers: expect.any(Array) });
      for (const provider of response.json().providers) {
        expect(provider.enabled).toBe(true);
        expect(provider.health ?? {}).toEqual(expect.any(Object));
      }
      expect(response.body).not.toContain('command');
      expect(response.body).not.toContain('args');
      expect(response.body).not.toContain('persona');
      expect(response.body).not.toContain('healthCheck');
      expect(response.body).not.toContain('systemPrompt');
    }
  });

  it('separates fail-closed admission dimensions from bootstrap inference evidence', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/ai-providers/readiness',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      revision: string;
      observations: { inferenceEvidence: string };
      providers: Array<{
        readyForNewWork: boolean;
        inferenceVerified: boolean;
        blockers: string[];
        verificationBlockers: string[];
        dimensions: Record<string, { basis: string }>;
      }>;
    };
    expect(body.revision).toMatch(/^sha256:/);
    expect(body.observations.inferenceEvidence).toBe('process-local-success-receipts');
    expect(body.providers.length).toBeGreaterThan(0);
    for (const provider of body.providers) {
      expect(provider.inferenceVerified).toBe(false);
      expect(provider.blockers).not.toContain('inferenceEvidence');
      expect(provider.verificationBlockers).toContain('inferenceEvidence');
      expect(provider.dimensions.registration.basis).toBe('provider-registry');
      expect(provider.dimensions.admission.basis).toBe('circuit-breaker-admission');
      expect(provider.dimensions.queueCapacity.basis).toBe('queue-capacity');
    }
    expect(response.body).not.toContain('command');
    expect(response.body).not.toContain('persona');
  });

  it('enforces registry lineage and absolute deadlines at task intake', async () => {
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        prompt: 'Return OK',
        metadata: {
          projectDir: process.cwd(),
          providerRevision: 'sha256:stale-client-revision',
        },
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: 'provider_registry_revision_conflict' });

    const expired = await app.inject({
      method: 'POST',
      url: '/api/task',
      payload: {
        prompt: 'Return OK',
        metadata: {
          projectDir: process.cwd(),
          deadlineAt: '2000-01-01T00:00:00.000Z',
        },
      },
    });
    expect(expired.statusCode).toBe(408);
    expect(expired.json()).toMatchObject({ error: 'task_deadline_expired' });
  });

  it('atomically deduplicates exact caller-scoped replays and rejects payload reuse', async () => {
    const registry = await app.inject({ method: 'GET', url: '/api/ai-providers/registry' });
    const providerId = registry.json().providers.find((provider: { enabled: boolean }) => provider.enabled).id;
    const idempotencyKey = 'nova-cli:test-correlation:test-turn:test-attempt';
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const payload = {
      ai: providerId,
      prompt: 'exact replay request',
      callerAgentId: 'nova-cli-test',
      metadata: {
        idempotencyKey,
        projectDir: process.cwd(),
        providerRevision: registry.json().revision,
        deadlineAt,
        companyRunId: 'idempotency-workflow-company',
        workflowIntent: 'routine',
      },
    };

    const [first, replay] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/task', payload }),
      app.inject({ method: 'POST', url: '/api/task', payload }),
    ]);
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(new Set([first.json().taskId, replay.json().taskId]).size).toBe(1);
    expect([first.json().deduplicated, replay.json().deduplicated]).toContain(true);
    const workflowCount = getDb().prepare(`
      SELECT COUNT(*) AS count FROM workflow_runs WHERE company_run_id=?
    `).get(payload.metadata.companyRunId) as { count: number };
    expect(workflowCount.count).toBe(1);

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(deadlineAt) + 1);
    const replayAfterDeadline = await app.inject({ method: 'POST', url: '/api/task', payload });
    nowSpy.mockRestore();
    expect(replayAfterDeadline.statusCode).toBe(202);
    expect(replayAfterDeadline.json()).toMatchObject({
      taskId: first.json().taskId,
      deduplicated: true,
    });

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/task',
      payload: { ...payload, prompt: 'different request reusing the key' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: 'idempotency_key_payload_conflict' });
  });
});
