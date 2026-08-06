import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway } from '../gateway.js';

let server: Awaited<ReturnType<typeof createGateway>>;

beforeAll(async () => {
  server = await createGateway();
});

afterAll(async () => {
  // beforeAll 이 죽으면 이 변수가 undefined 인데 close 를 부르면
  // `Cannot read properties of undefined (reading 'close')` 가 나서
  // **원인 실패가 연쇄 실패에 가려진다**(kangnote 실측 2026-08-07: 훅 타임아웃
  // 15건에 딸린 afterAll 오류 4건). 가드를 두면 진짜 원인만 남는다.
  if (server) await server.close();
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
