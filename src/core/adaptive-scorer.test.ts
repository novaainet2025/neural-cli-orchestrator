import { describe, expect, it } from 'vitest';
import { computeOperationalReliabilityWeight } from './adaptive-scorer.js';

describe('computeOperationalReliabilityWeight', () => {
  it('rewards reliable low-latency providers', () => {
    const fastReliable = computeOperationalReliabilityWeight(0.96, 70_000);
    const slowLessReliable = computeOperationalReliabilityWeight(0.86, 130_000);
    expect(fastReliable).toBeGreaterThan(slowLessReliable);
  });

  it('bounds malformed telemetry safely', () => {
    expect(computeOperationalReliabilityWeight(4, 1)).toBeLessThanOrEqual(2);
    expect(computeOperationalReliabilityWeight(-3, 0)).toBeGreaterThanOrEqual(0.2);
  });
});
