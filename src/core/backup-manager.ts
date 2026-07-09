/**
 * BackupManager — SQLite WAL checkpoint + tar.gz 아카이브
 * /api/backup/* 라우트에서 호출
 */

import { createId } from '../utils/id.js';
import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';
import { mkdir, readdir, stat, unlink } from 'fs/promises';
import { join, resolve } from 'path';

const log = createLogger('backup-manager');

export interface BackupRecord {
  id: string;
  filename: string;
  path: string;
  sizeBytes: number;
  description: string;
  createdAt: string;
}

const BACKUP_DIR = resolve('./db/backups');
const DB_PATH    = resolve('./db/nco.db');
const MAX_BACKUPS = 30; // 최대 보관 개수

async function ensureDir(): Promise<void> {
  await mkdir(BACKUP_DIR, { recursive: true });
}

export async function createBackup(description = ''): Promise<BackupRecord> {
  await ensureDir();

  const db = getDb();
  // WAL checkpoint — dirty pages를 DB 파일에 flush
  db.pragma('wal_checkpoint(TRUNCATE)');

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `nco-${ts}.tar.gz`;
  const dest     = join(BACKUP_DIR, filename);

  const { execa } = await import('execa');
  // tar: DB 파일 + 설정 파일
  await execa('tar', ['-czf', dest, '-C', resolve('.'), 'db/nco.db', '.env'], {
    reject: false,
  });

  const s = await stat(dest);
  const id = createId();

  db.prepare(`
    INSERT INTO backups (id, filename, path, size_bytes, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, filename, dest, s.size, description || `수동 백업 ${ts}`);

  log.info({ id, filename, sizeBytes: s.size }, 'Backup created');

  // 오래된 백업 자동 정리
  await pruneOldBackups();

  return { id, filename, path: dest, sizeBytes: s.size, description: description || `수동 백업 ${ts}`, createdAt: new Date().toISOString() };
}

export function listBackups(): BackupRecord[] {
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM backups ORDER BY created_at DESC`).all() as any[];
    return rows.map(r => ({
      id: r.id, filename: r.filename, path: r.path,
      sizeBytes: r.size_bytes, description: r.description, createdAt: r.created_at,
    }));
  } catch { return []; }
}

export function getBackup(id: string): BackupRecord | null {
  try {
    const db = getDb();
    const r = db.prepare(`SELECT * FROM backups WHERE id=?`).get(id) as any;
    if (!r) return null;
    return { id: r.id, filename: r.filename, path: r.path, sizeBytes: r.size_bytes, description: r.description, createdAt: r.created_at };
  } catch { return null; }
}

export async function deleteBackup(id: string): Promise<boolean> {
  const record = getBackup(id);
  if (!record) return false;
  try {
    await unlink(record.path);
  } catch { /* already deleted */ }
  const db = getDb();
  const r = db.prepare(`DELETE FROM backups WHERE id=?`).run(id);
  return r.changes > 0;
}

async function pruneOldBackups(): Promise<void> {
  try {
    const db = getDb();
    const old = db.prepare(`
      SELECT id, path FROM backups ORDER BY created_at DESC LIMIT -1 OFFSET ?
    `).all(MAX_BACKUPS) as any[];
    for (const row of old) {
      try { await unlink(row.path); } catch { /* ignore */ }
      db.prepare(`DELETE FROM backups WHERE id=?`).run(row.id);
    }
  } catch { /* ignore */ }
}
