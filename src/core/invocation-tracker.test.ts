import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { closeDb, getDb, runMigrations } from '../storage/database.js';
import { env } from '../utils/config.js';
import { cliMesh } from './cli-mesh.js';
import { invocationTracker } from './invocation-tracker.js';
import type { MeshEnqueueReceipt } from '../mesh/delivery.js';

/** cliMesh.sendMessageWithReceipt가 반환하는 최소 영수증 픽스처. */
function receipt(overrides: Partial<MeshEnqueueReceipt> = {}): MeshEnqueueReceipt {
  return {
    messageId: 'msg_test',
    targetSessionId: 'caller-session',
    status: 'queued',
    queuedRecipients: 1,
    historyRecorded: true,
    acknowledged: false,
    ...overrides,
  } as MeshEnqueueReceipt;
}

describe.sequential('invocation completion notifications', () => {
  const testDbPath = resolve(env.ROOT, 'db/test-invocation-tracker.db');
  const sendMessage = vi
    .spyOn(cliMesh, 'sendMessageWithReceipt')
    .mockResolvedValue(receipt());

  /** 완료 상태의 invocation을 만들고 id를 돌려준다. */
  async function seedCompletedInvocation(taskId: string): Promise<string> {
    getDb().prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status)
      VALUES (?, 'task', ?, 'codex', 'completed')
    `).run(taskId, 'prompt');
    const invocationId = await invocationTracker.recordInvocation(
      'caller-session',
      'caller-agent',
      'codex',
      'prompt',
      'task',
      taskId,
    );
    invocationTracker.completeInvocation(invocationId, 'completed', 'done');
    return invocationId;
  }

  /** agent_invocations.notified 원시값 조회 (0=미전송, 1=전달됨, 2=클레임). */
  function notifiedFlag(invocationId: string): number {
    return (
      getDb()
        .prepare('SELECT notified FROM agent_invocations WHERE id = ?')
        .get(invocationId) as { notified: number }
    ).notified;
  }

  beforeAll(() => {
    closeDb();
    process.env.DATABASE_PATH = testDbPath;
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    sendMessage.mockRestore();
    closeDb();
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    delete process.env.DATABASE_PATH;
  });

  it('names the actual executor and identifies the requested provider on failover', async () => {
    const taskId = 'task-provider-failover-notification';
    getDb().prepare(`
      INSERT INTO tasks (id, mode, prompt, assigned_to, status, metadata_json)
      VALUES (?, 'task', ?, ?, 'completed', ?)
    `).run(taskId, 'prompt', 'ollama', JSON.stringify({ requestedProvider: 'codex' }));
    const invocationId = await invocationTracker.recordInvocation(
      'caller-session',
      'caller-agent',
      'codex',
      'prompt',
      'task',
      taskId,
    );
    invocationTracker.completeInvocation(invocationId, 'completed', 'done');

    await invocationTracker.notifyCompletion(invocationId);

    expect(sendMessage).toHaveBeenCalledWith(
      'nco-system',
      'nco',
      'caller-session',
      expect.stringContaining('[task] ollama 완료 (codex 요청→ollama 대행)'),
      'info',
    );
  });

  // 근거(T1, db/nco.db): 완료 알림은 invocation-tracker가 cliMesh로 보내는데,
  // collaboration-msg-loop 가드가 막으면 예외가 아니라 queuedRecipients=0 영수증이 돌아온다.
  // 종전 코드는 그대로 notified=1('전달됨')을 기록해 조용한 mesh 메시지 누락을 만들었다.
  describe('collaboration-msg-loop guard blocked notice', () => {
    it('leaves the invocation unnotified instead of marking it delivered', async () => {
      sendMessage.mockResolvedValueOnce(
        receipt({ status: 'not_queued', queuedRecipients: 0, historyRecorded: false, reason: 'collaboration_loop_blocked' }),
      );
      const invocationId = await seedCompletedInvocation('task-loop-blocked-notice');

      await invocationTracker.notifyCompletion(invocationId);

      expect(notifiedFlag(invocationId)).toBe(0);
    });

    it('reverts to the previous behaviour when the kill switch is off', async () => {
      process.env.NCO_MESH_NOTIFY_LOOPBLOCK_RETRY = 'off';
      try {
        sendMessage.mockResolvedValueOnce(
          receipt({ status: 'not_queued', queuedRecipients: 0, historyRecorded: false, reason: 'collaboration_loop_blocked' }),
        );
        const invocationId = await seedCompletedInvocation('task-loop-blocked-killswitch');

        await invocationTracker.notifyCompletion(invocationId);

        expect(notifiedFlag(invocationId)).toBe(1);
      } finally {
        delete process.env.NCO_MESH_NOTIFY_LOOPBLOCK_RETRY;
      }
    });

    // 과잉적용 방지: 가드 차단만 되돌린다. 세션이 붙어있지 않아 생기는 미전송은
    // 재시도해도 즉시 해소되지 않으므로 종전대로 notified=1을 유지한다.
    it('does not reopen notifications that failed for non-guard reasons', async () => {
      for (const [reason, taskId] of [
        ['mesh_unavailable', 'task-mesh-unavailable-notice'],
        ['recipient_unavailable', 'task-recipient-unavailable-notice'],
      ] as const) {
        sendMessage.mockResolvedValueOnce(
          receipt({ status: 'not_queued', queuedRecipients: 0, historyRecorded: false, reason }),
        );
        const invocationId = await seedCompletedInvocation(taskId);

        await invocationTracker.notifyCompletion(invocationId);

        expect(notifiedFlag(invocationId)).toBe(1);
      }
    });

    it('still marks a normally queued notice as delivered', async () => {
      const invocationId = await seedCompletedInvocation('task-queued-notice');

      await invocationTracker.notifyCompletion(invocationId);

      expect(notifiedFlag(invocationId)).toBe(1);
    });
  });
});
