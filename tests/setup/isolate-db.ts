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
// Fix: default DATABASE_PATH to a dedicated, migrated, test-only file unless
// a test explicitly overrides it (those tests keep managing their own
// isolated path exactly as before).
import { resolve } from 'path';

// Must set the env var — and only then import src/storage/database.js — because
// that import chain loads src/utils/config.js, which calls dotenv's
// config({path: '.env'}) as a side effect. dotenv does not override vars
// already present in process.env, but it WILL set DATABASE_PATH from .env
// (-> ./db/nco.db) if nothing has claimed it yet. A static top-level import
// here would run before this file's own body, defeating the `if (!...)` guard
// below — so the database module is imported dynamically, after the guard.
if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = resolve(import.meta.dirname, '../../db/.vitest-shared.db');
}

const { runMigrations, closeDb } = await import('../../src/storage/database.js');

// Ensure the shared test DB has schema applied, then release the singleton
// connection so the test file's own first getDb() call (whether it uses this
// default path or overrides DATABASE_PATH itself) opens fresh against
// whatever path is current at that point.
runMigrations();
closeDb();
