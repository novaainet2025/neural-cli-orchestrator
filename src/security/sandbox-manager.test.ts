import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSandbox,
  isLocalInferenceEndpoint,
  isSystemTemporaryProject,
  resolveAgentTempRoots,
} from './sandbox-manager.js';

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(root = tmpdir(), prefix = 'nco-sandbox-'): string {
  const directory = mkdtempSync(join(root, prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SandboxManager project path policy', () => {
  it.each(['Engineer', 'Commander'])('%s allows its system-temp project but not a sibling', role => {
    const projectDir = makeTemporaryDirectory();
    const siblingDir = `${projectDir}-sibling`;
    const sandbox = createSandbox(`test-${role}`, role, projectDir);

    expect(sandbox.pathGuard.validate(join(projectDir, 'src', 'index.ts')).ok).toBe(true);
    expect(sandbox.pathGuard.validate(join(siblingDir, 'secret.txt')).ok).toBe(false);
  });

  it.each(['Engineer', 'Commander'])('%s blocks a symlink escape from its temp project', role => {
    const projectDir = makeTemporaryDirectory();
    const outsideDir = makeTemporaryDirectory();
    const alias = join(projectDir, 'outside-alias');
    symlinkSync(outsideDir, alias, 'dir');
    const sandbox = createSandbox(`test-${role}`, role, projectDir);

    expect(sandbox.pathGuard.validate(join(alias, 'secret.txt')).ok).toBe(false);
  });

  it.each(['Engineer', 'Commander'])('%s blocks node_modules through the canonical macOS /private path', role => {
    const projectDir = makeTemporaryDirectory();
    mkdirSync(join(projectDir, 'node_modules'));
    const canonicalProjectDir = realpathSync(projectDir);
    const sandbox = createSandbox(`test-${role}`, role, projectDir);

    const result = sandbox.pathGuard.validate(join(canonicalProjectDir, 'node_modules', 'package', 'index.js'));

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('node_modules');
  });

  it.each(['Engineer', 'Commander'])('%s keeps non-temporary /var projects denied', role => {
    const sandbox = createSandbox(`test-${role}`, role, '/var/lib/nco-sandbox-non-temp');

    expect(sandbox.pathGuard.validate('/var/lib/nco-sandbox-non-temp/file.txt').ok).toBe(false);
  });

  it('retains the Commander /Users allowance without granting it to an Engineer', () => {
    const projectDir = makeTemporaryDirectory();
    const commander = createSandbox('commander', 'Commander', projectDir);
    const engineer = createSandbox('engineer', 'Engineer', projectDir);
    const outsideProject = '/Users/nco-sandbox-audit/file.txt';

    expect(commander.pathGuard.validate(outsideProject).ok).toBe(true);
    expect(engineer.pathGuard.validate(outsideProject).ok).toBe(false);
  });
});

describe('isSystemTemporaryProject', () => {
  it('recognizes both logical and canonical forms of the host temp path', () => {
    const projectDir = makeTemporaryDirectory();

    expect(isSystemTemporaryProject(projectDir)).toBe(true);
    expect(isSystemTemporaryProject(realpathSync(projectDir))).toBe(true);
  });

  it('uses root-boundary matching instead of accepting a sibling prefix', () => {
    const root = makeTemporaryDirectory();
    const child = makeTemporaryDirectory(root, 'child-');
    const sibling = makeTemporaryDirectory(tmpdir(), `${root.split('/').pop()}-sibling-`);

    expect(isSystemTemporaryProject(child, root)).toBe(true);
    expect(isSystemTemporaryProject(sibling, root)).toBe(false);
  });

  it('models Linux tmpdir=/tmp without treating /var as temporary', () => {
    const linuxProject = makeTemporaryDirectory('/tmp', 'nco-linux-tmp-');

    expect(isSystemTemporaryProject(linuxProject, '/tmp', 'linux')).toBe(true);
    expect(isSystemTemporaryProject('/var/lib/nco-linux-non-temp', '/tmp', 'linux')).toBe(false);
  });

  it('recognizes only the narrow canonical macOS temp root when TMPDIR is sanitized', () => {
    const macProject = '/private/var/folders/aa/example-hash/T/nco-isolated/workspace';

    expect(isSystemTemporaryProject(macProject, '/tmp', 'darwin')).toBe(true);
    expect(isSystemTemporaryProject(macProject, '/tmp', 'linux')).toBe(false);
    expect(isSystemTemporaryProject('/private/var/lib/nco-isolated', '/tmp', 'darwin')).toBe(false);
  });
});

describe('local inference resource policy', () => {
  it('detects loopback, private-network, and local DNS endpoints', () => {
    expect(isLocalInferenceEndpoint('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isLocalInferenceEndpoint('http://192.168.1.20:11434/v1')).toBe(true);
    expect(isLocalInferenceEndpoint('http://model-host.local:11434/v1')).toBe(true);
    expect(isLocalInferenceEndpoint('https://api.openai.com/v1')).toBe(false);
  });

  it('automatically grants a dynamically named local provider the local LLM timeouts', () => {
    const projectDir = makeTemporaryDirectory();
    const local = createSandbox('ollama-review', 'Reviewer', projectDir, {
      endpoint: 'http://127.0.0.1:11434/v1',
    });
    const remote = createSandbox('remote-review', 'Reviewer', projectDir, {
      endpoint: 'https://example.com/v1',
    });

    expect(local.getTimeout()).toBe(360_000);
    expect(local.getApiTimeout()).toBe(300_000);
    expect(remote.getTimeout()).toBe(120_000);
    expect(remote.getApiTimeout()).toBe(90_000);
  });
});

describe('공유 임시 디렉터리 경계 (Z)', () => {
  // kangnote 실측(2026-08-07, WSL2): `allowedPaths` 에 `/tmp` 가 통째로 들어가 있어
  // Engineer 샌드박스가 **남의 작업공간 `/tmp/other-agent-workspace/secret.txt` 까지
  // ok=true** 였다. macOS 는 os.tmpdir() 이 사용자별(/var/folders/<hash>/T)이라 안 드러난다.
  const LINUX_TMP = '/tmp';

  it('공유 루트 자체를 열지 않는다 — 리눅스에서 전 에이전트가 서로를 본다', () => {
    const roots = resolveAgentTempRoots('codex', LINUX_TMP, undefined);
    expect(roots).not.toContain('/tmp');
    expect(roots.every(r => r !== '/tmp')).toBe(true);
  });

  it('자기 몫 하위 경로만 연다', () => {
    const roots = resolveAgentTempRoots('codex', LINUX_TMP, undefined);
    expect(roots.some(r => r.endsWith('/nco-codex'))).toBe(true);
  });

  it('**다른 에이전트의 경로는 포함되지 않는다**', () => {
    const mine = resolveAgentTempRoots('codex', LINUX_TMP, undefined);
    const theirs = resolveAgentTempRoots('agy', LINUX_TMP, undefined);
    expect(mine.some(r => theirs.includes(r))).toBe(false);
  });

  it('에이전트 id 의 경로 문자를 무해화한다 — 상위 탈출 금지', () => {
    // macOS 는 /tmp 가 /private/tmp 로 정규화되므로 접두사를 단정하지 않고
    // **탈출 문자가 남지 않는지**만 본다.
    const roots = resolveAgentTempRoots('../../etc', LINUX_TMP, undefined);
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) {
      expect(root).not.toContain('..');
      expect(root).not.toContain('/etc');
      expect(root.endsWith('/nco-______etc')).toBe(true);
    }
  });

  it('토글로 예전 동작을 되살릴 수 있다 — 재빌드 없이', () => {
    expect(resolveAgentTempRoots('codex', LINUX_TMP, '1')).toContain('/tmp');
  });

  it('**실제 샌드박스가 남의 임시 작업공간을 거부한다** — 이것이 목적이다', () => {
    // kangnote 가 관측한 그 경로 형태를 그대로 넣는다.
    const sandbox = createSandbox('codex', 'Engineer', process.cwd());
    const systemTemp = resolveAgentTempRoots('codex', tmpdir(), undefined)[0]
      .replace(/\/nco-codex$/, '');
    expect(sandbox.pathGuard.validate(`${systemTemp}/other-agent-workspace/secret.txt`).ok)
      .toBe(false);
  });

  it('자기 임시 경로는 여전히 허용한다 — 스크래치가 막히면 안 된다', () => {
    const sandbox = createSandbox('codex', 'Engineer', process.cwd());
    const mine = resolveAgentTempRoots('codex', tmpdir(), undefined)[0];
    expect(sandbox.pathGuard.validate(`${mine}/scratch.txt`).ok).toBe(true);
  });
});
