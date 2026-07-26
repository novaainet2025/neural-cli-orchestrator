import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runTeamScoreDiagnostics,
  TEAM_DIAGNOSTIC_MAX_PER_RUN,
  type TeamDiagnosticRunOptions,
} from './cron-scheduler.js';
import type { TeamScore } from './team-scorer.js';
import { recordTeamDiagnosticOutcome } from './team-scorer.js';

describe('team score diagnostic cron', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE organizations (id TEXT PRIMARY KEY, is_active INTEGER NOT NULL);
      CREATE TABLE teams (
        id TEXT PRIMARY KEY, organization_id TEXT, lead TEXT, is_active INTEGER NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL,
        metadata_json TEXT, assigned_to TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE improvement_notes (
        id TEXT PRIMARY KEY, timestamp TEXT DEFAULT (datetime('now')),
        category TEXT NOT NULL, problem TEXT NOT NULL, root_cause TEXT NOT NULL,
        fix TEXT NOT NULL, verified_at TEXT, agent TEXT NOT NULL,
        severity TEXT NOT NULL, tags TEXT NOT NULL
      );
      INSERT INTO organizations (id, is_active) VALUES ('org_self', 1);
      INSERT INTO teams (id, organization_id, lead, is_active)
      VALUES ('team_self-improvement', 'org_self', 'codex', 1);
      INSERT INTO tasks (id, prompt, status, metadata_json)
      VALUES (
        'existing',
        '[자동 품질진단] target-team:low-0',
        'assigned',
        '{"diagnosticTargetSlug":"low-0"}'
      );
    `);
  });

  afterEach(() => db.close());

  it('creates only sampled low-score tasks while enforcing dedupe and the per-cycle cap', async () => {
    const scores: TeamScore[] = Array.from({ length: 7 }, (_, index) => ({
      teamId: `team_low_${index}`,
      slug: `low-${index}`,
      name: `Low ${index}`,
      organizationId: 'org_product',
      score: 40 + index,
      grade: 'F',
      completion: 40 + index,
      n: 2,
      maxN: 2,
      sample: '48h',
    }));
    scores.push({
      teamId: 'team_high',
      slug: 'high',
      name: 'High',
      organizationId: 'org_product',
      score: 90,
      grade: 'A',
      completion: 100,
      n: 2,
      maxN: 2,
      sample: '48h',
    });
    scores.push({
      teamId: 'team_unscored',
      slug: 'unscored',
      name: 'Unscored',
      organizationId: 'org_product',
      score: 0,
      grade: 'F',
      completion: 0,
      n: 0,
      maxN: 0,
      sample: 'all',
    });

    const submitted: Parameters<NonNullable<TeamDiagnosticRunOptions['submitTask']>>[0][] = [];
    const submitTask: NonNullable<TeamDiagnosticRunOptions['submitTask']> = vi.fn(async (payload) => {
      submitted.push(payload);
      return { ok: true, taskId: `created-${submitted.length}` };
    });

    const result = await runTeamScoreDiagnostics({
      database: db,
      scores,
      projectDir: '/workspace/nco',
      submitTask,
    });

    expect(result).toEqual({
      evaluated: 9,
      belowTarget: 7,
      created: TEAM_DIAGNOSTIC_MAX_PER_RUN,
      deduped: 1,
      capped: 1,
      failed: 0,
    });
    expect(submitted).toHaveLength(5);
    expect(submitted.every((payload) => payload.metadata.teamId === 'team_self-improvement')).toBe(true);
    expect(submitted.every((payload) => payload.metadata.projectDir === '/workspace/nco')).toBe(true);
    expect(submitted.every((payload) => payload.verifier.command === 'npm run build')).toBe(true);
    expect(submitted.some((payload) => payload.metadata.diagnosticTargetSlug === 'low-0')).toBe(false);
    expect(submitted.some((payload) => payload.metadata.diagnosticTargetSlug === 'high')).toBe(false);
    expect(submitted.some((payload) => payload.metadata.diagnosticTargetSlug === 'unscored')).toBe(false);

    const completed = submitted[0];
    db.prepare(`
      INSERT INTO tasks (id, prompt, status, metadata_json, assigned_to)
      VALUES (?, ?, 'completed', ?, ?)
    `).run('completed-diagnostic', completed.prompt, JSON.stringify(completed.metadata), completed.ai);
    expect(recordTeamDiagnosticOutcome(db, 'completed-diagnostic', 'verified diagnostic output')).toBe(true);
    expect(db.prepare(`
      SELECT category, fix, agent
      FROM improvement_notes
      WHERE id = 'team-score-diagnostic:completed-diagnostic'
    `).get()).toEqual({
      category: 'team-quality',
      fix: 'verified diagnostic output',
      agent: 'codex',
    });
  });

  it('does not treat score exactly at target as below target regardless of sample size', async () => {
    const scores: TeamScore[] = [
      {
        teamId: 'team_single',
        slug: 'single',
        name: 'Single',
        organizationId: 'org_product',
        score: 90,
        grade: 'A',
        completion: 100,
        n: 1,
        maxN: 10,
        sample: 'all',
      },
      {
        teamId: 'team_two',
        slug: 'two',
        name: 'Two',
        organizationId: 'org_product',
        score: 90,
        grade: 'A',
        completion: 100,
        n: 2,
        maxN: 10,
        sample: '48h',
      },
    ];
    const submitted: Parameters<NonNullable<TeamDiagnosticRunOptions['submitTask']>>[0][] = [];

    const result = await runTeamScoreDiagnostics({
      database: db,
      scores,
      projectDir: '/workspace/nco',
      submitTask: async (payload) => {
        submitted.push(payload);
        return { ok: true, taskId: 'created-team-two' };
      },
    });

    expect(result).toEqual({
      evaluated: 2,
      belowTarget: 0,
      created: 0,
      deduped: 0,
      capped: 0,
      failed: 0,
    });
    expect(submitted).toHaveLength(0);
  });
});
