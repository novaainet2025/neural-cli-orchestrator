import { describe, expect, it } from 'vitest';
import { AsyncQueue } from './asyncQueue.js';

describe('AsyncQueue', () => {
  it('preserves task results while enforcing the concurrency limit', async () => {
    const queue = new AsyncQueue(1);
    let activeCount = 0;
    let maxActiveCount = 0;
    let secondStarted = false;
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.add(async () => {
      activeCount++;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      await firstGate;
      activeCount--;
      return 'first';
    });
    const second = queue.add(async () => {
      secondStarted = true;
      activeCount++;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      activeCount--;
      return 2;
    });

    await Promise.resolve();
    expect(secondStarted).toBe(false);
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 2]);
    expect(maxActiveCount).toBe(1);
  });
});
