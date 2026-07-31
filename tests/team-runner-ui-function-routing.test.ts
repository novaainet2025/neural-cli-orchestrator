import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..');
const runnerPath = resolve(projectRoot, 'scripts/team-runner.sh');
const runnerSource = readFileSync(runnerPath, 'utf8');

function extractShellFunction(name: string): string {
  const start = runnerSource.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`missing shell function: ${name}`);
  const end = runnerSource.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`unterminated shell function: ${name}`);
  return runnerSource.slice(start, end + 2);
}

function fallbackChain(
  teamId: string,
  teamSlug: string,
  toggle?: string,
): string {
  const harness = `
AI_CHAIN="ollama hermes openrouter"
${toggle === undefined
    ? 'unset NCO_UI_FUNCTION_DESIGN_CAPABILITY_FALLBACK'
    : `export NCO_UI_FUNCTION_DESIGN_CAPABILITY_FALLBACK="${toggle}"`}
${extractShellFunction('team_fallback_chain')}
team_fallback_chain "$1" "$2"
`;
  const result = spawnSync('bash', ['-c', harness, 'bash', teamId, teamSlug], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`team fallback harness failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

describe('team-runner ui-function-design routing', () => {
  it('uses only the UI-capable bounded fallback for the target team', () => {
    expect(fallbackChain('team_ui-function-design', 'ui-function-design')).toBe('agy');
    expect(fallbackChain('team_ui-function-design', 'other-slug')).toBe('agy');
    expect(fallbackChain('other-id', 'ui-function-design')).toBe('agy');
  });

  it('preserves the generic chain for other teams', () => {
    expect(fallbackChain('team_other', 'other')).toBe('ollama hermes openrouter');
  });

  it('can restore the previous target-team chain without a rebuild', () => {
    expect(fallbackChain('team_ui-function-design', 'ui-function-design', 'off'))
      .toBe('ollama hermes openrouter');
  });

  it('wires the bounded fallback into the dispatch chain', () => {
    expect(runnerSource).toContain(
      'TEAM_FALLBACKS=$(team_fallback_chain "${TEAM_ID}" "${TEAM_SLUG}")',
    );
    expect(runnerSource).toContain('CHAIN="${TEAM_EXECUTORS} ${TEAM_FALLBACKS}"');
  });
});
