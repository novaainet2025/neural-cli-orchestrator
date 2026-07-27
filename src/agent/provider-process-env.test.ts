import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProviderProcessEnv } from './provider-process-env.js';

describe('buildProviderProcessEnv', () => {
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
