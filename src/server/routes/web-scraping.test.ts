import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { WebScrapingError } from '../../services/webScrapingService.js';
import { registerWebScrapingRoutes, type WebScrapingRouteDependencies } from './web-scraping.js';

function dependencies(
  overrides: Partial<WebScrapingRouteDependencies> = {},
): WebScrapingRouteDependencies {
  return {
    getCapabilities: vi.fn(async () => ({ ok: true, scrapling: { version: '0.4.11' } })),
    scrape: vi.fn(async () => ({
      ok: true,
      data: { title: ['Example Domain'] },
      meta: { contentTrust: 'untrusted_external' },
    })),
    authConfigured: () => true,
    assertAuthorization: vi.fn(async () => undefined),
    createAuthorization: vi.fn(async (input) => ({
      reference: input.reference,
      allowedDomains: input.allowedDomains,
    })),
    ...overrides,
  };
}

describe('web scraping routes', () => {
  it('requires explicit authorization confirmation before invoking the adapter', async () => {
    const app = Fastify();
    const deps = dependencies();
    await registerWebScrapingRoutes(app, deps);

    const response = await app.inject({
      method: 'POST',
      url: '/api/web-scraping/extract',
      payload: {
        url: 'https://example.com',
        purpose: 'test extraction',
        authorizationConfirmed: false,
        authorizationReference: 'TEST-AUTH-001',
        fields: { title: 'h1::text' },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(deps.scrape).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns bounded field data from the adapter', async () => {
    const app = Fastify();
    const deps = dependencies();
    await registerWebScrapingRoutes(app, deps);

    const response = await app.inject({
      method: 'POST',
      url: '/api/web-scraping/extract',
      payload: {
        url: 'https://example.com',
        purpose: 'test extraction',
        authorizationConfirmed: true,
        authorizationReference: 'TEST-AUTH-001',
        fields: { title: 'h1::text' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      data: { title: ['Example Domain'] },
      meta: { contentTrust: 'untrusted_external' },
    });
    expect(deps.scrape).toHaveBeenCalledOnce();
    await app.close();
  });

  it('maps public-target policy failures to a client error', async () => {
    const app = Fastify();
    const deps = dependencies({
      scrape: vi.fn(async () => {
        throw new WebScrapingError('TARGET_NOT_PUBLIC', 'private target blocked');
      }),
    });
    await registerWebScrapingRoutes(app, deps);

    const response = await app.inject({
      method: 'POST',
      url: '/api/web-scraping/extract',
      payload: {
        url: 'http://127.0.0.1',
        purpose: 'test extraction',
        authorizationConfirmed: true,
        authorizationReference: 'TEST-AUTH-001',
        fields: { title: 'h1::text' },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'TARGET_NOT_PUBLIC', message: 'private target blocked' },
    });
    await app.close();
  });

  it('fails closed when NCO API authentication is not configured', async () => {
    const app = Fastify();
    const deps = dependencies({ authConfigured: () => false });
    await registerWebScrapingRoutes(app, deps);

    const response = await app.inject({
      method: 'POST',
      url: '/api/web-scraping/extract',
      payload: {
        url: 'https://example.com',
        purpose: 'test extraction',
        authorizationConfirmed: true,
        authorizationReference: 'TEST-AUTH-001',
        fields: { title: 'h1::text' },
      },
    });

    expect(response.statusCode).toBe(503);
    expect(deps.assertAuthorization).not.toHaveBeenCalled();
    expect(deps.scrape).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not expose adapter diagnostics in fetch errors', async () => {
    const app = Fastify();
    const deps = dependencies({
      scrape: vi.fn(async () => {
        throw new WebScrapingError('FETCH_FAILED', '/private/runtime/path: connection failed');
      }),
    });
    await registerWebScrapingRoutes(app, deps);

    const response = await app.inject({
      method: 'POST',
      url: '/api/web-scraping/extract',
      payload: {
        url: 'https://example.com',
        purpose: 'test extraction',
        authorizationConfirmed: true,
        authorizationReference: 'TEST-AUTH-001',
        fields: { title: 'h1::text' },
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: { code: 'FETCH_FAILED', message: 'target fetch failed' },
    });
    expect(response.body).not.toContain('/private/runtime/path');
    await app.close();
  });

  it('creates auditable authorization records before extraction', async () => {
    const app = Fastify();
    const deps = dependencies();
    await registerWebScrapingRoutes(app, deps);

    const response = await app.inject({
      method: 'POST',
      url: '/api/web-scraping/authorizations',
      payload: {
        reference: 'TEST-AUTH-001',
        allowedDomains: ['example.com'],
        purpose: 'test extraction',
        approvedBy: 'test-governance',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      authorization: {
        reference: 'TEST-AUTH-001',
        allowedDomains: ['example.com'],
      },
    });
    expect(deps.createAuthorization).toHaveBeenCalledOnce();
    await app.close();
  });
});
