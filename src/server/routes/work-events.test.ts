import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock('../../storage/database.js', () => ({
  getDb: mocks.getDb,
}));

import { registerWorkEventRoutes } from './work-events.js';

describe('work event routes', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(readFileSync(resolve('db/migrations/092_work_event_ledger.sql'), 'utf8'));
    mocks.getDb.mockReturnValue(db);
    app = Fastify();
    await registerWorkEventRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    mocks.getDb.mockReset();
  });

  it('ingests, redacts, and queries an external bug event', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/work-events',
      payload: {
        source: 'test-runner',
        category: 'bug',
        eventType: 'bug:reproduced',
        severity: 'warning',
        title: 'Bug reproduced',
        detail: {
          apiToken: 'must-not-survive',
          message: 'provider returned sk-test_abcdefghijklmnop',
        },
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().event.detail).toEqual({
      apiToken: '[REDACTED]',
      message: 'provider returned [REDACTED]',
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/work-events?category=bug&limit=10',
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      count: 1,
      events: [{
        source: 'test-runner',
        category: 'bug',
        eventType: 'bug:reproduced',
      }],
    });

    const coverage = await app.inject({
      method: 'GET',
      url: '/api/work-events/coverage',
    });
    expect(coverage.statusCode).toBe(200);
    expect(coverage.json().chain).toEqual({ total: 1, unique_hashes: 1, broken_links: 0 });
  });

  it('rejects unknown categories', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/work-events',
      payload: {
        source: 'test-runner',
        category: 'unknown',
        eventType: 'unknown:event',
        title: 'Unknown',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects oversized detail payloads', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/work-events',
      payload: {
        source: 'test-runner',
        eventType: 'issue:oversized',
        title: 'Oversized',
        detail: { value: 'x'.repeat(257 * 1024) },
      },
    });
    expect(response.statusCode).toBe(413);
  });
});
