import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isTeamCircuitGuardEnabled,
  isTeamCircuitOpen,
  refreshTeamCircuitFromRecentFailures,
  teamCircuitAgentId,
} from './team-circuit-guard.js';

describe('team circuit guard', () => {
  let db: Database.Database;
  const originalToggle = process.env.NCO_TEAM_CIRCUIT_GUARD;

  beforeEach(() => {
    process.env.NCO_TEAM_CIRCUIT_GUARD = 'on';
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        team_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE circuit_states (
        agent_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        failure_count INTEGER NOT NULL,
        opened_at INTEGER,
        cooldown_until INTEGER,
        reason TEXT
      );
    `);
  });

  afterEach(() => {
    db.close();
    if (originalToggle === undefined) delete process.env.NCO_TEAM_CIRCUIT_GUARD;
    else process.env.NCO_TEAM_CIRCUIT_GUARD = originalToggle;
  });

  it('opens a team circuit after repeated identical failures', () => {
    const insert = db.prepare(`
      INSERT INTO tasks (id, team_id, status, error, created_at)
      VALUES (?, 'team_cli-assurance-2026', 'failed', ?, datetime('now'))
    `);
    insert.run('task-1', 'failure-pattern: agent reported error');
    insert.run('task-2', 'failure-pattern: agent reported error');

    const opened = refreshTeamCircuitFromRecentFailures(db, 'team_cli-assurance-2026');
    expect(opened).toBe(true);
    expect(isTeamCircuitOpen('team_cli-assurance-2026', db)).toBe(true);
    expect(teamCircuitAgentId('team_cli-assurance-2026')).toBe('team:team_cli-assurance-2026');
  });

  it('does nothing when the guard is disabled', () => {
    process.env.NCO_TEAM_CIRCUIT_GUARD = 'off';
    expect(isTeamCircuitGuardEnabled()).toBe(false);
    expect(refreshTeamCircuitFromRecentFailures(db, 'team_cli-assurance-2026')).toBe(false);
  });
});
