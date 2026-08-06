import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway } from './gateway.js';

describe('gateway Prometheus metrics route', () => {
  let app: Awaited<ReturnType<typeof createGateway>>;

  beforeAll(async () => {
    app = await createGateway();
    // Fastify rejects duplicate method/path declarations during boot, so
    // reaching ready() also guards the gateway against route collisions.
    await app.ready();
  });

  afterAll(async () => {
    // beforeAll 이 죽으면 이 변수가 undefined 인데 close 를 부르면
    // `Cannot read properties of undefined (reading 'close')` 가 나서
    // **원인 실패가 연쇄 실패에 가려진다**(kangnote 실측 2026-08-07: 훅 타임아웃
    // 15건에 딸린 afterAll 오류 4건). 가드를 두면 진짜 원인만 남는다.
    if (app) await app.close();
  });

  it('mounts exactly the established GET /metrics contract', async () => {
    expect(app.hasRoute({ method: 'GET', url: '/metrics' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/metrics' })).toBe(false);

    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.headers['content-type']).toContain('version=0.0.4');
    expect(response.body).toContain('# TYPE nova_citizens_total gauge');
    expect(response.body).toMatch(/^nco_tasks_total \d+$/m);
    expect(response.body).toMatch(/^error_rate (?:0(?:\.\d+)?|1)$/m);
  });
});
