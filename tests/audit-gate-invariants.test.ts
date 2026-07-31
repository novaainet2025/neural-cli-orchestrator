import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAuditApprovedCompletion,
  computeTeamScores,
  gradeTeamScore,
} from '../src/core/team-scorer.js';

/**
 * Invariant tests for AUDIT_APPROVED_COMPLETION gate.
 * Kept separate from src/core/team-scorer.test.ts to avoid lease contention
 * while another session edits the scorer implementation.
 *
 * AP KPI baseline (CommandGate-safe): npx tsx scripts/audit-pipeline-health.ts
 */
describe('audit gate invariants', () => {
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
        error TEXT, response TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        lease_expires_at TEXT,
        result_json TEXT,
        spawned_by_cli TEXT,
        acked_at TEXT,
        last_heartbeat_at TEXT,
        metadata_json TEXT,
        system_prompt TEXT,
        orphan_requeue_count INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO organizations (id, name, is_active) VALUES ('org_active', 'Active Org', 1);
      INSERT INTO teams (id, organization_id, name, slug, is_active)
      VALUES ('team_audit_gate', 'org_active', 'Audit Gate', 'audit-gate', 1);
    `);
  });

  afterEach(() => db.close());

  function insertCompleted(
    id: string,
    metadata: Record<string, unknown> | null,
    response = 'substantive result',
  ): void {
    db.prepare(`
      INSERT INTO tasks (id, team_id, status, response, metadata_json, created_at)
      VALUES (?, 'team_audit_gate', 'completed', ?, ?, datetime('now'))
    `).run(id, response, metadata ? JSON.stringify(metadata) : null);
  }

  it('counts legacy completions without audit markers', () => {
    insertCompleted('legacy-a', null);
    insertCompleted('legacy-b', null);
    insertCompleted('legacy-failed', null);
    db.prepare("UPDATE tasks SET status='failed' WHERE id='legacy-failed'").run();

    const team = computeTeamScores(db).find((row) => row.teamId === 'team_audit_gate');
    expect(team).toMatchObject({
      completion: 66.7,
      n: 3,
      sample: '48h',
    });
    expect(gradeTeamScore(team?.score ?? 0)).not.toBe('F');
  });

  it('requires Nova-AX receipts only for marked audit tasks', () => {
    insertCompleted('audit-approved', {
      organizationAuditRequired: true,
      verificationStatus: 'approved',
      verificationReceiptId: 'receipt-approved',
    });
    insertCompleted('audit-pending', {
      organizationAuditRequired: true,
      verificationStatus: 'pending',
    });
    insertCompleted('audit-marker-only', {
      organizationAuditRequired: true,
    });
    insertCompleted('audit-rejected', {
      organizationAuditRequired: true,
      verificationStatus: 'rejected',
    });
    insertCompleted('audit-legacy', null);
    insertCompleted('audit-control-plane', {
      auditControlPlane: true,
      verificationStatus: 'approved',
      verificationReceiptId: 'control-receipt',
    });

    const team = computeTeamScores(db).find((row) => row.teamId === 'team_audit_gate');
    // pending injection + legacy + approved count; rejected post-audit does not.
    expect(team).toMatchObject({
      completion: 80,
      n: 5,
      sample: '48h',
    });
  });

  it('never reports completion above 100 percent', () => {
    insertCompleted('only-completed', null);
    db.prepare(`
      INSERT INTO tasks (id, team_id, status, error, created_at)
      VALUES ('only-failed', 'team_audit_gate', 'failed', 'boom', datetime('now'))
    `).run();

    const team = computeTeamScores(db).find((row) => row.teamId === 'team_audit_gate');
    expect(team?.completion).toBeLessThanOrEqual(100);
    expect(team?.n).toBeGreaterThan(0);
  });

  it('counts strategic command work-report completions with enqueue audit intent only', () => {
    db.prepare(`
      INSERT INTO organizations (id, name, is_active)
      VALUES ('org_nco-command', 'NCO Command', 1)
    `).run();
    db.prepare(`
      INSERT INTO teams (id, organization_id, name, slug, is_active)
      VALUES ('team_gov-command-strategic', 'org_nco-command', 'Strategic Command', 'gov-command-strategic', 1)
    `).run();
    const insert = db.prepare(`
      INSERT INTO tasks (id, team_id, status, response, metadata_json, created_at)
      VALUES (?, 'team_gov-command-strategic', 'completed', ?, ?, datetime('now'))
    `);
    insert.run(
      'strategic-wr-am',
      '# Strategic Command AM report\nsubstantive body',
      JSON.stringify({ organizationAuditRequired: true, workReportId: 'wr_strategic_am' }),
    );
    insert.run(
      'strategic-wr-pm',
      '# Strategic Command PM report\nsubstantive body',
      JSON.stringify({
        organizationAuditRequired: true,
        verificationStatus: 'pending',
        workReportId: 'wr_strategic_pm',
      }),
    );
    insert.run(
      'strategic-audit-rejected',
      'partial',
      JSON.stringify({ organizationAuditRequired: true, verificationStatus: 'rejected' }),
    );

    const team = computeTeamScores(db).find((row) => row.teamId === 'team_gov-command-strategic');
    expect(team).toMatchObject({
      completion: 66.7,
      n: 3,
      sample: '48h',
    });
  });

  it('disables the gate when NCO_SCORER_AUDIT_APPROVAL_GATE=off', () => {
    insertCompleted('audit-pending', {
      organizationAuditRequired: true,
      verificationStatus: 'pending',
    });
    insertCompleted('audit-legacy', null);

    const previous = process.env.NCO_SCORER_AUDIT_APPROVAL_GATE;
    process.env.NCO_SCORER_AUDIT_APPROVAL_GATE = 'off';
    try {
      const team = computeTeamScores(db).find((row) => row.teamId === 'team_audit_gate');
      expect(team).toMatchObject({
        completion: 100,
        n: 2,
        sample: '48h',
      });
    } finally {
      if (previous === undefined) delete process.env.NCO_SCORER_AUDIT_APPROVAL_GATE;
      else process.env.NCO_SCORER_AUDIT_APPROVAL_GATE = previous;
    }
  });

  it('exports a non-empty SQL fragment when the gate is enabled', () => {
    expect(buildAuditApprovedCompletion('on').trim().length).toBeGreaterThan(0);
    expect(buildAuditApprovedCompletion('off')).toBe('');
    expect(buildAuditApprovedCompletion('false')).toBe('');
  });
});
