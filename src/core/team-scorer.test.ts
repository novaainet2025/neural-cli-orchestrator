import Database from 'better-sqlite3';
import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeOrganizationScores, computeTeamScores } from './team-scorer.js';
import { registerTeamScoreRoutes } from '../server/routes/team-scores.js';

describe('team score aggregation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE organizations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE teams (
        id TEXT PRIMARY KEY, organization_id TEXT, name TEXT NOT NULL,
        slug TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, team_id TEXT, status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO organizations (id, name, is_active) VALUES
        ('org_active', 'Active Org', 1),
        ('org_inactive', 'Inactive Org', 0);
      INSERT INTO teams (id, organization_id, name, slug, is_active) VALUES
        ('team_alpha', 'org_active', 'Alpha', 'alpha', 1),
        ('team_beta', 'org_active', 'Beta', 'beta', 1),
        ('team_inactive', 'org_active', 'Inactive Team', 'inactive-team', 0),
        ('team_hidden', 'org_inactive', 'Hidden Team', 'hidden-team', 1);
    `);

    const insert = db.prepare(`
      INSERT INTO tasks (id, team_id, status, created_at)
      VALUES (?, ?, ?, datetime('now', ?))
    `);
    const insertWithError = db.prepare(`
      INSERT INTO tasks (id, team_id, status, error, created_at)
      VALUES (?, ?, ?, ?, datetime('now', ?))
    `);
    insert.run('a1', 'team_alpha', 'completed', '-1 hour');
    insert.run('a2', 'team_alpha', 'completed', '-2 hours');
    insert.run('a3', 'team_alpha', 'completed', '-3 hours');
    insert.run('a4', 'team_alpha', 'failed', '-4 hours');
    insert.run('a-running', 'team_alpha', 'running', '-1 hour');
    // 인프라 기인 실패(서버 재시작 orphan)는 completion 분모에서 제외되어야 한다.
    // 이 행이 카운트되면 alpha n=5·completion=60이 되어 아래 기대값(n=4·completion=75)이 깨진다.
    insertWithError.run(
      'a-orphan', 'team_alpha', 'failed',
      'orphaned: server restart (poison — requeued 2x)', '-2 hours',
    );

    insert.run('b1', 'team_beta', 'completed', '-1 hour');
    insert.run('b2', 'team_beta', 'failed', '-3 days');
    insert.run('inactive-1', 'team_inactive', 'completed', '-1 hour');
    insert.run('hidden-1', 'team_hidden', 'completed', '-1 hour');
  });

  afterEach(() => db.close());

  it('aggregates scores and serves the live team and organization arrays', async () => {
    const teams = computeTeamScores(db);

    expect(teams).toEqual([
      {
        teamId: 'team_alpha',
        slug: 'alpha',
        name: 'Alpha',
        organizationId: 'org_active',
        score: 77.5,
        grade: 'C',
        completion: 75,
        n: 4,
        sample: '48h',
      },
      {
        teamId: 'team_beta',
        slug: 'beta',
        name: 'Beta',
        organizationId: 'org_active',
        score: 50,
        grade: 'F',
        completion: 50,
        n: 2,
        sample: '7d',
      },
    ]);

    expect(computeOrganizationScores(db, teams)).toEqual([
      {
        orgId: 'org_active',
        name: 'Active Org',
        score: 63.8,
        grade: 'D',
        teams: 2,
        belowTarget: [
          { teamId: 'team_alpha', slug: 'alpha', name: 'Alpha', score: 77.5, grade: 'C' },
          { teamId: 'team_beta', slug: 'beta', name: 'Beta', score: 50, grade: 'F' },
        ],
      },
    ]);

    const app = fastify({ logger: false });
    await registerTeamScoreRoutes(app, db);
    const [teamResponse, organizationResponse] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/teams/scores' }),
      app.inject({ method: 'GET', url: '/api/org/scores' }),
    ]);
    expect(teamResponse.statusCode).toBe(200);
    expect(teamResponse.json()).toEqual(teams);
    expect(organizationResponse.statusCode).toBe(200);
    expect(organizationResponse.json()[0]).toMatchObject({
      orgId: 'org_active',
      score: 63.8,
      grade: 'D',
      teams: 2,
    });
    await app.close();
  });
});
