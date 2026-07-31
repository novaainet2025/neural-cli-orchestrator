import { accessSync, constants, existsSync, realpathSync } from 'fs';
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

const TRUSTED_EXEC_DIRS = [
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
      if (!this.isTrustedExecutablePath(resolvedCommand)) {
        return { ok: false, reason: `Command path not trusted: ${resolvedCommand}` };
      }
    } else if ((command.includes('/') || isAbsolute(command)) && resolvedCommand && !this.isTrustedExecutablePath(resolvedCommand)) {
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

  private isTrustedExecutablePath(executablePath: string): boolean {
    return TRUSTED_EXEC_DIRS.some(dir => executablePath === dir || executablePath.startsWith(`${dir}/`));
  }
}
