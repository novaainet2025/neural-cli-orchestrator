import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway } from '../gateway.js';

let server: Awaited<ReturnType<typeof createGateway>>;

beforeAll(async () => {
  server = await createGateway();
});

afterAll(async () => {
  await server.close();
});

describe('POST /api/add', () => {
  it('returns the expected result for 1 + 1', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/add',
      payload: { a: 1, b: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: 2, ok: true });
  });

  it('rejects invalid numeric input', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/add',
      payload: { a: '1', b: 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Invalid numbers',
      message: 'Invalid numbers: "a" must be a finite number',
      statusCode: 400,
    });
  });
});
