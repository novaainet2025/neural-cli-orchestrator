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
});
