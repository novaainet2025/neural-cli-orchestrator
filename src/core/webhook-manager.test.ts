import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbPrepare, eventPublish, log } = vi.hoisted(() => ({
  dbPrepare: vi.fn(),
  eventPublish: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../storage/database.js', () => ({
  getDb: () => ({ prepare: dbPrepare }),
}));

vi.mock('./event-bus.js', () => ({
  eventBus: { publish: eventPublish },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => log,
}));

import { dispatchWebhook } from './webhook-manager.js';

describe('dispatchWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventPublish.mockResolvedValue(undefined);
  });

  it('logs a hit-count update failure and continues dispatching', async () => {
    dbPrepare.mockImplementation((sql: string) => {
      if (sql.includes('SELECT * FROM webhook_routes')) {
        return {
          get: vi.fn(() => ({
            id: 'route-1',
            path: 'example',
            method: 'POST',
            description: '',
            action_type: 'log',
            action_payload: '{}',
            secret: '',
            enabled: 1,
            hit_count: 0,
            last_hit_at: null,
            created_at: '2026-07-23T00:00:00.000Z',
          })),
        };
      }

      if (sql.includes('UPDATE webhook_routes')) {
        return {
          run: vi.fn(() => {
            throw new Error('database is locked');
          }),
        };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await dispatchWebhook(
      'example',
      'POST',
      { message: 'hello' },
      '{"message":"hello"}',
    );

    expect(result).toEqual({ status: 200, message: 'ok' });
    expect(log.warn).toHaveBeenCalledWith(
      { err: 'database is locked', routeId: 'route-1' },
      'Failed to update webhook hit count',
    );
    expect(eventPublish).toHaveBeenCalledOnce();
  });
});
