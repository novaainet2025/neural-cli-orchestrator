import { describe, expect, it } from 'vitest';
import { CommandGate } from './command-gate.js';

describe('CommandGate trusted executables', () => {
  const gate = new CommandGate({
    allowedCommands: ['npm', 'npx', 'vitest'],
    deniedCommands: [],
  });

  it('allows system-installed npm package runners', () => {
    expect(gate.validate('npm')).toEqual({ ok: true });
    expect(gate.validate('npx')).toEqual({ ok: true });
  });

  it('does not trust a project-local binary directory', () => {
    const result = gate.validate('vitest');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Command path not trusted:');
  });
});
