// Vitest setupFile — runs before every test file's imports.
//
// Root cause: getDb() (src/storage/database.ts) is a lazy singleton that falls
// back to topology.paths.database (./db/nco.db) — the SAME file the running
// dev NCO gateway uses — whenever a test doesn't explicitly set
// process.env.DATABASE_PATH itself. Several test files (e.g.
// tests/security-policy-v1.1.test.ts) DELETE FROM + INSERT fixture rows
// straight into that shared DB in beforeAll, corrupting live data (verified:
// nova_audit_log Merkle chain broken by literal 'hash'/'prev' placeholder
// rows leaking into db/nco.db).
//
// Fix: force DATABASE_PATH to a dedicated, migrated, per-file test database.
// Tests that explicitly override it after setup keep managing their own path.
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll } from 'vitest';

// Must set the env var — and only then import src/storage/database.js — because
// that import chain loads src/utils/config.js, which calls dotenv's
// config({path: '.env'}) as a side effect. dotenv does not override vars
// already present in process.env, but it WILL set DATABASE_PATH from .env
// (-> ./db/nco.db) if nothing has claimed it yet. A static top-level import
// here would run before this file's own body, defeating the `if (!...)` guard
// below — so the database module is imported dynamically, after the guard.
// Always override DATABASE_PATH. `npm run test:run` is wrapped by
// run-with-work-event.ts, which loads .env before it spawns Vitest and therefore
// used to leak the production db/nco.db path into every test process.
//
// A unique file per setup invocation also prevents concurrently executing test
// files from contaminating each other's fixed fixture ids and migration state.
const projectRoot = resolve(import.meta.dirname, '../..');
const topology = JSON.parse(
  readFileSync(resolve(projectRoot, 'config/topology.json'), 'utf8'),
) as { paths: { database: string } };
const inheritedDatabasePath = resolve(
  projectRoot,
  process.env.DATABASE_PATH || topology.paths.database,
);
const isolatedDbPath = process.env.NCO_TEST_DATABASE_PATH
  ? resolve(process.env.NCO_TEST_DATABASE_PATH)
  : resolve(
      tmpdir(),
      'nco-vitest-databases',
      `${process.pid}-${randomUUID()}.db`,
    );

if (isolatedDbPath === inheritedDatabasePath) {
  throw new Error(
    `[vitest] NCO_TEST_DATABASE_PATH must not target the production database: ${inheritedDatabasePath}`,
  );
}
process.env.DATABASE_PATH = isolatedDbPath;

const { runMigrations, closeDb } = await import('../../src/storage/database.js');

// Ensure the shared test DB has schema applied, then release the singleton
// connection so the test file's own first getDb() call (whether it uses this
// default path or overrides DATABASE_PATH itself) opens fresh against
// whatever path is current at that point.
runMigrations();
closeDb();

afterAll(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${isolatedDbPath}${suffix}`, { force: true });
  }
});
