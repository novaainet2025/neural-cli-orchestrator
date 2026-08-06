import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CommandGate } from './command-gate.js';

describe('CommandGate trusted executables', () => {
  const gate = new CommandGate({
    allowedCommands: ['node', 'npm', 'npx', 'vitest'],
    deniedCommands: [],
  });

  it('allows the installed Node.js runtime', () => {
    expect(gate.validate('node')).toEqual({ ok: true });
  });

  it('allows system-installed npm package runners', () => {
    expect(gate.validate('npm')).toEqual({ ok: true });
    expect(gate.validate('npx')).toEqual({ ok: true });
  });

  it('does not trust a project-local binary directory', () => {
    // 초판은 `gate.validate('vitest')` 로 **PATH 조회에 의존**했다. vitest 가 PATH 에
    // 없는 기기에서는 "Command executable not found" 분기로 빠져 정작 검증하려던
    // "신뢰되지 않은 경로" 분기에 도달하지 못한다 — 통과도 실패도 의미가 없어진다.
    // (kangnote 기기에서 실제로 그렇게 깨졌다: 2026-08-07.)
    //
    // 그래서 **실행 가능한 더미를 직접 만들고 그 절대경로로** 검증한다. 시스템에
    // 무엇이 설치돼 있든 결과가 같다.
    const binDir = join(mkdtempSync(join(tmpdir(), 'nco-gate-')), 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    // 이름은 allowlist 안에 있어야 한다 — 아니면 allowlist 단계에서 먼저 걸려
    // 정작 검증하려는 경로 신뢰 단계에 도달하지 못한다.
    const localBinary = join(binDir, 'vitest');
    writeFileSync(localBinary, '#!/bin/sh\nexit 0\n');
    chmodSync(localBinary, 0o755);

    const result = gate.validate(localBinary);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Command path not trusted:');
  });
});

describe('CommandGate Homebrew Cellar realpaths', () => {
  const gate = new CommandGate({ allowedCommands: [], deniedCommands: [] });
  const isTrusted = (path: string): boolean => (
    Reflect.get(gate, 'isTrustedExecutablePath').call(gate, path)
  );

  it.each([
    '/opt/homebrew/Cellar/node/25.9.0_2/bin/node',
    '/usr/local/Cellar/node/24.0.0/bin/node',
    '/home/linuxbrew/.linuxbrew/Cellar/node/22.0.0/bin/node',
  ])('trusts canonical Homebrew Cellar realpaths: %s', path => {
    expect(isTrusted(path)).toBe(true);
  });

  it.each([
    '/opt/unmanaged/bin/node',
    '/opt/homebrew/Cellar-override/node/25.9.0_2/bin/node',
  ])('does not widen trust to arbitrary /opt paths: %s', path => {
    expect(isTrusted(path)).toBe(false);
  });
});

describe('CommandGate process-manager isolation', () => {
  const gate = new CommandGate({
    allowedCommands: [],
    deniedCommands: [],
  });

  it.each([
    ['pm2', ['restart', 'nco-backend']],
    ['/opt/homebrew/bin/pm2', ['startOrReload', 'ecosystem.config.cjs']],
    ['npx', ['pm2', 'stop', 'nco-backend']],
    ['npm', ['run', 'pm2:stop']],
    ['npm', ['exec', 'pm2', '--', 'restart', 'nco-backend']],
    ['pm2', ['--silent', 'restart', 'nco-backend']],
    ['pm2', ['sendSignal', 'SIGINT', 'nco-backend']],
    ['bash', ['-lc', 'pm2 restart nco-backend']],
  ])('blocks PM2 mutations through %s', (command, args) => {
    const result = gate.validate(command, args);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('dangerous pattern');
  });

  it('still allows read-only PM2 inspection', () => {
    expect(gate.validate('pm2', ['jlist'])).toEqual({ ok: true });
    expect(gate.validate('/opt/homebrew/bin/pm2', ['describe', 'nco-backend'])).toEqual({ ok: true });
  });

  it.each([
    ['kill', ['-INT', '1234']],
    ['/usr/bin/pkill', ['-f', 'nco-backend']],
    ['bash', ['-lc', 'echo ready; kill -TERM 1234']],
  ])('blocks direct process signals through %s', (command, args) => {
    const result = gate.validate(command, args);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('dangerous process signal');
  });

  it('does not confuse signal-related search text with a process signal', () => {
    expect(gate.validate('rg', ['kill', 'src'])).toEqual({ ok: true });
  });

  it.each([
    ['-e', 'console.log(1)'],
    ['--eval=console.log(1)'],
    ['-p', 'process.version'],
    ['--print', 'process.version'],
  ])('continues to block arbitrary Node.js execution through %s', (...args) => {
    const result = gate.validate('node', args);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('dangerous pattern');
  });
});

describe('CommandGate — nvm / ~/.local 실행 파일 신뢰 (Linux·WSL 회귀)', () => {
  // 배경: 신뢰 경로 목록이 Homebrew·시스템 경로만 담고 있어, 우리 설치 스크립트가
  // nvm 으로 깐 node/npm 과 ~/.local/bin 의 에이전트 CLI 가 Linux·WSL 에서
  // "Command path not trusted" 로 전부 차단됐다(kangnote 실측:
  // verifier failed: .../.nvm/versions/node/v22.22.3/lib/node_modules/npm/bin/npm-cli.js).
  // HOME 을 임시 디렉터리로 바꾸고 모듈을 새로 로드해 실제 판정을 검사한다.
  const mkExec = (dir: string, name: string): string => {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, '#!/bin/sh\nexit 0\n');
    chmodSync(p, 0o755);
    return p;
  };

  let home: string;
  let nvmExec: string;
  let novaSuiteExec: string;
  let localExec: string;
  let strayExec: string;
  let Gate: typeof CommandGate;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'nco-gate-home-'));
    nvmExec = mkExec(join(home, '.nvm/versions/node/v22.22.3/bin'), 'codex');
    // nova-suite 설치기가 깐 툴체인. macOS 실측: 위임 verifier 가
    // "Command path not trusted: ~/.nova/nova-suite/toolchains/node-v22.23.2-darwin-arm64/
    //  lib/node_modules/npm/bin/npm-cli.js" 로 막혀 codex → hermes 로 강등됐다.
    novaSuiteExec = mkExec(
      join(home, '.nova/nova-suite/toolchains/node-v22.23.2-darwin-arm64/lib/node_modules/npm/bin'),
      'npm-cli.js',
    );
    localExec = mkExec(join(home, '.local/bin'), 'agy');
    strayExec = mkExec(join(home, 'somewhere-else'), 'codex');
    vi.stubEnv('HOME', home);
    vi.resetModules();
    ({ CommandGate: Gate } = await import('./command-gate.js'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('nvm 이 설치한 실행 파일을 신뢰한다', () => {
    const gate = new Gate({ allowedCommands: [], deniedCommands: [] });
    expect(gate.validate(nvmExec)).toEqual({ ok: true });
  });

  it('nova-suite 툴체인이 깐 npm 을 신뢰한다', () => {
    const gate = new Gate({ allowedCommands: [], deniedCommands: [] });
    expect(gate.validate(novaSuiteExec)).toEqual({ ok: true });
  });

  it('~/.local/bin 의 에이전트 CLI 를 신뢰한다', () => {
    const gate = new Gate({ allowedCommands: [], deniedCommands: [] });
    expect(gate.validate(localExec)).toEqual({ ok: true });
  });

  it('홈 아래라도 도구 경로가 아니면 여전히 차단한다', () => {
    const gate = new Gate({ allowedCommands: [], deniedCommands: [] });
    const r = gate.validate(strayExec);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Command path not trusted:');
  });

  it('allowlist 모드에서도 nvm 경로가 통과한다', () => {
    const gate = new Gate({ allowedCommands: ['codex'], deniedCommands: [] });
    expect(gate.validate(nvmExec)).toEqual({ ok: true });
  });
});
