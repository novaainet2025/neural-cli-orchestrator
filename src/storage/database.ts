import Database from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { env } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('database');
const LEASE_TRACKING_MIGRATION = '073_tasks_lease_tracking.sql';
const WORKFLOW_SCHEMA_REPAIR_MIGRATION = '096_repair_explicit_workflow_schema.sql';

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
  const findMigration = database.prepare(
    'SELECT 1 FROM schema_migrations WHERE filename = ?'
  );
  const applyMigration = database.transaction((file: string, sql: string): 'applied' | 'marked' | 'skipped' => {
    // Another process may have applied this migration after the initial snapshot.
    // Recheck while holding the write reservation before executing non-idempotent SQL.
    if (findMigration.get(file)) return 'skipped';

    if (file === LEASE_TRACKING_MIGRATION && isLeaseTrackingMigrationSatisfied(database)) {
      insertMigration.run(file);
      return 'marked';
    }

    if (file === WORKFLOW_SCHEMA_REPAIR_MIGRATION) {
      ensureWorkflowLinkColumns(database);
    }

    database.exec(sql);
    insertMigration.run(file);
    return 'applied';
  });

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const migrationPath = resolve(migrationsDir, file);
    let sql: string;
    try {
      sql = readFileSync(migrationPath, 'utf-8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read migration ${file} at ${migrationPath}: ${message}`);
    }

    const outcome = applyMigration.immediate(file, sql);
    if (outcome === 'skipped') continue;

    count++;
    log.info(
      { file },
      outcome === 'marked' ? 'Migration marked applied (schema already satisfied)' : 'Migration applied',
    );
  }

  if (count > 0) {
    log.info({ count, total: files.length }, 'Migrations complete');
  } else {
    log.debug('All migrations up to date');
  }
}

function ensureColumn(
  database: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(entry => entry.name),
  );
  if (!columns.has(column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureWorkflowLinkColumns(database: Database.Database): void {
  ensureColumn(
    database,
    'tasks',
    'workflow_run_id',
    'TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL',
  );
  ensureColumn(
    database,
    'tasks',
    'workflow_stage',
    "TEXT CHECK(workflow_stage IN ('discussion','design','implementation','review','verification'))",
  );
  ensureColumn(database, 'discussions', 'team_id', 'TEXT REFERENCES teams(id) ON DELETE SET NULL');
  ensureColumn(database, 'discussions', 'company_run_id', 'TEXT');
  ensureColumn(
    database,
    'discussions',
    'workflow_run_id',
    'TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL',
  );
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
