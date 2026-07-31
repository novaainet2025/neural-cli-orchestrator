import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CommandGate } from './command-gate.js';

describe('CommandGate trusted executables', () => {
  const gate = new CommandGate({
    allowedCommands: ['npm', 'npx', 'vitest'],
    deniedCommands: [],
  });

  it('allows system-installed npm package runners', () => {
    expect(gate.validate('npm')).toEqual({ ok: true });
    expect(gate.validate('npx')).toEqual({ ok: true });
  });

  it('does not trust a project-local binary directory', () => {
    const result = gate.validate('vitest');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Command path not trusted:');
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
  let localExec: string;
  let strayExec: string;
  let Gate: typeof CommandGate;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'nco-gate-home-'));
    nvmExec = mkExec(join(home, '.nvm/versions/node/v22.22.3/bin'), 'codex');
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
