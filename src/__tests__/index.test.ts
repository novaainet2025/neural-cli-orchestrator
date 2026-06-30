import { describe, expect, it } from 'vitest';
import { env } from '../utils/config.js';

describe('Environment Config', () => {
  it('should have a defined PORT', () => {
    expect(typeof env.PORT).toBe('number');
    expect(Number.isFinite(env.PORT)).toBe(true);
  });
});
