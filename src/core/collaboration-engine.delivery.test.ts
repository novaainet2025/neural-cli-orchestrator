import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => {
  const insertRun = vi.fn(() => ({ changes: 1 }));
  return {
    publish: vi.fn(async () => undefined),
    sendMessageWithReceipt: vi.fn(),
    insertRun,
    database: {
      transaction: vi.fn((fn: (...args: any[]) => unknown) => fn),
      prepare: vi.fn(() => ({
        run: insertRun,
        get: vi.fn(),
        all: vi.fn(() => []),
      })),
    },
  };
});

vi.mock('../storage/database.js', () => ({
  getDb: () => dependencies.database,
}));
vi.mock('./event-bus.js', () => ({
  eventBus: { publish: dependencies.publish },
}));
vi.mock('./cli-mesh.js', () => ({
  cliMesh: { sendMessageWithReceipt: dependencies.sendMessageWithReceipt },
}));

import { CollaborationEngine } from './collaboration-engine.js';

describe('CollaborationEngine delivery evidence', () => {
  beforeEach(() => {
    dependencies.publish.mockClear();
    dependencies.sendMessageWithReceipt.mockReset();
    dependencies.insertRun.mockClear();
  });

  it('surfaces an invite that was recorded but not queued', async () => {
    dependencies.sendMessageWithReceipt.mockResolvedValue({
      messageId: 'msg_1',
      targetSessionId: 'missing-session',
      status: 'not_queued',
      queuedRecipients: 0,
      historyRecorded: true,
      acknowledged: false,
      reason: 'recipient_unavailable',
    });

    const engine = new CollaborationEngine();
    await engine.create({
      creatorSessionId: 'creator-session',
      creatorAgentId: 'creator-agent',
      title: 'Delivery evidence',
      inviteSessionIds: ['missing-session'],
    });

    expect(dependencies.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'collab:created',
      inviteDelivery: {
        requested: 1,
        queued: 0,
        acknowledgementPending: 0,
        failedTargets: ['missing-session'],
      },
    }));
  });
});
