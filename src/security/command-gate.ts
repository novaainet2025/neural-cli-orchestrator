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
  resolve(process.cwd(), 'node_modules/.bin'),
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

    // 2. Custom denied patterns
    for (const pattern of this.denied) {
      if (fullCmd.includes(pattern)) {
        return { ok: false, reason: `Command matches denied pattern: ${pattern}` };
      }
    }

    // 3. Global dangerous patterns
    for (const regex of GLOBAL_DENIED_PATTERNS) {
      if (regex.test(fullCmd)) {
        return { ok: false, reason: `Command matches dangerous pattern: ${regex.source}` };
      }
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
