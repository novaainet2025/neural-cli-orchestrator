import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redis } = vi.hoisted(() => ({
  redis: {
    xadd: vi.fn(),
    publish: vi.fn(),
    xrange: vi.fn(),
  },
}));

vi.mock('../storage/redis.js', () => ({
  getRedis: vi.fn(async () => redis),
  getSubscriber: vi.fn(),
  isRedisConnected: vi.fn(() => true),
}));

vi.mock('../storage/database.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { EventBus } from './event-bus.js';

describe('EventBus stream cursors', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    redis.xadd.mockResolvedValue('1784716000000-0');
    redis.publish.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('adds the XADD stream ID to the published and local event', async () => {
    const bus = new EventBus();
    const localHandler = vi.fn();
    bus.on('*', localHandler);

    const event = await bus.publish({ type: 'test:event', value: 1 });
    const broadcast = JSON.parse(redis.publish.mock.calls[0][1] as string) as Record<string, unknown>;

    expect(event.streamId).toBe('1784716000000-0');
    expect(broadcast.streamId).toBe('1784716000000-0');
    expect(localHandler).toHaveBeenCalledWith(expect.objectContaining({ streamId: '1784716000000-0' }));
    bus.destroy();
  });

  it('falls back from an event ID cursor and restores stream IDs during replay', async () => {
    const storedEvent = { id: 'evt_legacy', type: 'test:event', timestamp: 1 };
    redis.xrange.mockResolvedValue([
      ['1784716000001-0', ['type', 'test:event', 'data', JSON.stringify(storedEvent), 'retry_count', '0']],
    ]);
    const bus = new EventBus();

    const replayed = await bus.replaySince('evt_legacy');

    expect(redis.xrange).toHaveBeenCalledWith('nco:event-stream', '0', '+', 'COUNT', '500');
    expect(replayed).toEqual([{ ...storedEvent, streamId: '1784716000001-0' }]);

    bus.destroy();
  });

  it('uses an exclusive stream cursor and defensively skips an inclusive duplicate', async () => {
    const cursor = '1784716000001-0';
    const duplicate = { id: 'evt_duplicate', type: 'test:event', timestamp: 1 };
    const next = { id: 'evt_next', type: 'test:event', timestamp: 2 };
    redis.xrange.mockResolvedValue([
      [cursor, ['type', 'test:event', 'data', JSON.stringify(duplicate), 'retry_count', '0']],
      ['1784716000002-0', ['type', 'test:event', 'data', JSON.stringify(next), 'retry_count', '0']],
    ]);
    const bus = new EventBus();

    const replayed = await bus.replaySince(cursor);

    expect(redis.xrange).toHaveBeenCalledWith(
      'nco:event-stream',
      `(${cursor}`,
      '+',
      'COUNT',
      '500',
    );
    expect(replayed).toEqual([{ ...next, streamId: '1784716000002-0' }]);
    bus.destroy();
  });
});
