import { accessSync, constants, existsSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { basename, isAbsolute, resolve } from 'path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('command-gate');

export interface CommandPolicy {
  allowedCommands: string[];     // e.g. ['node', 'npm', 'git', 'cat', 'ls']
  deniedCommands: string[];      // e.g. ['rm -rf', 'chmod 777']
}

const GLOBAL_DENIED_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force|-rf|-fr)\b/,   // rm -rf
  /\bchmod\s+777\b/,
  /\bchown\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\b(sudo|su)\s/,
  />\s*\/dev\/sd/,
  /\bcurl\b.*\|\s*(ba)?sh/,      // curl | bash (pipe to shell)
  /\bwget\b.*\|\s*(ba)?sh/,
  /\beval\b/,
  /`[^`]*`/,                      // backtick subshell
  /\$\([^)]*\)/,                  // $() subshell
  /;\s*(rm|kill|shutdown|reboot)/, // chained dangerous commands
  /\|\s*(ba)?sh/,                 // pipe to shell
  /\bkill\s+-9\s+(-1|1)\b/,      // kill all processes
  /\bshutdown\b/,
  /\breboot\b/,
  /\bnc\s+-l/,                    // netcat listen
  /\bpython[23]?\s+-c\s/,         // arbitrary python exec
  /\b(?:node|tsx|deno)\b[^\r\n]*\s(?:-e|--eval|-p|--print)(?:=|\s|$)/, // arbitrary JS/TS exec
  /\b(?:node|tsx|deno)\b[^\r\n]*\s-(?:\s|$)/, // script from stdin
  // PM2는 조회 전용 서브명령만 허용한다. sendSignal/startOrReload/옵션 삽입 같은
  // 열거 누락이 곧 NCO 자기 재기동 우회가 되므로 mutation 목록을 유지하지 않는다.
  /(?:^|[\s;&|])(?:\/[^\s]+\/)?pm2\b(?!\s+(?:list|ls|jlist|prettylist|describe|show|status|ping|report|env|logs|monit)\b)/i,
];

const TRUSTED_EXEC_DIRS_STATIC = [
  '/bin',
  '/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/home/linuxbrew/.linuxbrew/bin',
  '/home/linuxbrew/.linuxbrew/sbin',
  // npm/npx 등은 bin 심링크가 realpath 해석 시 글로벌 node_modules 안의
  // *-cli.js로 풀린다 (예: /opt/homebrew/bin/npm → …/lib/node_modules/npm/bin/npm-cli.js)
  '/opt/homebrew/lib/node_modules',
  '/usr/local/lib/node_modules',
  '/usr/lib/node_modules',
  '/home/linuxbrew/.linuxbrew/lib/node_modules',
  // Project node_modules/.bin is intentionally omitted; invoke local tools via trusted npm/npx.
];

const GITHUB_HOSTED_TOOLCACHE_NPM_EXECUTABLE =
  /^\/opt\/hostedtoolcache\/node\/\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?\/(?:x64|arm64)\/lib\/node_modules\/npm\/bin\/(npm|npx)-cli\.js$/;

/**
 * GitHub-hosted Linux runners put node on PATH from /opt/hostedtoolcache. npm
 * and npx are symlinks whose realpath is the package's *-cli.js entrypoint.
 * Trust only that exact version/architecture/package layout and bind the
 * resolved entrypoint back to the requested npm/npx command name.
 */
function isTrustedGithubHostedNpmExecutable(
  executablePath: string,
  requestedBaseCommand: string,
): boolean {
  const match = GITHUB_HOSTED_TOOLCACHE_NPM_EXECUTABLE.exec(executablePath);
  return !!match && match[1] === requestedBaseCommand;
}

/**
 * 사용자 홈 아래의 도구 설치 경로.
 *
 * 위 고정 목록은 Homebrew/시스템 경로만 담고 있어 macOS 에서는 문제가 없었지만,
 * Linux/WSL 에서는 우리 설치 스크립트가 만든 경로가 통째로 빠져 있었다:
 *   - setup.sh · install-wsl.sh 는 Node 를 **nvm** 으로 깐다
 *       → $HOME/.nvm/versions/node/vX/bin/{node,npm,npx,codex,...}
 *       → realpath 는 .../lib/node_modules/<pkg>/bin/*.js 로 풀린다
 *   - cli-installs/install-all.sh 는 "All tools installed to ~/.local" 로
 *       $HOME/.local/bin 에 에이전트 CLI 를 넣고, uv/bun/cargo 도 쓴다
 *
 * 그 결과 Linux/WSL 머신에서는 정상 설치된 codex/npm 조차
 * "Command path not trusted: /home/<user>/.nvm/.../npm-cli.js" 로 차단됐다
 * (kangnote 머신 실측 — 설치는 됐는데 위임이 전부 막히던 원인).
 *
 * 이 경로들은 Homebrew 접두사와 마찬가지로 "사용자가 스스로 설치한 도구" 영역이며,
 * 홈 디렉터리 전체가 아니라 도구 설치 경로만 열거한다.
 */
/**
 * 신뢰 경로를 realpath 로 정규화한 목록. 존재하지 않는 경로는 원본을 유지한다
 * (플랫폼별로 없는 디렉터리가 많고, 없는 것은 어차피 매칭되지 않는다).
 *
 * 캐시하되 HOME 이 바뀌면 다시 만든다 — 테스트가 HOME 을 바꿔가며 검증한다.
 */
let _trustedCache: { home: string; dirs: string[] } | null = null;
function trustedExecDirsResolved(): string[] {
  const home = homedir();
  if (_trustedCache && _trustedCache.home === home) return _trustedCache.dirs;
  const dirs = [...TRUSTED_EXEC_DIRS_STATIC, ...userToolDirs()].map(dir => {
    try {
      return realpathSync(dir);
    } catch {
      return dir;
    }
  });
  _trustedCache = { home, dirs };
  return dirs;
}

function userToolDirs(): string[] {
  const home = homedir();
  if (!home || home === '/') return [];
  return [
    `${home}/.nvm/versions/node`,        // nvm 이 깐 node/npm/npx 및 전역 패키지 전체
    `${home}/.local/bin`,                // install-all.sh 의 기본 설치 위치
    `${home}/.local/share/uv/tools`,     // uv tool install (심링크 realpath 대상)
    `${home}/.local/pipx/venvs`,         // pipx install
    `${home}/.bun/bin`,
    `${home}/.cargo/bin`,
  ];
}

export class CommandGate {
  private allowed: Set<string>;
  private denied: string[];

  constructor(policy: CommandPolicy) {
    this.allowed = new Set(policy.allowedCommands);
    this.denied = policy.deniedCommands;
  }

  validate(command: string, args: string[] = []): { ok: boolean; reason?: string } {
    const fullCmd = [command, ...args].join(' ');
    const baseCmd = basename(command);
    const resolvedCommand = this.resolveExecutable(command);
    const commandTexts = [fullCmd];
    if (/^(?:ba)?sh$/.test(baseCmd)) {
      const commandArgIndex = args.findIndex(arg => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
      if (commandArgIndex >= 0 && args[commandArgIndex + 1]) {
        commandTexts.push(args[commandArgIndex + 1]);
      }
    }

    if (['kill', 'pkill', 'killall'].includes(baseCmd)) {
      return { ok: false, reason: `Command matches dangerous process signal: ${baseCmd}` };
    }
    const shellCommandTexts = commandTexts.slice(1);
    if (shellCommandTexts.some(text => (
      /(?:^|[;&|]\s*)(?:\/[^\s]+\/)?(?:kill|pkill|killall)\s+/i.test(text)
    ))) {
      return { ok: false, reason: 'Command matches dangerous process signal in shell command' };
    }

    // Global and custom denials apply even when the allowlist is intentionally empty.
    for (const pattern of this.denied) {
      if (commandTexts.some(text => text.includes(pattern))) {
        return { ok: false, reason: `Command matches denied pattern: ${pattern}` };
      }
    }

    for (const regex of GLOBAL_DENIED_PATTERNS) {
      if (commandTexts.some(text => regex.test(text))) {
        return { ok: false, reason: `Command matches dangerous pattern: ${regex.source}` };
      }
    }

    // 1. Allowed command check
    if (this.allowed.size > 0 && !this.allowed.has(baseCmd)) {
      return { ok: false, reason: `Command not in allowlist: ${baseCmd}` };
    }

    if (this.allowed.size > 0) {
      if (!resolvedCommand) {
        return { ok: false, reason: `Command executable not found: ${command}` };
      }
      if (!this.isTrustedExecutablePath(resolvedCommand, baseCmd)) {
        return { ok: false, reason: `Command path not trusted: ${resolvedCommand}` };
      }
    } else if (
      (command.includes('/') || isAbsolute(command))
      && resolvedCommand
      && !this.isTrustedExecutablePath(resolvedCommand, baseCmd)
    ) {
      return { ok: false, reason: `Command path not trusted: ${resolvedCommand}` };
    }

    return { ok: true };
  }

  assertValid(command: string, args: string[] = []): void {
    const result = this.validate(command, args);
    if (!result.ok) {
      log.warn({ command, args, reason: result.reason }, 'Command blocked');
      throw new Error(`CommandGate: ${result.reason}`);
    }
  }

  private resolveExecutable(command: string): string | null {
    const candidates: string[] = [];

    if (command.includes('/') || isAbsolute(command)) {
      candidates.push(isAbsolute(command) ? command : resolve(command));
    } else {
      const pathEntries = (process.env.PATH || '').split(':').filter(Boolean);
      for (const entry of pathEntries) {
        candidates.push(resolve(entry, command));
      }
    }

    for (const candidate of candidates) {
      if (!existsSync(candidate)) {
        continue;
      }

      try {
        accessSync(candidate, constants.X_OK);
        return realpathSync(candidate);
      } catch {
        continue;
      }
    }

    return null;
  }

  private isTrustedExecutablePath(executablePath: string, requestedBaseCommand: string): boolean {
    // 비교 대상(executablePath)은 resolveExecutable 에서 realpathSync 로 풀린 값이다.
    // 신뢰 경로 쪽을 풀지 않으면, 경로 중간에 심링크가 하나라도 있을 때
    // (예: macOS 의 /var → /private/var, 홈이 심링크인 구성) 접두사 비교가
    // 조용히 어긋나 정상 실행 파일이 차단된다. 양쪽 모두 realpath 로 맞춘다.
    return trustedExecDirsResolved().some(
      dir => executablePath === dir || executablePath.startsWith(`${dir}/`),
    ) || isTrustedGithubHostedNpmExecutable(executablePath, requestedBaseCommand);
  }
}
