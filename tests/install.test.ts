import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const setupPath = join(root, 'setup.sh');
const bootstrapPath = join(root, 'bootstrap.sh');
const fixtures: string[] = [];

afterEach(() => {
  while (fixtures.length > 0) {
    rmSync(fixtures.pop()!, { recursive: true, force: true });
  }
});

function fixture(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  fixtures.push(path);
  return path;
}

function executable(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

describe('NCO one-click install', () => {
  test('scripts have valid Bash syntax and setup documents deployment controls', () => {
    execFileSync('/bin/bash', ['-n', setupPath]);
    execFileSync('/bin/bash', ['-n', bootstrapPath]);

    const help = execFileSync('/bin/bash', [setupPath, '--help'], { encoding: 'utf8' });
    const setup = readFileSync(setupPath, 'utf8');
    expect(help).toContain('--no-interactive');
    expect(help).toContain('--skip-pm2');
    expect(setup).not.toContain('wc -l || echo 0');
    expect(setup).not.toContain('$HOME/projects/neural-cli-orchestrator');
  });

  test('lockfile is reproducible without the unused mem0ai SDK', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

    expect(pkg.dependencies.mem0ai).toBeUndefined();
    expect(lock.packages['node_modules/mem0ai']).toBeUndefined();
    expect(lock.packages['']?.dependencies?.mem0ai).toBeUndefined();
  });

  test('fresh bootstrap clone forwards a non-interactive deployment', () => {
    const fixtureDir = fixture('nco-bootstrap-');
    const fakeBin = join(fixtureDir, 'bin');
    const installDir = join(fixtureDir, 'nco');
    const setupLog = join(fixtureDir, 'setup.log');
    mkdirSync(fakeBin);

    executable(join(fakeBin, 'git'), `#!/bin/bash
set -eu
if [[ "\${1:-}" == "clone" ]]; then
  target="\${!#}"
  mkdir -p "$target/.git"
  printf '#!/usr/bin/env bash\\n' > "$target/setup.sh"
  exit 0
fi
exit 90
`);
    executable(join(fakeBin, 'bash'), `#!/bin/sh
printf '%s\\n' "$@" > "$NCO_TEST_LOG"
`);

    execFileSync('/bin/bash', [bootstrapPath], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        NCO_INSTALL_DIR: installDir,
        NCO_REPO_URL: 'https://example.test/nco.git',
        NCO_TEST_LOG: setupLog,
      },
    });

    expect(readFileSync(setupLog, 'utf8').trim().split('\n')).toEqual([
      join(installDir, 'setup.sh'),
      '--no-interactive',
      '--skip-ollama',
      '--skip-agents',
    ]);
  });

  test('dirty checkout is preserved and redeployed without fetch or merge', () => {
    const fixtureDir = fixture('nco-redeploy-');
    const fakeBin = join(fixtureDir, 'bin');
    const installDir = join(fixtureDir, 'nco');
    const setupLog = join(fixtureDir, 'setup.log');
    const gitLog = join(fixtureDir, 'git.log');
    mkdirSync(fakeBin);
    mkdirSync(join(installDir, '.git'), { recursive: true });
    writeFileSync(join(installDir, 'setup.sh'), '#!/usr/bin/env bash\n', 'utf8');

    executable(join(fakeBin, 'git'), `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$NCO_GIT_LOG"
case "$*" in
  *"remote get-url origin"*) printf '%s\\n' "$NCO_REPO_URL" ;;
  *"branch --show-current"*) printf '%s\\n' "main" ;;
  *"status --porcelain"*) printf '%s\\n' " M local-change.txt" ;;
  *"fetch"*|*"merge"*) exit 91 ;;
esac
`);
    executable(join(fakeBin, 'bash'), `#!/bin/sh
printf '%s\\n' "$@" > "$NCO_TEST_LOG"
`);

    const output = execFileSync('/bin/bash', [bootstrapPath], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        NCO_INSTALL_DIR: installDir,
        NCO_REPO_URL: 'https://example.test/nco.git',
        NCO_TEST_LOG: setupLog,
        NCO_GIT_LOG: gitLog,
      },
      encoding: 'utf8',
    });

    expect(output).toContain('로컬 변경을 보존');
    expect(readFileSync(gitLog, 'utf8')).not.toMatch(/\b(fetch|merge)\b/);
    expect(readFileSync(setupLog, 'utf8')).toContain('--no-interactive');
  });

  test('clean checkout updates only by fast-forward before redeploying', () => {
    const fixtureDir = fixture('nco-update-');
    const fakeBin = join(fixtureDir, 'bin');
    const installDir = join(fixtureDir, 'nco');
    const setupLog = join(fixtureDir, 'setup.log');
    const gitLog = join(fixtureDir, 'git.log');
    mkdirSync(fakeBin);
    mkdirSync(join(installDir, '.git'), { recursive: true });
    writeFileSync(join(installDir, 'setup.sh'), '#!/usr/bin/env bash\n', 'utf8');

    executable(join(fakeBin, 'git'), `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$NCO_GIT_LOG"
case "$*" in
  *"remote get-url origin"*) printf '%s\\n' "$NCO_REPO_URL" ;;
  *"branch --show-current"*) printf '%s\\n' "main" ;;
  *"status --porcelain"*) ;;
  *"fetch origin main"*) ;;
  *"merge-base --is-ancestor HEAD FETCH_HEAD"*) ;;
  *"merge --ff-only FETCH_HEAD"*) ;;
  *) exit 92 ;;
esac
`);
    executable(join(fakeBin, 'bash'), `#!/bin/sh
printf '%s\\n' "$@" > "$NCO_TEST_LOG"
`);

    execFileSync('/bin/bash', [bootstrapPath], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        NCO_INSTALL_DIR: installDir,
        NCO_REPO_URL: 'https://example.test/nco.git',
        NCO_TEST_LOG: setupLog,
        NCO_GIT_LOG: gitLog,
      },
    });

    const calls = readFileSync(gitLog, 'utf8');
    expect(calls).toContain('fetch origin main');
    expect(calls).toContain('merge-base --is-ancestor HEAD FETCH_HEAD');
    expect(calls).toContain('merge --ff-only FETCH_HEAD');
    expect(readFileSync(setupLog, 'utf8')).toContain('--no-interactive');
  });
});
