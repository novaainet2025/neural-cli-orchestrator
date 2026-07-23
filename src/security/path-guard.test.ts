import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { PathGuard } from './path-guard.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('PathGuard symlink deny handling', () => {
  it('denies a logical alias whose real path matches **/.env', () => {
    const temp = mkdtempSync(join(tmpdir(), 'nco-path-guard-'));
    tempDirs.push(temp);
    const allowed = join(temp, 'allowed');
    mkdirSync(allowed);
    writeFileSync(join(allowed, '.env'), 'SECRET=test');
    const alias = join(allowed, 'safe-name');
    symlinkSync('.env', alias);

    const result = new PathGuard({ allowedPaths: [allowed], deniedPaths: [] }).validate(alias);

    expect(result).toEqual({ ok: false, reason: 'Path denied by pattern: **/.env' });
  });
});
