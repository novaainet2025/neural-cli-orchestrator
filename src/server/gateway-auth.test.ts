import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway } from './gateway.js';

describe.sequential('gateway API token auth', () => {
  let server: Awaited<ReturnType<typeof createGateway>>;
  let previousToken: string | undefined;

  beforeAll(async () => {
    previousToken = process.env.NCO_API_TOKEN;
    delete process.env.NCO_API_TOKEN;
    server = await createGateway();
  });

  afterAll(async () => {
    // beforeAll 이 죽으면 이 변수가 undefined 인데 close 를 부르면
    // `Cannot read properties of undefined (reading 'close')` 가 나서
    // **원인 실패가 연쇄 실패에 가려진다**(kangnote 실측 2026-08-07: 훅 타임아웃
    // 15건에 딸린 afterAll 오류 4건). 가드를 두면 진짜 원인만 남는다.
    if (server) await server.close();
    if (previousToken === undefined) delete process.env.NCO_API_TOKEN;
    else process.env.NCO_API_TOKEN = previousToken;
  });

  it('is opt-in and accepts a matching bearer token', async () => {
    const request = {
      method: 'POST' as const,
      url: '/api/add',
      payload: { a: 1, b: 1 },
      remoteAddress: '203.0.113.10',
    };

    process.env.NCO_API_TOKEN = '';
    const optOutResponse = await server.inject(request);
    expect(optOutResponse.statusCode).toBe(200);

    process.env.NCO_API_TOKEN = 'test-api-token';
    const missingHeaderResponse = await server.inject(request);
    expect(missingHeaderResponse.statusCode).toBe(401);

    const localhostResponse = await server.inject({ ...request, remoteAddress: '127.0.0.1' });
    expect(localhostResponse.statusCode).toBe(200);

    const authorizedResponse = await server.inject({
      ...request,
      headers: { authorization: 'Bearer test-api-token' },
    });
    expect(authorizedResponse.statusCode).toBe(200);

    const ncoHeaderResponse = await server.inject({
      ...request,
      headers: { 'x-nco-token': 'test-api-token' },
    });
    expect(ncoHeaderResponse.statusCode).toBe(200);
  });

  it('protects remote mesh heartbeat and event stream while keeping health exempt', async () => {
    process.env.NCO_API_TOKEN = 'test-api-token';
    const remoteAddress = '203.0.113.10';

    const heartbeat = await server.inject({
      method: 'POST',
      url: '/api/mesh/heartbeat',
      remoteAddress,
    });
    const eventStream = await server.inject({
      method: 'GET',
      url: '/api/events/stream',
      remoteAddress,
    });
    const health = await server.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress,
    });

    expect(heartbeat.statusCode).toBe(401);
    expect(eventStream.statusCode).toBe(401);
    expect(health.statusCode).toBe(200);
  });
});
