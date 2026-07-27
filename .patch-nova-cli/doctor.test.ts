import { describe, expect, it, vi } from 'vitest';
import { doctorHasFailure, runCommandDefinitionChecks, runDoctorChecks } from './doctor.js';

describe('command definition doctor', () => {
  it('audits registered handlers and the agent tool catalog without executing side effects', () => {
    const handler = vi.fn();
    const checks = runCommandDefinitionChecks(
      [{ name: '/healthy', usage: '/healthy', help: 'healthy command', handler }],
      ['read_file', 'bash']
    );

    expect(handler).not.toHaveBeenCalled();
    expect(checks.find((check) => check.name === 'command registry')?.status).toBe('ok');
    expect(checks.find((check) => check.name === 'command handlers')?.status).toBe('ok');
    expect(checks.find((check) => check.name === 'command schemas')?.status).toBe('ok');
    expect(checks.find((check) => check.name === 'agent tools')?.detail).toContain('2개');
    expect(doctorHasFailure(checks)).toBe(false);
  });

  it('fails duplicate names, invalid names, and missing handlers', () => {
    const checks = runCommandDefinitionChecks([
      { name: '/duplicate', usage: '/duplicate', help: 'first', handler: vi.fn() },
      { name: '/duplicate', usage: '/duplicate', help: 'second', handler: undefined },
      { name: 'invalid', usage: '', help: '', handler: vi.fn() }
    ]);

    expect(checks.find((check) => check.name === 'command registry')?.status).toBe('fail');
    expect(checks.find((check) => check.name === 'command handlers')?.status).toBe('fail');
    expect(checks.find((check) => check.name === 'command metadata')?.status).toBe('warn');
    expect(checks.find((check) => check.name === 'command schemas')?.status).toBe('fail');
    expect(doctorHasFailure(checks)).toBe(true);
  });
});

describe('runtime doctor', () => {
  it('probes Nova-AX at /api/health', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: url.includes('/api/health') || url.endsWith('/health') || url.includes('/api/tags') || url.includes('/v1/models'),
      status: 200
    }));
    vi.stubGlobal('fetch', fetchMock);

    await runDoctorChecks();

    const axProbe = fetchMock.mock.calls.find(([url]) => String(url).includes('6300'));
    expect(axProbe?.[0]).toMatch(/\/api\/health$/);

    vi.unstubAllGlobals();
  });
});
