import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordProcessLifecycle } from './process-lifecycle-audit.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('recordProcessLifecycle', () => {
  it('appends parseable lifecycle evidence without throwing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nco-lifecycle-'));
    tempDirs.push(directory);
    const path = join(directory, 'nested', 'lifecycle.ndjson');

    recordProcessLifecycle('signal', { signal: 'SIGINT' }, path);
    recordProcessLifecycle('exit', { code: 0 }, path);

    const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toEqual([
      expect.objectContaining({ event: 'signal', signal: 'SIGINT', pid: process.pid }),
      expect.objectContaining({ event: 'exit', code: 0, pid: process.pid }),
    ]);
  });
});
