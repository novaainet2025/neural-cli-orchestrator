import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..');
const runnerPath = resolve(projectRoot, 'scripts/team-runner.sh');
const runnerSource = readFileSync(runnerPath, 'utf8');
const temporaryDirectories: string[] = [];

function extractShellFunction(name: string): string {
  const start = runnerSource.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`missing shell function: ${name}`);
  const end = runnerSource.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`unterminated shell function: ${name}`);
  return runnerSource.slice(start, end + 2);
}

function executorChain(): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'nco-team-affinity-'));
  temporaryDirectories.push(directory);
  const fixturePath = resolve(directory, 'runnable.json');
  writeFileSync(fixturePath, JSON.stringify([
    {
      id: 'team_fixture',
      lead: 'codex',
      members: [
        { type: 'provider', ref: 'codex' },
        { type: 'provider', ref: 'opencode' },
        { type: 'session', ref: 'session-ignored' },
        { type: 'provider', ref: 'hermes' },
      ],
    },
  ]));

  const harness = `
${extractShellFunction('team_executor_chain')}
team_executor_chain "$1" "team_fixture"
`;
  const result = spawnSync('bash', ['-c', harness, 'bash', fixturePath], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`team affinity harness failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('team-runner team-affinity dispatch', () => {
  it('orders the lead and provider members before the selected fallback chain without duplicates', () => {
    expect(executorChain()).toBe('codex opencode hermes');
    expect(runnerSource).toContain('CHAIN="${TEAM_EXECUTORS} ${TEAM_FALLBACKS}"');
  });

  it('binds a task to its team at creation and disables generic in-task failover', () => {
    expect(runnerSource).toContain('"teamId": team_id');
    expect(runnerSource).toContain('"allowProviderFailover": False');
  });
});
