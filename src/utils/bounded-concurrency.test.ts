import { describe, expect, it } from 'vitest';
import { runWithConcurrency } from './bounded-concurrency.js';

describe('runWithConcurrency', () => {
  it('never exceeds the requested concurrency', async () => {
    let active = 0;
    let peak = 0;
    const visited: number[] = [];

    const processed = await runWithConcurrency([0, 1, 2, 3, 4, 5], 2, async item => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      visited.push(item);
      active -= 1;
    });

    expect(processed).toBe(6);
    expect(peak).toBe(2);
    expect(visited.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('stops claiming new work when the continuation gate closes', async () => {
    let keepRunning = true;
    const visited: number[] = [];

    const processed = await runWithConcurrency([0, 1, 2, 3], 1, async item => {
      visited.push(item);
      keepRunning = false;
    }, () => keepRunning);

    expect(processed).toBe(1);
    expect(visited).toEqual([0]);
  });
});
