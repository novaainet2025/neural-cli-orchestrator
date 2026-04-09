import { resolve, normalize, relative, isAbsolute } from 'path';
import { realpathSync, existsSync, lstatSync } from 'fs';
import { createLogger } from '../utils/logger.js';

const log = createLogger('path-guard');

export interface PathPolicy {
  allowedPaths: string[];   // glob-free absolute paths (roots)
  deniedPaths: string[];    // always blocked
}

const GLOBAL_DENIED = [
  '/etc/shadow', '/etc/passwd', '/etc/sudoers',
  '/root', '/proc', '/sys',
  '**/.env', '**/.ssh', '**/id_rsa', '**/credentials',
];

export class PathGuard {
  private allowed: string[];
  private denied: string[];

  constructor(policy: PathPolicy) {
    this.allowed = policy.allowedPaths.map(p => resolve(p));
    this.denied = [...GLOBAL_DENIED, ...policy.deniedPaths].map(p =>
      p.startsWith('**/') ? p : resolve(p)
    );
  }

  validate(targetPath: string): { ok: boolean; reason?: string } {
    const abs = isAbsolute(targetPath) ? normalize(targetPath) : resolve(targetPath);

    // 1. Traverse attack check (.. sequences)
    if (targetPath.includes('..')) {
      const resolved = resolve(targetPath);
      if (resolved !== abs) {
        return { ok: false, reason: `Path traversal detected: ${targetPath}` };
      }
    }

    // 2. Denied paths (exact + pattern)
    for (const denied of this.denied) {
      if (denied.startsWith('**/')) {
        const suffix = denied.slice(3);
        if (abs.endsWith(suffix) || abs.includes(`/${suffix}`)) {
          return { ok: false, reason: `Path denied by pattern: ${denied}` };
        }
      } else if (abs === denied || abs.startsWith(denied + '/')) {
        return { ok: false, reason: `Path explicitly denied: ${denied}` };
      }
    }

    // 3. Symlink resolution (prevent escape)
    if (existsSync(abs)) {
      try {
        const stat = lstatSync(abs);
        if (stat.isSymbolicLink()) {
          const real = realpathSync(abs);
          const realCheck = this.isUnderAllowed(real);
          if (!realCheck) {
            return { ok: false, reason: `Symlink escapes sandbox: ${abs} → ${real}` };
          }
        }
      } catch {
        // file doesn't exist yet (create), that's ok
      }
    }

    // 4. Allowed paths check
    if (!this.isUnderAllowed(abs)) {
      return { ok: false, reason: `Path not in allowed roots: ${abs}` };
    }

    return { ok: true };
  }

  private isUnderAllowed(abs: string): boolean {
    return this.allowed.some(root => abs === root || abs.startsWith(root + '/'));
  }

  assertValid(targetPath: string): void {
    const result = this.validate(targetPath);
    if (!result.ok) {
      log.warn({ path: targetPath, reason: result.reason }, 'Path blocked');
      throw new Error(`PathGuard: ${result.reason}`);
    }
  }
}
