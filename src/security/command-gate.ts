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

export class CommandGate {
  private allowed: Set<string>;
  private denied: string[];

  constructor(policy: CommandPolicy) {
    this.allowed = new Set(policy.allowedCommands);
    this.denied = policy.deniedCommands;
  }

  validate(command: string, args: string[] = []): { ok: boolean; reason?: string } {
    const fullCmd = [command, ...args].join(' ');

    // 1. Extract base command
    const baseCmd = command.split('/').pop() || command;

    // 2. Allowed command check
    if (this.allowed.size > 0 && !this.allowed.has(baseCmd)) {
      return { ok: false, reason: `Command not in allowlist: ${baseCmd}` };
    }

    // 3. Custom denied patterns
    for (const pattern of this.denied) {
      if (fullCmd.includes(pattern)) {
        return { ok: false, reason: `Command matches denied pattern: ${pattern}` };
      }
    }

    // 4. Global dangerous patterns
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
}
