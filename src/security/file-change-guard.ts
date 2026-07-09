import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, basename, join } from 'path';
import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('file-change-guard');

export interface ChangeValidation {
  action: 'allow' | 'backup_then_proceed' | 'blocked';
  changeRatio: number;
  reason?: string;
  backupPath?: string;
}

export class FileChangeGuard {
  private readonly blockThreshold = 0.9;   // 90%+ → blocked
  private readonly backupThreshold = 0.7;  // 70%+ → backup then proceed

  /**
   * Validate a file change by comparing original vs modified content.
   * Returns action: allow (< 70%), backup_then_proceed (70-90%), blocked (90%+).
   */
  async validateChange(
    filePath: string,
    originalContent: string,
    modifiedContent: string,
    agentId: string,
    taskId?: string,
  ): Promise<ChangeValidation> {
    const ratio = this.calculateChangeRatio(originalContent, modifiedContent);

    // New file (original empty) — always allow
    if (originalContent.length === 0) {
      return { action: 'allow', changeRatio: 0 };
    }

    // 90%+ → BLOCKED
    if (ratio >= this.blockThreshold) {
      const reason = `${(ratio * 100).toFixed(0)}% change detected — full file replacement blocked`;
      log.warn({ filePath, ratio, agentId }, reason);
      return { action: 'blocked', changeRatio: ratio, reason };
    }

    // 70-90% → BACKUP then allow
    if (ratio >= this.backupThreshold) {
      const backupPath = await this.createBackup(filePath, originalContent, agentId, taskId, ratio);
      const reason = `${(ratio * 100).toFixed(0)}% change — backup created: ${backupPath}`;
      log.info({ filePath, ratio, backupPath, agentId }, reason);
      return { action: 'backup_then_proceed', changeRatio: ratio, reason, backupPath };
    }

    // < 70% → ALLOW
    return { action: 'allow', changeRatio: ratio };
  }

  calculateChangeRatio(original: string, modified: string): number {
    if (original === modified) return 0;
    const byteRatio = this.calculateSegmentChangeRatio(original, modified);
    const lineRatio = this.calculateSegmentChangeRatio(original.split('\n'), modified.split('\n'));
    return Math.min(1, Math.max(byteRatio, lineRatio));
  }

  /**
   * Create a backup of the original file content.
   */
  async createBackup(
    filePath: string,
    content: string,
    agentId: string,
    taskId?: string,
    changeRatio = 0,
  ): Promise<string> {
    const backupDir = join(dirname(filePath), '.backup');
    if (!existsSync(backupDir)) {
      await mkdir(backupDir, { recursive: true });
    }

    const timestamp = Date.now();
    const name = basename(filePath);
    const backupPath = join(backupDir, `${name}.${timestamp}.bak`);

    await writeFile(backupPath, content, 'utf-8');

    // Record in DB
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO file_backups (id, agent_id, task_id, file_path, backup_path, change_ratio, original_size)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(createId('bak'), agentId, taskId || null, filePath, backupPath, changeRatio, Buffer.byteLength(content));
    } catch {
      // DB not critical — backup file already saved
    }

    return backupPath;
  }

  /**
   * List recent backups from DB.
   */
  listBackups(limit = 20): any[] {
    try {
      const db = getDb();
      return db.prepare(
        'SELECT * FROM file_backups ORDER BY created_at DESC LIMIT ?'
      ).all(limit);
    } catch {
      return [];
    }
  }

  private calculateSegmentChangeRatio<T>(original: T[] | string, modified: T[] | string): number {
    const originalLength = original.length;
    if (originalLength === 0) return 0;

    let prefix = 0;
    const sharedLength = Math.min(original.length, modified.length);
    while (prefix < sharedLength && original[prefix] === modified[prefix]) {
      prefix++;
    }

    let suffix = 0;
    while (
      suffix < sharedLength - prefix &&
      original[original.length - 1 - suffix] === modified[modified.length - 1 - suffix]
    ) {
      suffix++;
    }

    const changedOriginal = Math.max(0, original.length - prefix - suffix);
    const changedModified = Math.max(0, modified.length - prefix - suffix);
    return Math.max(changedOriginal, changedModified) / originalLength;
  }
}

export const fileChangeGuard = new FileChangeGuard();
