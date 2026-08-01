import Database from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { env, topology } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('database');
const LEASE_TRACKING_MIGRATION = '073_tasks_lease_tracking.sql';
const WORKFLOW_SCHEMA_REPAIR_MIGRATION = '096_repair_explicit_workflow_schema.sql';

let db: Database.Database | null = null;

function assertTestDatabaseIsolation(databasePath: string): void {
  if (process.env.VITEST !== 'true') return;

  const productionPath = resolve(env.ROOT, topology.paths.database);
  if (resolve(databasePath) === productionPath) {
    throw new Error(
      `[database] Refusing to open the production database during Vitest: ${productionPath}`,
    );
  }
}

export function getDb(): Database.Database {
  if (!db) {
    const databasePath = env.DATABASE_PATH;
    assertTestDatabaseIsolation(databasePath);

    const dbDir = dirname(databasePath);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

    db = new Database(databasePath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    // 2026-07-31 이벤트루프 굶음 대응 (T1 실측 근거).
    // better-sqlite3 는 동기 API라 페이지를 디스크에서 읽는 동안 이벤트루프 전체가 멈춘다.
    // 사고 당시 db/nco.db 는 911MB(work_events 449MB/190k행)인데 SQLite 기본값이
    //   cache_size=2000 페이지(=4096B×2000 ≈ 8MB) · mmap_size=0
    // 이라 거의 모든 조회가 동기 pread 시스템콜로 내려갔다. 프로세스 스택 샘플(5초)에서
    // sqlite3 2158 프레임 / better_sqlite3 1547 / pread 88 프레임, 경로는
    // Statement::JS_all → sqlite3_step → sqlite3BtreeIndexMoveto → getAndInitPage → readDbPage.
    // 동일 쿼리 벤치: 8MB/mmap-off 평균 0.008s → 256MB/mmap-1G 평균 0.003s (2.7배).
    //
    // cache_size 는 음수를 주면 KiB 단위다(-262144 = 256MiB). mmap 은 읽기 경로의
    // pread 를 페이지폴트로 대체해 시스템콜 자체를 줄인다. 둘 다 환경변수로 조절 가능.
    const cacheKib = Number(process.env.NCO_SQLITE_CACHE_KIB) || 262_144;   // 256 MiB
    const mmapBytes = Number(process.env.NCO_SQLITE_MMAP_BYTES) || 1_073_741_824; // 1 GiB
    db.pragma(`cache_size = -${Math.max(2_048, Math.floor(cacheKib))}`);
    db.pragma(`mmap_size = ${Math.max(0, Math.floor(mmapBytes))}`);

    log.info({
      path: databasePath,
      cacheKib,
      mmapBytes,
    }, 'SQLite connected (WAL mode, tuned cache/mmap)');
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
