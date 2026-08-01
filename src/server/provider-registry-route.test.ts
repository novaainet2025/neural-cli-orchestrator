import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createGateway } from './gateway.js';

describe('Provider Registry v2 HTTP contract', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createGateway();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
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
});
