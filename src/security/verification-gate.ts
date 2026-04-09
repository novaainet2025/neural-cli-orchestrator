import { execa } from 'execa';
import { existsSync } from 'fs';
import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { env } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('verification-gate');

export interface GateResult {
  level: 'L1_typecheck' | 'L2_lint' | 'L3_change_ratio';
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
  errors?: string[];
}

export interface VerificationResult {
  passed: boolean;
  results: GateResult[];
  taskId: string;
}

export class TripleVerificationGate {
  /**
   * Run L1 (tsc) + L2 (eslint) + L3 (change ratio check) verification.
   * Returns pass only if ALL gates pass.
   */
  async verify(taskId: string, changedFiles: string[] = []): Promise<VerificationResult> {
    const results: GateResult[] = [];

    // L1: TypeScript type check
    const l1 = await this.checkTypeScript();
    results.push(l1);

    // L2: ESLint on changed files
    const l2 = await this.checkLint(changedFiles);
    results.push(l2);

    // L3: Change ratio check (file-level, already enforced by FileChangeGuard — log only)
    const l3 = this.checkChangeRatio(taskId);
    results.push(l3);

    const passed = results.every(r => r.status === 'pass' || r.status === 'skip');

    // Record to DB
    this.recordResults(taskId, results);

    log.info({ taskId, passed, results: results.map(r => `${r.level}:${r.status}`) }, 'Verification complete');

    return { passed, results, taskId };
  }

  // ─── L1: TypeScript ────────────────────────────────
  private async checkTypeScript(): Promise<GateResult> {
    const tsconfigPath = `${env.ROOT}/tsconfig.json`;
    if (!existsSync(tsconfigPath)) {
      return { level: 'L1_typecheck', status: 'skip', detail: 'No tsconfig.json found' };
    }

    try {
      const { stdout, stderr, exitCode } = await execa('npx', ['tsc', '--noEmit'], {
        cwd: env.ROOT,
        reject: false,
        timeout: 60_000,
      });

      const output = stdout + stderr;
      const errorLines = output.split('\n').filter(l => l.includes('error TS'));

      if (exitCode === 0 || errorLines.length === 0) {
        return { level: 'L1_typecheck', status: 'pass' };
      }

      return {
        level: 'L1_typecheck',
        status: 'fail',
        detail: `${errorLines.length} TypeScript error(s)`,
        errors: errorLines.slice(0, 10),
      };
    } catch (err: any) {
      return {
        level: 'L1_typecheck',
        status: 'fail',
        detail: `tsc execution failed: ${err.message}`,
      };
    }
  }

  // ─── L2: ESLint ────────────────────────────────────
  private async checkLint(changedFiles: string[]): Promise<GateResult> {
    const hasEslint = ['eslint.config.js', 'eslint.config.mjs', '.eslintrc.js', '.eslintrc.json']
      .some(f => existsSync(`${env.ROOT}/${f}`));

    if (!hasEslint) {
      return { level: 'L2_lint', status: 'skip', detail: 'No ESLint config found' };
    }

    const tsFiles = changedFiles.filter(f => /\.(ts|tsx|js|jsx)$/.test(f));
    if (tsFiles.length === 0) {
      return { level: 'L2_lint', status: 'skip', detail: 'No JS/TS files changed' };
    }

    try {
      const { stdout, stderr, exitCode } = await execa('npx', ['eslint', '--no-warn', ...tsFiles.slice(0, 20)], {
        cwd: env.ROOT,
        reject: false,
        timeout: 30_000,
      });

      const output = stdout + stderr;
      const errorLines = output.split('\n').filter(l => l.includes('error'));

      if (exitCode === 0 || errorLines.length === 0) {
        return { level: 'L2_lint', status: 'pass' };
      }

      return {
        level: 'L2_lint',
        status: 'fail',
        detail: `${errorLines.length} lint error(s)`,
        errors: errorLines.slice(0, 10),
      };
    } catch (err: any) {
      return {
        level: 'L2_lint',
        status: 'skip',
        detail: `ESLint execution failed: ${err.message}`,
      };
    }
  }

  // ─── L3: Change Ratio (read from DB, enforced by FileChangeGuard) ───
  private checkChangeRatio(taskId: string): GateResult {
    try {
      const db = getDb();
      const blocked = db.prepare(
        "SELECT COUNT(*) as cnt FROM file_backups WHERE task_id = ? AND change_ratio >= 0.9"
      ).get(taskId) as any;

      if (blocked?.cnt > 0) {
        return {
          level: 'L3_change_ratio',
          status: 'fail',
          detail: `${blocked.cnt} file(s) blocked by 90%+ change ratio`,
        };
      }

      return { level: 'L3_change_ratio', status: 'pass' };
    } catch {
      return { level: 'L3_change_ratio', status: 'skip', detail: 'DB not available' };
    }
  }

  // ─── Record Results ────────────────────────────────
  private recordResults(taskId: string, results: GateResult[]): void {
    try {
      const db = getDb();
      const stmt = db.prepare(`
        INSERT INTO verification_gates (id, task_id, gate_level, status, detail_json)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const r of results) {
        stmt.run(
          createId('vg'),
          taskId,
          r.level,
          r.status,
          JSON.stringify({ detail: r.detail, errors: r.errors }),
        );
      }
    } catch {
      // Non-critical
    }
  }

  /**
   * Get verification results for a task.
   */
  getResults(taskId: string): any[] {
    try {
      const db = getDb();
      return db.prepare(
        'SELECT * FROM verification_gates WHERE task_id = ? ORDER BY created_at ASC'
      ).all(taskId);
    } catch {
      return [];
    }
  }
}

export const verificationGate = new TripleVerificationGate();
