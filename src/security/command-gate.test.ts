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

describe('CommandGate process-manager isolation', () => {
  const gate = new CommandGate({
    allowedCommands: [],
    deniedCommands: [],
  });

  it.each([
    ['pm2', ['restart', 'nco-backend']],
    ['/opt/homebrew/bin/pm2', ['startOrReload', 'ecosystem.config.cjs']],
    ['npx', ['pm2', 'stop', 'nco-backend']],
    ['npm', ['run', 'pm2:stop']],
    ['npm', ['exec', 'pm2', '--', 'restart', 'nco-backend']],
    ['pm2', ['--silent', 'restart', 'nco-backend']],
    ['pm2', ['sendSignal', 'SIGINT', 'nco-backend']],
    ['bash', ['-lc', 'pm2 restart nco-backend']],
  ])('blocks PM2 mutations through %s', (command, args) => {
    const result = gate.validate(command, args);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('dangerous pattern');
  });

  it('still allows read-only PM2 inspection', () => {
    expect(gate.validate('pm2', ['jlist'])).toEqual({ ok: true });
    expect(gate.validate('/opt/homebrew/bin/pm2', ['describe', 'nco-backend'])).toEqual({ ok: true });
  });

  it.each([
    ['kill', ['-INT', '1234']],
    ['/usr/bin/pkill', ['-f', 'nco-backend']],
    ['bash', ['-lc', 'echo ready; kill -TERM 1234']],
  ])('blocks direct process signals through %s', (command, args) => {
    const result = gate.validate(command, args);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('dangerous process signal');
  });

  it('does not confuse signal-related search text with a process signal', () => {
    expect(gate.validate('rg', ['kill', 'src'])).toEqual({ ok: true });
  });
});
