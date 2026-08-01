import Database from 'better-sqlite3';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('125_audit_epochs migration transactionality', () => {
  it('rolls every DDL and backfill change back when the migration transaction fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nco-audit-epoch-migration-'));
    const databasePath = join(directory, 'migration.db');
    const db = new Database(databasePath);
    const migrationRoot = resolve(import.meta.dirname, '../../db/migrations');
    const baseSql = readFileSync(resolve(migrationRoot, '035_nova_audit.sql'), 'utf8');
    const epochSql = readFileSync(resolve(migrationRoot, '125_audit_epochs.sql'), 'utf8');
    try {
      db.exec(baseSql);
      const applyThenFail = db.transaction(() => {
        db.exec(epochSql);
        throw new Error('forced migration rollback');
      });
      expect(() => applyThenFail.immediate()).toThrow('forced migration rollback');

      const columnsAfterRollback = db.prepare('PRAGMA table_info(nova_audit_log)').all() as Array<{ name: string }>;
      expect(columnsAfterRollback.map(column => column.name)).not.toContain('epoch_id');
      expect(columnsAfterRollback.map(column => column.name)).not.toContain('chain_seq');
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='nova_audit_epochs'",
      ).get()).toEqual({ n: 0 });

      db.transaction(() => db.exec(epochSql)).immediate();
      const columnsAfterCommit = db.prepare('PRAGMA table_info(nova_audit_log)').all() as Array<{ name: string }>;
      expect(columnsAfterCommit.map(column => column.name)).toEqual(
        expect.arrayContaining(['epoch_id', 'chain_seq']),
      );
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='nova_audit_epochs'",
      ).get()).toEqual({ n: 1 });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
