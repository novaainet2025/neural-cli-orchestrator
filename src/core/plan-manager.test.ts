import { describe, expect, it } from 'vitest';
import { parsePlanTaskLabel } from './plan-manager.js';

describe('parsePlanTaskLabel', () => {
  it('parses parallel execution and provider assignment for create/sync parity', () => {
    expect(parsePlanTaskLabel('P12a: Investigate the failure (claude-code)')).toEqual({
      title: 'Investigate the failure',
      assignedTo: 'claude-code',
      executionType: 'parallel',
    });
  });

  it('keeps unprefixed and explicit sequential labels sequential', () => {
    expect(parsePlanTaskLabel('Implement the fix')).toEqual({
      title: 'Implement the fix',
      assignedTo: null,
      executionType: 'sequential',
    });
    expect(parsePlanTaskLabel('s2: Verify the fix (codex)')).toEqual({
      title: 'Verify the fix',
      assignedTo: 'codex',
      executionType: 'sequential',
    });
  });
});
