import { createGateway } from '../server/gateway.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

let server: any;

beforeAll(async () => {
  server = await createGateway();
});

afterAll(async () => {
  await server?.close();
});

describe('Simple greeting', () => {
  test('GET / should return a friendly JSON response', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ message: 'NCO Backend is running', status: 'ok' });
  });

  test('fleet route does not expose internal exception details', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/fleet/missing-node-for-error-sanitization/activate',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Fleet action failed', statusCode: 400 });
    expect(res.body).not.toContain('not registered');
  });
});
