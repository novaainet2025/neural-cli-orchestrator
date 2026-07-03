import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('068_acquisitions migration', () => {
  it('creates acquisitions table and indexes', () => {
    const db = new Database(':memory:');
    const sql = readFileSync(resolve(process.cwd(), 'db/migrations/068_acquisitions.sql'), 'utf-8');

    db.exec(sql);

    const table = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'acquisitions'
    `).get() as { name?: string } | undefined;
    const indexes = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'acquisitions'
      ORDER BY name
    `).all() as Array<{ name: string }>;

    expect(table?.name).toBe('acquisitions');
    expect(indexes.map(index => index.name)).toEqual([
      'idx_acq_decision',
      'idx_acq_pkg_ver',
      'sqlite_autoindex_acquisitions_1',
    ]);
  });
});
