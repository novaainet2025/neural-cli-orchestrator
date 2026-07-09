import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'fs';
import { resolve } from 'path';
import { execa } from 'execa';
import { createLogger } from '../utils/logger.js';
import { getDb } from '../storage/database.js';

const log = createLogger('false-report-guard');

const SAFE_SHELL_SUCCESS_COMMANDS = new Set([
  'node', 'npm', 'npx', 'tsx', 'tsc',
  'git', 'cat', 'ls', 'head', 'tail', 'wc',
  'grep', 'rg', 'find', 'which',
  'echo', 'date', 'pwd',
  'vitest', 'jest', 'mocha',
  'python3', 'pip3',
]);

const SHELL_META_PATTERN = /[;&|<>$`()]/;

export interface VerificationEvidence {
  type: 'file_exists' | 'file_content' | 'test_pass' | 'shell_success';
  target: string;
  expected?: string | RegExp;
}

/**
 * FalseReportGuard — Prevents agents from claiming they did something when they didn't.
 */
export class FalseReportGuard {
  /**
   * Verifies a task report against provided evidence.
   */
  async verifyReport(taskId: string, agentId: string, evidences: VerificationEvidence[]): Promise<{ verified: boolean; failures: string[] }> {
    const failures: string[] = [];

    for (const evidence of evidences) {
      const ok = await this.checkEvidence(evidence);
      if (!ok) {
        failures.push(`Evidence failed: ${evidence.type} on ${evidence.target}`);
      }
    }

    const verified = failures.length === 0;

    if (!verified) {
      log.warn({ taskId, failures }, 'False report detected!');
      this.recordFalseReport(taskId, agentId, failures);
    } else {
      log.info({ taskId }, 'Report verified successfully');
    }

    return { verified, failures };
  }

  private async checkEvidence(evidence: VerificationEvidence): Promise<boolean> {
    try {
      switch (evidence.type) {
        case 'file_exists':
          return existsSync(evidence.target);

        case 'file_content':
          if (!existsSync(evidence.target)) return false;
          const content = readFileSync(evidence.target, 'utf-8');
          if (evidence.expected instanceof RegExp) {
            return evidence.expected.test(content);
          }
          if (typeof evidence.expected === 'string') {
            return content.includes(evidence.expected);
          }
          return true; // Just existence if no expected content provided

        case 'test_pass':
          try {
            await execa('npm', ['test', '--', evidence.target], { timeout: 60000 });
            return true;
          } catch {
            return false;
          }

        case 'shell_success':
          return this.checkShellTargetStatus(evidence.target);

        default:
          return false;
      }
    } catch (err: any) {
      log.error({ err: err.message, target: evidence.target }, 'Evidence check failed with error');
      return false;
    }
  }

  private recordFalseReport(taskId: string, agentId: string, failures: string[]) {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO false_reports (task_id, agent_id, reason, evidence)
        VALUES (?, ?, ?, ?)
      `).run(taskId, agentId, failures.join('; '), JSON.stringify(failures));

      // Increment global false_report_count in metrics
      db.prepare(`
        UPDATE metrics 
        SET value = value + 1 
        WHERE agent_id = 'system' AND metric_type = 'false_report_count'
      `).run();
    } catch (err: any) {
      log.error({ err: err.message }, 'Failed to record false report');
    }
  }

  private checkShellTargetStatus(target: string): boolean {
    if (!target || SHELL_META_PATTERN.test(target)) {
      return false;
    }

    const [command] = target.trim().split(/\s+/);
    if (!command || !SAFE_SHELL_SUCCESS_COMMANDS.has(command)) {
      return false;
    }

    const resolved = this.resolveExecutable(command);
    return resolved !== null;
  }

  private resolveExecutable(command: string): string | null {
    const candidates = command.includes('/')
      ? [resolve(command)]
      : (process.env.PATH || '').split(':').filter(Boolean).map(entry => resolve(entry, command));

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
}

export const falseReportGuard = new FalseReportGuard();
