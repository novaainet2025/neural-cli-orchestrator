import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../src/storage/database.js';
import { topology } from '../src/utils/config.js';

describe('Vitest database isolation guard', () => {
  const isolatedDatabasePath = process.env.DATABASE_PATH;

  afterEach(() => {
    closeDb();
    if (isolatedDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = isolatedDatabasePath;
  });

  it('fails closed before opening the configured production database', () => {
    closeDb();
    process.env.DATABASE_PATH = topology.paths.database;

    expect(() => getDb()).toThrow(/Refusing to open the production database during Vitest/);
  });
});
