import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb, runMigrations, closeDb } from './database.js';
import { env } from '../utils/config.js';
import { unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';

describe('Database Storage', () => {
  const testDbPath = resolve(env.ROOT, 'db/test-nco.db');

  beforeAll(() => {
    process.env.DATABASE_PATH = testDbPath;
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  afterAll(() => {
    closeDb();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    delete process.env.DATABASE_PATH;
  });

  it('should initialize the database', () => {
    const db = getDb();
    expect(db).toBeDefined();
    expect(db.pragma('journal_mode')).toEqual([{ journal_mode: 'wal' }]);
  });

  it('should run migrations without error', () => {
    expect(() => runMigrations()).not.toThrow();
  });

  it('should have applied migrations', () => {
    const db = getDb();
    const rows = db.prepare('SELECT count(*) as count FROM schema_migrations').get() as { count: number };
    expect(rows.count).toBeGreaterThan(0);
  });
});
