/**
 * Parallel task execution utility.
 * Provides a typed helper to run an array of async tasks concurrently.
 */

export async function runParallel<T>(
  tasks: Array<() => Promise<T>>,
): Promise<Array<PromiseSettledResult<T>>> {
  return Promise.allSettled(tasks.map(fn => fn()));
}
