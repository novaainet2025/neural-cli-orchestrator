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

function pollExitCode(status: string): number {
  const directory = mkdtempSync(resolve(tmpdir(), 'nco-team-runner-policy-'));
  temporaryDirectories.push(directory);
  const fixturePath = resolve(directory, 'fixture.json');
  writeFileSync(fixturePath, JSON.stringify({
    task: {
      status,
      response: '',
    },
  }));

  const harness = `
TMP_DIR="$1"
FIXTURE="$2"
API_BASE="http://unused.invalid/api"
MAX_POLLS=2
POLL_INTERVAL=0
POLL_HTTP_TIMEOUT=1
curl() {
  local output=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then
      output="$2"
      shift 2
      continue
    fi
    shift
  done
  cp "$FIXTURE" "$output"
}
sleep() { :; }
${extractShellFunction('poll_done')}
poll_done "task_fixture" "team_fixture" "fixture"
rc=$?
printf '%s' "$rc"
`;
  const result = spawnSync('bash', ['-c', harness, 'bash', directory, fixturePath], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`poll harness failed: ${result.stderr}`);
  }
  return Number(result.stdout);
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('team-runner polling policy', () => {
  it('distinguishes a terminal failure from an observation-budget expiry', () => {
    expect(pollExitCode('failed')).toBe(1);
    expect(pollExitCode('assigned')).toBe(2);
    expect(pollExitCode('running')).toBe(2);
  });

  it('stops both dispatch loops when an existing task remains active', () => {
    expect(runnerSource).toContain('if [ "${poll_rc}" -eq 2 ]; then');
    expect(runnerSource).toContain('중복 fallback 없이 러너 중단');
    expect(runnerSource).toContain('break 2');
  });
});
