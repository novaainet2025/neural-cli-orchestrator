/**
 * doctor — 로컬 nova-cli 런타임 진단 (이식 2026-07-12, codex `doctor` 이식).
 * NCO/Nova-AX/ollama 엔드포인트 + git/node 런타임을 점검해 구조화 결과를 반환한다.
 * TUI(/doctor)와 스크립트모드(nova-cli doctor) 양쪽에서 공유한다.
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getConfigString } from './runtimeConfig.js';

const execAsync = promisify(exec);

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface AuditableCommandDefinition {
  name: string;
  usage: string;
  help: string;
  handler: unknown;
}

export const runCommandDefinitionChecks = (
  definitions: Iterable<AuditableCommandDefinition>,
  toolNames: readonly string[] = []
): DoctorCheck[] => {
  const commands = [...definitions];
  const names = commands.map((command) => command.name);
  const uniqueNames = new Set(names);
  const invalidNames = names.filter((name) => !name.startsWith('/'));
  const missingHandlers = commands.filter((command) => typeof command.handler !== 'function');
  const missingMetadata = commands.filter(
    (command) => !command.usage?.trim() || !command.help?.trim()
  );
  const invalidUsage = commands.filter((command) => {
    const first = command.usage?.trim().split(/\s+/, 1)[0];
    return first !== command.name;
  });

  return [
    {
      name: 'command registry',
      status: commands.length > 0 && uniqueNames.size === commands.length && invalidNames.length === 0 ? 'ok' : 'fail',
      detail: `${commands.length}개 등록 · 중복 ${commands.length - uniqueNames.size} · 잘못된 이름 ${invalidNames.length}`
    },
    {
      name: 'command handlers',
      status: missingHandlers.length === 0 ? 'ok' : 'fail',
      detail: `${commands.length - missingHandlers.length}/${commands.length} 실행 핸들러 연결`
    },
    {
      name: 'command metadata',
      status: missingMetadata.length === 0 ? 'ok' : 'warn',
      detail: `usage/help 누락 ${missingMetadata.length}`
    },
    {
      name: 'command schemas',
      status: invalidUsage.length === 0 ? 'ok' : 'fail',
      detail: invalidUsage.length === 0
        ? `${commands.length}/${commands.length} 명령 usage 연결`
        : `명령 이름과 불일치 ${invalidUsage.length}: ${invalidUsage.slice(0, 5).map((command) => command.name).join(', ')}`
    },
    {
      name: 'agent tools',
      status: toolNames.length > 0 ? 'ok' : 'warn',
      detail: toolNames.length > 0 ? `${toolNames.length}개: ${toolNames.join(', ')}` : '도구 카탈로그 없음'
    },
    {
      name: 'side effects',
      status: 'warn',
      detail: '위험·외부 변경 명령은 진단 중 실제 실행하지 않음'
    }
  ];
};

const httpProbe = async (
  url: string,
  timeoutMs = 3000
): Promise<{ ok: boolean; status?: number; detail: string }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { ok: res.ok, status: res.status, detail: `HTTP ${res.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return { ok: false, detail: message };
  } finally {
    clearTimeout(timer);
  }
};

const checkGit = async (): Promise<DoctorCheck> => {
  try {
    const { stdout } = await execAsync('git --version');
    return { name: 'git', status: 'ok', detail: stdout.trim() };
  } catch {
    return { name: 'git', status: 'fail', detail: 'git 미설치 또는 PATH 없음' };
  }
};

const checkNode = (): DoctorCheck => {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  return {
    name: 'node',
    status: major >= 18 ? 'ok' : 'warn',
    detail: `v${process.versions.node}${major < 18 ? ' (권장 v18+)' : ''}`
  };
};

const endpoint = (dottedKey: string, fallback: string): string =>
  getConfigString(dottedKey) ?? fallback;

export const runDoctorChecks = async (): Promise<DoctorCheck[]> => {
  const ncoBase = endpoint('nco.baseUrl', 'http://localhost:6200');
  const axBase = endpoint('ax.baseUrl', 'http://localhost:6300');
  const ollamaBase = endpoint('ollama.baseUrl', 'http://localhost:11434');

  const [git, nco, ax, ollama] = await Promise.all([
    checkGit(),
    httpProbe(`${ncoBase}/health`),
    httpProbe(`${axBase}/api/health`),
    httpProbe(`${ollamaBase}/api/tags`)
  ]);

  const toCheck = (name: string, r: { ok: boolean; detail: string }, optional = false): DoctorCheck => ({
    name,
    status: r.ok ? 'ok' : optional ? 'warn' : 'fail',
    detail: r.detail
  });

  return [
    checkNode(),
    git,
    toCheck('NCO :6200', nco),
    toCheck('Nova-AX :6300', ax, true),
    toCheck('ollama :11434', ollama, true)
  ];
};

const ICON: Record<DoctorStatus, string> = { ok: '✔', warn: '⚠', fail: '✖' };

export const formatDoctorLines = (checks: DoctorCheck[]): string[] =>
  checks.map((c) => `${ICON[c.status]} ${c.name.padEnd(16)} ${c.detail}`);

export const doctorHasFailure = (checks: DoctorCheck[]): boolean =>
  checks.some((c) => c.status === 'fail');
