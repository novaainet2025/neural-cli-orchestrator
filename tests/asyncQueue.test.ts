import { AsyncQueue } from '../src/utils/asyncQueue';

describe('AsyncQueue', () => {
  it('processes tasks with concurrency limit', async () => {
    const results: number[] = [];
    const queue = new AsyncQueue(2);
    const createTask = (i: number, delay: number) => async () => {
      await new Promise((r) => setTimeout(r, delay));
      results.push(i);
      return i;
    };

    const tasks = [
      queue.add(createTask(1, 30)),
      queue.add(createTask(2, 20)),
      queue.add(createTask(3, 10)),
    ];
    await Promise.all(tasks);
    // With concurrency 2, tasks 1 and 2 start first, 3 waits.
    // Expected order: 2 finishes before 1, then 3, then 1.
    expect(results).toEqual([2, 1, 3]);
  });
});
