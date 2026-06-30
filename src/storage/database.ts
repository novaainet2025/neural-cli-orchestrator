import Database from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { env, topology } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('database');

let db: Database.Database | null = null;
let dbPath: string | null = null;

function resolveDatabasePath(): string {
  return resolve(env.ROOT, process.env.DATABASE_PATH || topology.paths.database);
}

export function getDb(): Database.Database {
  const currentPath = resolveDatabasePath();

  if (db && dbPath !== currentPath) {
    db.close();
    db = null;
    log.info({ path: dbPath, nextPath: currentPath }, 'SQLite connection reset for updated DATABASE_PATH');
  }

  if (!db) {
    const dbDir = dirname(currentPath);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

    db = new Database(currentPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('cache_size = -64000'); // 64MB cache
    db.pragma('temp_store = MEMORY');
    db.pragma('mmap_size = 30000000000'); // 30GB mmap for 64-bit systems
    dbPath = currentPath;

    log.info({ path: currentPath }, 'SQLite connected (WAL mode)');
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    dbPath = null;
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

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(resolve(migrationsDir, file), 'utf-8');
    database.exec(sql);
    insertMigration.run(file);
    count++;
    log.info({ file }, 'Migration applied');
  }

  if (count > 0) {
    log.info({ count, total: files.length }, 'Migrations complete');
  } else {
    log.debug('All migrations up to date');
  }
}
