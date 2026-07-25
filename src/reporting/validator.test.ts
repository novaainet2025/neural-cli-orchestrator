import { validateT1 } from './validator';

describe('T1 Validation', () => {
  test('succeeds when task is verified with logs', () => {
    const mockTask = {
      status: 'verified',
      logs: [{ timestamp: Date.now(), message: 'T1 passed' }]
    };
    expect(validateT1('task123')).toBe(true);
  });

  test('fails when task status is not verified', () => {
    const mockTask = {
      status: 'failed',
      logs: []
    };
    expect(validateT1('task456')).toBe(false);
  });

  test('fails when logs array is empty', () => {
    const mockTask = {
      status: 'verified',
      logs: []
    };
    expect(validateT1('task789')).toBe(false);
  });
});