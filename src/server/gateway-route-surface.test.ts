import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';

type SurfaceMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'TRACE';

interface SurfaceRoute {
  method: SurfaceMethod;
  pattern: string;
}

// createGateway() 내부의 Fastify 인스턴스가 생성되는 즉시 onRoute를 설치해야
// 플러그인 라우트까지 빠짐없이 볼 수 있다. 소스에 테스트 전용 hook을 추가하지 않는다.
const capturedRoutes = vi.hoisted(() => new Map<string, SurfaceRoute>());

vi.mock('fastify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fastify')>();
  const wrappedFastify = ((options?: unknown) => {
    const app = (actual.default as (value?: unknown) => FastifyInstance)(options);
    app.addHook('preHandler', async (request, reply) => {
      if (request.headers['x-nco-surface-contract'] === '1') {
        return reply.code(204).send();
      }
    });
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        // Fastify가 GET마다 자동 생성하는 HEAD는 별도 NCO 계약이 아니다.
        if (method === 'HEAD') continue;
        // 이 계약 분모는 /api/* HTTP API다. dashboard/static 6개와
        // CORS의 OPTIONS *는 별도 UI/플러그인 surface라 이 분모에 속하지 않는다.
        if (!route.url.startsWith('/api/')) continue;
        const key = `${method} ${route.url}`;
        capturedRoutes.set(key, {
          method: method as SurfaceMethod,
          pattern: route.url,
        });
      }
    });
    return app;
  }) as typeof actual.default;

  return { ...actual, default: wrappedFastify };
});

import { createGateway } from './gateway.js';

const PARAM_VALUES: Record<string, string> = {
  agentId: 'surface-missing-agent',
  taskId: 'surface-missing-task',
  sessionId: 'surface-missing-session',
  discussionId: 'surface-missing-discussion',
  teamId: 'surface-missing-team',
  orgId: 'surface-missing-org',
  runId: 'surface-missing-run',
  workflowRunId: 'surface-missing-workflow',
  did: 'did:nova:surface-missing',
  toDid: 'did:nova:surface-missing',
  ownerDid: 'did:nova:surface-missing',
  name: 'surface-missing.nova',
  filename: 'surface-missing.md',
  id: 'surface-missing-id',
};

export function materializeGatewaySurfaceUrl(pattern: string): string {
  const path = pattern
    .replace(
      /:([A-Za-z0-9_]+)(?:\([^)]*\))?\??/g,
      (_match, name: string) => encodeURIComponent(PARAM_VALUES[name] ?? `surface-missing-${name}`),
    )
    .replace(/\*/g, 'surface-missing');
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}limit=1&offset=0&query=surface-missing`;
}

const EXCLUDED_NON_FINITE_API_ROUTES = new Map([
  [
    'GET /api/events/stream',
    'SSE 계약은 연결을 의도적으로 열어 두므로 유한 HTTP 응답 계약이 아니다',
  ],
]);

// +1: GET /api/schema-harness/status — 스키마 하네스 레지스트리 상태 노출 라우트 추가분.
const EXPECTED_API_ROUTE_COUNT = 428;
const EXPECTED_FINITE_API_ROUTE_COUNT = 427;

describe('complete HTTP gateway contract surface', () => {
  let app: Awaited<ReturnType<typeof createGateway>>;

  beforeAll(async () => {
    capturedRoutes.clear();
    app = await createGateway();
    await app.ready();
  });

  afterAll(async () => {
    // beforeAll 이 죽으면 이 변수가 undefined 인데 close 를 부르면
    // `Cannot read properties of undefined (reading 'close')` 가 나서
    // **원인 실패가 연쇄 실패에 가려진다**(kangnote 실측 2026-08-07: 훅 타임아웃
    // 15건에 딸린 afterAll 오류 4건). 가드를 두면 진짜 원인만 남는다.
    if (app) await app.close();
  });

  it(`captures all ${EXPECTED_FINITE_API_ROUTE_COUNT} finite API contracts`, () => {
    expect(capturedRoutes.size).toBe(EXPECTED_API_ROUTE_COUNT);
    expect([...capturedRoutes.keys()].filter(
      (key) => !EXCLUDED_NON_FINITE_API_ROUTES.has(key),
    )).toHaveLength(EXPECTED_FINITE_API_ROUTE_COUNT);
    expect([...capturedRoutes.keys()].filter((key) => key.startsWith('HEAD '))).toEqual([]);
  });

  it('directly injects every finite contract with deterministic path, query, and safe body input', async () => {
    const failures: string[] = [];
    const executed: string[] = [];

    for (const [key, route] of capturedRoutes) {
      if (EXCLUDED_NON_FINITE_API_ROUTES.has(key)) continue;
      const url = materializeGatewaySurfaceUrl(route.pattern);
      const response: InjectResponse = route.method === 'GET' || route.method === 'OPTIONS'
        ? await app.inject({
          method: route.method,
          url,
          headers: { 'x-nco-surface-contract': '1' },
        })
        : await app.inject({
          method: route.method,
          url,
          headers: {
            'content-type': 'application/json',
            'x-nco-surface-contract': '1',
          },
          // 유효 JSON으로 parser와 route schema를 실행한다. 스키마가 거절하지 않은
          // 요청만 위 테스트 preHandler가 204로 끝내 mutation/network를 차단한다.
          payload: { surfaceContract: true },
        } as any);

      executed.push(key);
      if (response.statusCode >= 500) {
        failures.push(`${key} -> ${response.statusCode} ${response.body.slice(0, 500)}`);
      }
    }

    expect(executed).toHaveLength(EXPECTED_FINITE_API_ROUTE_COUNT);
    expect(new Set(executed).size).toBe(executed.length);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('serves a revisioned provider snapshot with conditional refresh support', async () => {
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
    expect(body.providers.length).toBeGreaterThan(0);
    expect(body.providers.every((provider: { models: unknown[] }) => provider.models.length > 0)).toBe(true);
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

  it('preserves the legacy ai-providers response envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/ai-providers' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('providers');
    expect(response.json()).not.toHaveProperty('revision');
  });

  it('exposes dynamic provider and model readiness separately from the catalog revision', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/ai-providers/readiness' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      generatedAt: expect.any(String),
      providers: expect.any(Array),
    });
    expect(response.json()).not.toHaveProperty('revision');
    expect(response.body).not.toContain('apiKey');
    expect(response.body).not.toContain('healthCheck');
    expect(response.body).not.toContain('systemPrompt');
  });

  it('keeps hygiene mutation behind an explicit confirmation and fresh plan', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/hygiene/status' });
    expect(status.statusCode).toBe(200);

    const missingConfirmation = await app.inject({
      method: 'POST',
      url: '/api/hygiene/clean',
      payload: { apply: true },
    });
    expect(missingConfirmation.statusCode).toBe(400);
    expect(missingConfirmation.json().error).toContain('confirm');

    const missingPlan = await app.inject({
      method: 'POST',
      url: '/api/hygiene/clean',
      payload: { apply: true, confirm: 'CLEAN_NCO_RUNTIME' },
    });
    expect(missingPlan.statusCode).toBe(400);
    expect(missingPlan.json().error).toContain('planId');
  });
});
