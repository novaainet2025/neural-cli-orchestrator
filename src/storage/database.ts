import Database from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { env } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('database');
const LEASE_TRACKING_MIGRATION = '073_tasks_lease_tracking.sql';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dbDir = dirname(env.DATABASE_PATH);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

    db = new Database(env.DATABASE_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    log.info({ path: env.DATABASE_PATH }, 'SQLite connected (WAL mode)');
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    log.info('SQLite closed');
  }
}

// ─── Migration Runner ─────────────────────────────────
export function runMigrations(): void {
  const database = getDb();

  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const migrationsDir = resolve(env.ROOT, 'db/migrations');
  if (!existsSync(migrationsDir)) {
    log.warn('No migrations directory found');
    return;
  }

  const applied = new Set(
    database.prepare('SELECT filename FROM schema_migrations').all()
      .map((row: any) => row.filename)
  );

  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const insertMigration = database.prepare(
    'INSERT INTO schema_migrations (filename) VALUES (?)'
  );
  const markMigrationApplied = (file: string) => {
    insertMigration.run(file);
  };
  const applyMigration = database.transaction((file: string, sql: string) => {
    database.exec(sql);
    insertMigration.run(file);
  });

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    if (file === LEASE_TRACKING_MIGRATION && isLeaseTrackingMigrationSatisfied(database)) {
      markMigrationApplied(file);
      count++;
      log.info({ file }, 'Migration marked applied (schema already satisfied)');
      continue;
    }

    const migrationPath = resolve(migrationsDir, file);
    let sql: string;
    try {
      sql = readFileSync(migrationPath, 'utf-8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read migration ${file} at ${migrationPath}: ${message}`);
    }

    applyMigration(file, sql);
    count++;
    log.info({ file }, 'Migration applied');
  }

  if (count > 0) {
    log.info({ count, total: files.length }, 'Migrations complete');
  } else {
    log.debug('All migrations up to date');
  }
}

function isLeaseTrackingMigrationSatisfied(database: Database.Database): boolean {
  const columns = new Set(
    (database.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>)
      .map(column => column.name)
  );
  const requiredColumns = ['acked_at', 'last_heartbeat_at', 'heartbeat_seq', 'lease_expires_at'];
  if (!requiredColumns.every(column => columns.has(column))) {
    return false;
  }

  const tableRow = database.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'tasks'
  `).get() as { sql: string | null } | undefined;
  return Boolean(tableRow?.sql?.includes('lease_expired'));
}
