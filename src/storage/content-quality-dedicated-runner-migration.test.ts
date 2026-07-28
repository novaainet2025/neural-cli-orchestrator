import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  resolve(process.cwd(), 'db/migrations/097_content_quality_dedicated_runner.sql'),
  'utf-8',
);
const rollbackSql = `
  UPDATE teams
  SET
    charter = LTRIM(SUBSTR(LTRIM(charter), LENGTH('@전담러너') + 1)),
    updated_at = datetime('now')
  WHERE id = 'team_content-quality'
    AND LTRIM(charter) LIKE '@전담러너 %';
  UPDATE required_capabilities
  SET charter = LTRIM(SUBSTR(LTRIM(charter), LENGTH('@전담러너') + 1))
  WHERE id = 'team_content-quality'
    AND LTRIM(charter) LIKE '@전담러너 %';
`;

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE teams (
      id TEXT PRIMARY KEY,
      charter TEXT,
      is_always_on INTEGER NOT NULL,
      is_active INTEGER NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE required_capabilities (
      id TEXT PRIMARY KEY,
      charter TEXT NOT NULL,
      is_always_on INTEGER NOT NULL,
      protected INTEGER NOT NULL,
      is_active INTEGER NOT NULL
    );
  `);
  return db;
}

describe('097 content-quality dedicated runner migration', () => {
  it('marks only content-quality as dedicated without changing lifecycle fields', () => {
    const db = createDb();
    db.exec(`
      INSERT INTO teams VALUES
        ('team_content-quality', '검수 charter', 1, 1, '2026-07-28 00:00:00'),
        ('team_other', '다른 charter', 0, 1, '2026-07-28 00:00:00');
      INSERT INTO required_capabilities VALUES
        ('team_content-quality', '검수 charter', 1, 1, 1),
        ('team_other', '다른 charter', 0, 1, 1);
    `);

    db.exec(migrationSql);

    expect(db.prepare(`
      SELECT charter, is_always_on, is_active
      FROM teams
      WHERE id = 'team_content-quality'
    `).get()).toEqual({
      charter: '@전담러너 검수 charter',
      is_always_on: 1,
      is_active: 1,
    });
    expect(db.prepare(`
      SELECT charter, is_always_on, protected, is_active
      FROM required_capabilities
      WHERE id = 'team_content-quality'
    `).get()).toEqual({
      charter: '@전담러너 검수 charter',
      is_always_on: 1,
      protected: 1,
      is_active: 1,
    });
    expect(db.prepare(`
      SELECT charter, is_always_on, is_active
      FROM teams
      WHERE id = 'team_other'
    `).get()).toEqual({
      charter: '다른 charter',
      is_always_on: 0,
      is_active: 1,
    });

    db.close();
  });

  it('does not duplicate an existing dedicated-runner marker', () => {
    const db = createDb();
    db.exec(`
      INSERT INTO teams VALUES
        ('team_content-quality', '@전담러너 검수 charter', 1, 1, '2026-07-28 00:00:00');
      INSERT INTO required_capabilities VALUES
        ('team_content-quality', '@전담러너(daily-blog-promo.sh) 검수 charter', 1, 1, 1);
    `);

    db.exec(migrationSql);
    db.exec(migrationSql);

    expect(db.prepare(`
      SELECT charter
      FROM teams
      WHERE id = 'team_content-quality'
    `).pluck().get()).toBe('@전담러너 검수 charter');
    expect(db.prepare(`
      SELECT charter
      FROM required_capabilities
      WHERE id = 'team_content-quality'
    `).pluck().get()).toBe('@전담러너(daily-blog-promo.sh) 검수 charter');

    db.close();
  });

  it('supports a scoped rollback without changing lifecycle fields', () => {
    const db = createDb();
    db.exec(`
      INSERT INTO teams VALUES
        ('team_content-quality', '검수 charter', 1, 1, '2026-07-28 00:00:00');
      INSERT INTO required_capabilities VALUES
        ('team_content-quality', '검수 charter', 1, 1, 1);
    `);

    db.exec(migrationSql);
    db.exec(rollbackSql);

    expect(db.prepare(`
      SELECT charter, is_always_on, is_active
      FROM teams
      WHERE id = 'team_content-quality'
    `).get()).toEqual({
      charter: '검수 charter',
      is_always_on: 1,
      is_active: 1,
    });
    expect(db.prepare(`
      SELECT charter, is_always_on, protected, is_active
      FROM required_capabilities
      WHERE id = 'team_content-quality'
    `).get()).toEqual({
      charter: '검수 charter',
      is_always_on: 1,
      protected: 1,
      is_active: 1,
    });

    db.close();
  });
});
