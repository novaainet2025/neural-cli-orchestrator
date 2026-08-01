import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../storage/database.js';
import { registerAuditRoutes } from './audit.js';

const TOKEN = 'audit-write-test-token';
const bearer = { authorization: `Bearer ${TOKEN}` };

describe('audit mutation route authorization', () => {
  const app = Fastify();
  const originalToken = process.env.NCO_AUDIT_WRITE_TOKEN;

  beforeAll(async () => {
    await registerAuditRoutes(app);
    await app.ready();
  });

  beforeEach(() => {
    delete process.env.NCO_AUDIT_WRITE_TOKEN;
    const db = getDb();
    db.prepare('DELETE FROM nova_audit_log').run();
    db.prepare('DELETE FROM nova_audit_epochs').run();
    db.prepare('DELETE FROM nova_emergency_stops').run();
    db.prepare('DELETE FROM nova_blacklist').run();
  });

  afterAll(async () => {
    if (originalToken === undefined) delete process.env.NCO_AUDIT_WRITE_TOKEN;
    else process.env.NCO_AUDIT_WRITE_TOKEN = originalToken;
    await app.close();
  });

  const mutations = [
    {
      method: 'POST' as const,
      url: '/api/audit/logs',
      payload: { actor: 'operator:test', action: 'policy_violation' },
    },
    {
      method: 'POST' as const,
      url: '/api/admin/emergency-stop',
      payload: { triggeredBy: 'did:nova:admin', reason: 'test incident' },
    },
    {
      method: 'DELETE' as const,
      url: '/api/admin/emergency-stop/not-created',
      payload: { liftedBy: 'did:nova:admin' },
    },
    {
      method: 'POST' as const,
      url: '/api/admin/blacklist',
      payload: { did: 'did:nova:blocked', reason: 'test incident', addedBy: 'did:nova:admin' },
    },
  ];

  it.each(mutations)('fails closed with 503 when token is unset: $method $url', async mutation => {
    const response = await app.inject(mutation);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'Audit write endpoint is disabled' });
  });

  it.each(mutations)('rejects wrong token with 403 without localhost bypass: $method $url', async mutation => {
    process.env.NCO_AUDIT_WRITE_TOKEN = TOKEN;
    const response = await app.inject({
      ...mutation,
      headers: { authorization: 'Bearer wrong-token' },
      remoteAddress: '127.0.0.1',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Forbidden' });
  });

  it('allows every protected mutation with the dedicated token', async () => {
    process.env.NCO_AUDIT_WRITE_TOKEN = TOKEN;
    const manual = await app.inject({
      method: 'POST',
      url: '/api/audit/logs',
      headers: bearer,
      payload: { actor: 'operator:test', action: 'policy_violation' },
    });
    expect(manual.statusCode).toBe(201);

    const stop = await app.inject({
      method: 'POST',
      url: '/api/admin/emergency-stop',
      headers: bearer,
      payload: { triggeredBy: 'did:nova:admin', reason: 'test incident' },
    });
    expect(stop.statusCode).toBe(201);
    const stopId = (stop.json() as { stopId: string }).stopId;

    const lift = await app.inject({
      method: 'DELETE',
      url: `/api/admin/emergency-stop/${stopId}`,
      headers: bearer,
      payload: { liftedBy: 'did:nova:admin' },
    });
    expect(lift.statusCode).toBe(200);

    const blacklist = await app.inject({
      method: 'POST',
      url: '/api/admin/blacklist',
      headers: bearer,
      payload: { did: 'did:nova:blocked', reason: 'test incident', addedBy: 'did:nova:admin' },
    });
    expect(blacklist.statusCode).toBe(201);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM nova_audit_log').get() as { n: number }).n)
      .toBe(4);
  });

  it('keeps audit GET routes read-only and available without the write token', async () => {
    const logs = await app.inject({ method: 'GET', url: '/api/audit/logs' });
    const verify = await app.inject({ method: 'GET', url: '/api/audit/verify' });
    expect(logs.statusCode).toBe(200);
    expect(verify.statusCode).toBe(200);
  });
});
