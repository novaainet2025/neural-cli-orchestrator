import { describe, expect, it } from 'vitest';
import { isAutomaticProviderFailoverAllowed } from './task-failover-policy.js';

describe('isAutomaticProviderFailoverAllowed', () => {
  it('preserves default-on behavior for legacy or malformed metadata', () => {
    expect(isAutomaticProviderFailoverAllowed(null)).toBe(true);
    expect(isAutomaticProviderFailoverAllowed('{}')).toBe(true);
    expect(isAutomaticProviderFailoverAllowed('{broken')).toBe(true);
  });

  it('honors only an explicit boolean false opt-out', () => {
    expect(isAutomaticProviderFailoverAllowed('{"allowProviderFailover":false}')).toBe(false);
    expect(isAutomaticProviderFailoverAllowed('{"allowProviderFailover":true}')).toBe(true);
    expect(isAutomaticProviderFailoverAllowed('{"allowProviderFailover":"false"}')).toBe(true);
  });
});
