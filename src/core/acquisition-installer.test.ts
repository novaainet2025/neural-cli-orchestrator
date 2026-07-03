import { describe, expect, it } from 'vitest';
import { buildInstallCommand } from './acquisition-installer.js';

describe('buildInstallCommand', () => {
  it('builds npm install command with ignore-scripts and prefix', () => {
    const command = buildInstallCommand('/tmp/acq/pkg', {
      packageName: 'left-pad',
      version: '1.3.0',
    });

    expect(command).toEqual({
      command: 'npm',
      args: [
        'install',
        '--ignore-scripts',
        '--no-save',
        '--prefix',
        '/tmp/acq/pkg',
        'left-pad@1.3.0',
      ],
    });
  });
});
