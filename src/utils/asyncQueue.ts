// Async task queue with concurrency limit
// Allows adding async functions (tasks) that will be executed respecting the max concurrency.

export class AsyncQueue {
  private readonly maxConcurrency: number;
  private activeCount = 0;
  private readonly queue: Array<() => Promise<any>> = [];

  constructor(maxConcurrency: number) {
    if (maxConcurrency < 1) {
      throw new Error('maxConcurrency must be at least 1');
    }
    this.maxConcurrency = maxConcurrency;
  }

  // Add a task returning a promise. Returns a promise that resolves/rejects with the task result.
  add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        this.activeCount++;
        try {
          const result = await task();
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          this.activeCount--;
          this.next();
        }
      };
      if (this.activeCount < this.maxConcurrency) {
        run();
      } else {
        this.queue.push(run);
      }
    });
  }

  private next() {
    if (this.queue.length === 0) return;
    if (this.activeCount >= this.maxConcurrency) return;
    const nextTask = this.queue.shift();
    if (nextTask) nextTask();
  }
}
