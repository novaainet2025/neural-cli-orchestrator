import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeshMessage, MeshSession } from './cli-mesh.js';
import { OptimisticUpdateConflictError } from '../storage/optimistic-json.js';

const dependencies = vi.hoisted(() => ({
  connected: true,
  getRedis: vi.fn(),
  publish: vi.fn(async () => undefined),
  persistRun: vi.fn(() => ({ changes: 1 })),
}));

vi.mock('../storage/redis.js', () => ({
  getRedis: dependencies.getRedis,
  isRedisConnected: () => dependencies.connected,
}));
vi.mock('../storage/database.js', () => ({
  getDb: () => ({ prepare: () => ({ run: dependencies.persistRun }) }),
}));
vi.mock('./event-bus.js', () => ({ eventBus: { publish: dependencies.publish } }));

import { cliMesh } from './cli-mesh.js';
import { collaborationLoopGuard } from '../security/collaboration-loop-guard.js';

const existingMessage: MeshMessage = {
  id: 'existing',
  from: 'sender-a',
  fromAgent: 'a',
  to: 'target-session',
  content: 'existing',
  type: 'info',
  createdAt: '2026-07-22T00:00:00.000Z',
  read: false,
};

const concurrentMessage: MeshMessage = {
  ...existingMessage,
  id: 'concurrent',
  content: 'concurrent',
};

function createRedisDouble(execOutcomes: Array<'ok' | 'conflict'> = ['conflict', 'ok']) {
  const key = 'nco:mesh:target-session';
  const session: MeshSession = {
    sessionId: 'target-session',
    agentId: 'target-agent',
    pid: 0,
    status: 'idle',
    workMode: 'idle',
    currentWork: '',
    currentFiles: [],
    branch: 'main',
    startedAt: '2026-07-22T00:00:00.000Z',
    lastHeartbeat: '2026-07-22T00:00:00.000Z',
    messageQueue: [existingMessage],
  };
  const store = new Map([[key, JSON.stringify(session)]]);
  let execCount = 0;
  let pending: { key: string; value: string } | null = null;

  const transactionRedis = {
    watch: vi.fn(async () => 'OK'),
    unwatch: vi.fn(async () => 'OK'),
    get: vi.fn(async (target: string) => store.get(target) ?? null),
    set: vi.fn(async (target: string, value: string) => {
      store.set(target, value);
      return 'OK';
    }),
    multi: vi.fn(() => {
      const multi = {
        set: vi.fn((target: string, value: string) => {
          pending = { key: target, value };
          return multi;
        }),
        exec: vi.fn(async () => {
          execCount++;
          const outcome = execOutcomes.shift() ?? 'ok';
          if (outcome === 'conflict') {
            const latest = JSON.parse(store.get(key)!) as MeshSession;
            if (execCount === 1) latest.messageQueue.push(concurrentMessage);
            store.set(key, JSON.stringify(latest));
            return null;
          }
          if (pending) store.set(pending.key, pending.value);
          return [['OK', 'OK']];
        }),
      };
      return multi;
    }),
    disconnect: vi.fn(),
  };
  const redis = {
    get: vi.fn(async (target: string) => store.get(target) ?? null),
    duplicate: vi.fn(() => transactionRedis),
  };

  return { key, store, redis, transactionRedis };
}

describe('CliMesh message queue', () => {
  beforeEach(() => {
    dependencies.connected = true;
    dependencies.getRedis.mockReset();
    dependencies.publish.mockClear();
    dependencies.persistRun.mockClear();
    collaborationLoopGuard.reset();
    delete process.env.NCO_MESH_COLLAB_LOOP_GUARD;
  });

  it('retries a concurrent direct enqueue without losing either message', async () => {
    const fake = createRedisDouble();
    dependencies.getRedis.mockResolvedValue(fake.redis);

    const delivered = await cliMesh.sendMessage(
      'sender-b',
      'b',
      'target-session',
      'new message',
    );

    const saved = JSON.parse(fake.store.get(fake.key)!) as MeshSession;
    expect(delivered).toBe(1);
    expect(saved.messageQueue.map(message => message.content)).toEqual([
      'existing',
      'concurrent',
      'new message',
    ]);
    expect(fake.transactionRedis.watch).toHaveBeenCalledTimes(2);
    expect(fake.store.get(fake.key)?.startsWith('{')).toBe(true);
  });

  it('returns zero without touching Redis when Redis is unavailable', async () => {
    dependencies.connected = false;

    expect(await cliMesh.sendMessage('sender', 'agent', 'target', 'message')).toBe(0);
    expect(dependencies.getRedis).not.toHaveBeenCalled();
    expect(dependencies.persistRun).toHaveBeenCalledTimes(1);
    expect(dependencies.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'mesh:delivery_failed',
      delivery: expect.objectContaining({
        status: 'not_queued',
        reason: 'mesh_unavailable',
        historyRecorded: true,
        acknowledged: false,
      }),
    }));
  });

  it('returns queue evidence without claiming recipient acknowledgement', async () => {
    const fake = createRedisDouble(['ok']);
    dependencies.getRedis.mockResolvedValue(fake.redis);

    const receipt = await cliMesh.sendMessageWithReceipt(
      'sender-b',
      'b',
      'target-session',
      'new message',
    );

    expect(receipt).toEqual(expect.objectContaining({
      status: 'queued',
      queuedRecipients: 1,
      historyRecorded: true,
      acknowledged: false,
    }));
  });

  it('blocks identical collaboration echoes before Redis enqueue or DB history', async () => {
    const fake = createRedisDouble(['ok', 'ok', 'ok', 'ok']);
    dependencies.getRedis.mockResolvedValue(fake.redis);
    const body = 'done: protocol handoff echo';

    expect((await cliMesh.sendMessageWithReceipt('sender-a', 'a', 'target-session', body)).status).toBe('queued');
    expect((await cliMesh.sendMessageWithReceipt('sender-a', 'a', 'target-session', body)).status).toBe('queued');
    expect((await cliMesh.sendMessageWithReceipt('sender-a', 'a', 'target-session', body)).status).toBe('queued');

    const blocked = await cliMesh.sendMessageWithReceipt('sender-a', 'a', 'target-session', body);
    expect(blocked).toEqual(expect.objectContaining({
      status: 'not_queued',
      queuedRecipients: 0,
      historyRecorded: false,
      acknowledged: false,
      reason: 'collaboration_loop_blocked',
    }));
    expect(dependencies.persistRun).toHaveBeenCalledTimes(3);
    expect(dependencies.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'mesh:delivery_failed',
      delivery: expect.objectContaining({ reason: 'collaboration_loop_blocked' }),
      loop: expect.objectContaining({ rule: 'echo-loop' }),
    }));
  });

  it('skips the collaboration loop guard when the kill switch is off', async () => {
    process.env.NCO_MESH_COLLAB_LOOP_GUARD = 'off';
    const fake = createRedisDouble(Array.from({ length: 5 }, () => 'ok' as const));
    dependencies.getRedis.mockResolvedValue(fake.redis);
    const body = 'done: kill-switch bypass';

    for (let i = 0; i < 5; i++) {
      const receipt = await cliMesh.sendMessageWithReceipt('sender-a', 'a', 'target-session', body);
      expect(receipt.status).toBe('queued');
    }
    expect(dependencies.persistRun).toHaveBeenCalledTimes(5);
  });

  it('propagates an exhausted enqueue conflict without silently losing the message', async () => {
    const fake = createRedisDouble(Array.from({ length: 9 }, () => 'conflict'));
    dependencies.getRedis.mockResolvedValue(fake.redis);

    const send = cliMesh.sendMessage('sender-b', 'b', 'target-session', 'new message');

    await expect(send).rejects.toBeInstanceOf(OptimisticUpdateConflictError);
    const saved = JSON.parse(fake.store.get(fake.key)!) as MeshSession;
    expect(saved.messageQueue.map(message => message.content)).toEqual(['existing', 'concurrent']);
    expect(fake.transactionRedis.watch).toHaveBeenCalledTimes(9);
    expect(fake.transactionRedis.set).not.toHaveBeenCalled();
    expect(dependencies.publish).not.toHaveBeenCalled();
  });
});
