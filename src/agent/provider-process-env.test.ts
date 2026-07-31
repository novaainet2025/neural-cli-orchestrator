import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProviderProcessEnv } from './provider-process-env.js';

describe('buildProviderProcessEnv', () => {
  it('disables FORCE_COLOR for non-interactive provider subprocesses', () => {
    const env = buildProviderProcessEnv(
      'opencode',
      undefined,
      {
        PATH: '/usr/bin',
        FORCE_COLOR: '3',
      },
      '/srv/nco',
    );

    expect(env.FORCE_COLOR).toBe('0');
    expect(env.NO_COLOR).toBe('1');
    expect(env.TERM).toBe('dumb');
  });

  it('preserves the previous color environment when sanitization is disabled', () => {
    const env = buildProviderProcessEnv(
      'opencode',
      undefined,
      {
        PATH: '/usr/bin',
        FORCE_COLOR: '3',
        NCO_PROVIDER_COLOR_SANITIZE: 'off',
      },
      '/srv/nco',
    );

    expect(env.FORCE_COLOR).toBe('3');
    expect(env.NO_COLOR).toBeUndefined();
    expect(env.TERM).toBeUndefined();
  });

  it('prepends the user-local bin fallback for cursor-agent', () => {
    const env = buildProviderProcessEnv(
      'cursor-agent',
      { CURSOR_SETTING: 'enabled' },
      { PATH: ['/usr/bin', '/bin'].join(delimiter) },
      '/srv/nco',
    );

    expect(env.PATH).toBe(['/srv/nco/.local/bin', '/usr/bin', '/bin'].join(delimiter));
    expect(env.CURSOR_SETTING).toBe('enabled');
  });

  it('does not alter PATH for another provider', () => {
    const env = buildProviderProcessEnv(
      'codex',
      undefined,
      { PATH: ['/usr/bin', '/bin'].join(delimiter) },
      '/srv/nco',
    );

    expect(env.PATH).toBe(['/usr/bin', '/bin'].join(delimiter));
  });

  it('preserves the original PATH when the fallback toggle is off', () => {
    const env = buildProviderProcessEnv(
      'cursor-agent',
      undefined,
      {
        PATH: ['/usr/bin', '/bin'].join(delimiter),
        NCO_CURSOR_AGENT_PATH_FALLBACK: 'off',
      },
      '/srv/nco',
    );

    expect(env.PATH).toBe(['/usr/bin', '/bin'].join(delimiter));
  });

  it('uses the configured cursor-agent bin directory without duplicating it', () => {
    const configured = '/opt/cursor/bin';
    const env = buildProviderProcessEnv(
      'cursor-agent',
      undefined,
      {
        PATH: [configured, '/usr/bin'].join(delimiter),
        NCO_CURSOR_AGENT_BIN_DIR: configured,
      },
      '/srv/nco',
    );

    expect(env.PATH).toBe([configured, '/usr/bin'].join(delimiter));
  });
});
