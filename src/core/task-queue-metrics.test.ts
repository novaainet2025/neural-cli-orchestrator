import { describe, expect, it, vi } from 'vitest';
import {
  listBullQueueWaitingJobs,
  readBullQueueLiveCounts,
} from './task-queue.js';

describe('BullMQ queue visibility', () => {
  it('counts prioritized jobs as waiting work', async () => {
    const queue = {
      getWaitingCount: vi.fn().mockResolvedValue(3),
      getPrioritizedCount: vi.fn().mockResolvedValue(7),
      getActiveCount: vi.fn().mockResolvedValue(2),
    } as unknown as Parameters<typeof readBullQueueLiveCounts>[0];

    await expect(readBullQueueLiveCounts(queue)).resolves.toEqual({
      waiting: 10,
      active: 2,
    });
  });

  it('includes prioritized jobs in priority-aging candidates', async () => {
    const ordinary = { id: 'ordinary', timestamp: 1 };
    const prioritized = { id: 'prioritized', timestamp: 2 };
    const queue = {
      getWaiting: vi.fn().mockResolvedValue([ordinary]),
      getPrioritized: vi.fn().mockResolvedValue([prioritized]),
    } as unknown as Parameters<typeof listBullQueueWaitingJobs>[0];

    await expect(listBullQueueWaitingJobs(queue)).resolves.toEqual([
      ordinary,
      prioritized,
    ]);
  });
});
