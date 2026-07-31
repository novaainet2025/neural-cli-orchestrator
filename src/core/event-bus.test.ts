import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redis, redisState } = vi.hoisted(() => ({
  redis: {
    xadd: vi.fn(),
    publish: vi.fn(),
    xrange: vi.fn(),
    xgroup: vi.fn(),
    ping: vi.fn(),
  },
  redisState: { connected: true },
}));

vi.mock('../storage/redis.js', () => ({
  getRedis: vi.fn(async () => redis),
  getSubscriber: vi.fn(),
  isRedisConnected: vi.fn(() => redisState.connected),
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

import { getSubscriber } from '../storage/redis.js';
import { getDb } from '../storage/database.js';
import { EventBus } from './event-bus.js';

describe('EventBus stream cursors', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    redisState.connected = true;
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

  it('isolates a throwing typed subscriber and still notifies wildcard subscribers', async () => {
    const bus = new EventBus();
    const wildcardHandler = vi.fn();
    bus.on('test:event', () => {
      throw new Error('subscriber exploded');
    });
    bus.on('*', wildcardHandler);

    await expect(bus.publish({ type: 'test:event', value: 1 })).resolves.toMatchObject({
      type: 'test:event',
    });
    expect(wildcardHandler).toHaveBeenCalledTimes(1);
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

describe('EventBus Redis outage recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    redisState.connected = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues locally published events for replay while Redis is offline', async () => {
    const statements: string[] = [];
    vi.mocked(getDb).mockReturnValue({
      prepare: (sql: string) => {
        statements.push(sql);
        return { run: vi.fn() };
      },
    } as never);
    const bus = new EventBus();

    await bus.publish({ type: 'test:offline', value: 1 });

    expect(statements.some(sql => sql.includes('INSERT OR IGNORE INTO event_queue'))).toBe(true);
    bus.destroy();
  });

  it('subscribes automatically when an initially unavailable Redis subscriber reconnects', async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const subscriber = {
      subscribe: vi.fn(async () => 1),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
        return subscriber;
      }),
      off: vi.fn(() => subscriber),
    };
    vi.mocked(getSubscriber)
      .mockRejectedValueOnce(new Error('Redis unavailable at boot'))
      .mockResolvedValue(subscriber as never);
    vi.mocked(getDb).mockReturnValue({
      prepare: () => ({ run: vi.fn(), all: vi.fn(() => []) }),
    } as never);
    const bus = new EventBus();

    await bus.init();
    expect(subscriber.subscribe).not.toHaveBeenCalled();
    expect(handlers.has('connect')).toBe(false);

    handlers.get('ready')?.();
    await vi.waitFor(() => expect(subscriber.subscribe).toHaveBeenCalledWith('nco:events'));

    bus.destroy();
    expect(subscriber.off).toHaveBeenCalledTimes(2);
  });
});

describe('discussion failure-cause persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    redisState.connected = true;
    redis.xadd.mockResolvedValue('1784716000000-0');
    redis.publish.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  const withRecordingDb = async (
    event: Record<string, unknown>,
  ): Promise<unknown[][]> => {
    const rows: unknown[][] = [];
    vi.mocked(getDb).mockReturnValue({
      prepare: () => ({ run: (...args: unknown[]) => rows.push(args) }),
    } as never);

    const bus = new EventBus();
    await bus.publish(event as never);
    bus.destroy();
    return rows;
  };

  it('참가자별 토론 실패 원인을 agent_actions에 보존한다', async () => {
    const rows = await withRecordingDb({
      type: 'discussion:provider_failed',
      sessionId: 'sess_audit',
      agentId: 'agy',
      round: 1,
      error: 'TimeoutError: The operation was aborted due to timeout',
    });

    expect(rows).toHaveLength(1);
    const [, agentId, actionType, , detailJson, , sessionId] = rows[0] as string[];
    expect({ agentId, actionType, sessionId }).toEqual({
      agentId: 'agy',
      actionType: 'discussion:provider_failed',
      sessionId: 'sess_audit',
    });
    expect(JSON.parse(detailJson).error).toContain('TimeoutError');
  });

  it('토론 전체 실패도 활성·제외 참가자와 함께 보존한다', async () => {
    const rows = await withRecordingDb({
      type: 'discussion:failed',
      sessionId: 'sess_audit',
      round: 1,
      error: 'discussion_insufficient_valid_proposals:0/2',
      activeParticipants: [],
      excludedParticipants: ['ollama', 'agy', 'cursor-agent'],
    });

    expect(rows).toHaveLength(1);
    const detail = JSON.parse((rows[0] as string[])[4]);
    expect(detail.error).toBe('discussion_insufficient_valid_proposals:0/2');
    expect(detail.excludedParticipants).toEqual(['ollama', 'agy', 'cursor-agent']);
  });

  it('보존 대상이 아닌 이벤트는 DB에 기록하지 않는다', async () => {
    const rows = await withRecordingDb({
      type: 'discussion:provider_started',
      sessionId: 'sess_audit',
      agentId: 'agy',
      round: 1,
    });

    expect(rows).toHaveLength(0);
  });
});
