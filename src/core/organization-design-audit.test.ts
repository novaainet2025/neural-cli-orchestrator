import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runOrganizationDesignAudit } from './organization-design-audit.js';

function createSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      role TEXT NOT NULL,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER DEFAULT 1,
      removed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      graph_type TEXT NOT NULL DEFAULT 'nova-ax',
      manager TEXT,
      parent_id TEXT REFERENCES organizations(id),
      is_always_on INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE teams (
      id TEXT PRIMARY KEY,
      organization_id TEXT REFERENCES organizations(id),
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      color TEXT,
      lead TEXT,
      charter TEXT,
      is_always_on INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE team_members (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      member_type TEXT NOT NULL CHECK(member_type IN ('provider','session','nco-session')),
      member_ref TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(team_id, member_type, member_ref)
    );

    CREATE TABLE team_lifecycle_profiles (
      team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active',
      protected INTEGER NOT NULL DEFAULT 0,
      improvement_count INTEGER NOT NULL DEFAULT 0,
      successful_improvement_count INTEGER NOT NULL DEFAULT 0,
      failed_improvement_count INTEGER NOT NULL DEFAULT 0,
      unresolved_improvement_count INTEGER NOT NULL DEFAULT 0,
      consecutive_low_checks INTEGER NOT NULL DEFAULT 0,
      last_score REAL,
      last_sample_size INTEGER NOT NULL DEFAULT 0,
      first_low_at TEXT,
      last_checked_at TEXT,
      last_improvement_at TEXT,
      active_run_id TEXT,
      retired_at TEXT,
      retirement_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE required_organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      graph_type TEXT NOT NULL,
      manager TEXT,
      parent_id TEXT,
      is_always_on INTEGER NOT NULL,
      is_active INTEGER NOT NULL
    );

    CREATE TABLE required_capabilities (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT NOT NULL,
      color TEXT NOT NULL,
      lead TEXT NOT NULL,
      charter TEXT NOT NULL,
      is_always_on INTEGER NOT NULL,
      protected INTEGER NOT NULL,
      is_active INTEGER NOT NULL
    );

    CREATE TABLE organization_design_audits (
      id TEXT PRIMARY KEY,
      audit_time TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      active_organizations INTEGER NOT NULL DEFAULT 0,
      active_teams INTEGER NOT NULL DEFAULT 0,
      org_expected INTEGER NOT NULL DEFAULT 0,
      org_present INTEGER NOT NULL DEFAULT 0,
      org_repaired INTEGER NOT NULL DEFAULT 0,
      cap_expected INTEGER NOT NULL DEFAULT 0,
      cap_present INTEGER NOT NULL DEFAULT 0,
      cap_repaired INTEGER NOT NULL DEFAULT 0,
      members_before_zero INTEGER NOT NULL DEFAULT 0,
      members_before_one INTEGER NOT NULL DEFAULT 0,
      members_before_two INTEGER NOT NULL DEFAULT 0,
      members_after_coverage INTEGER NOT NULL DEFAULT 0,
      collaboration_coverage_before REAL NOT NULL DEFAULT 0,
      collaboration_coverage_after REAL NOT NULL DEFAULT 0,
      missing_lead_before INTEGER NOT NULL DEFAULT 0,
      missing_lead_after INTEGER NOT NULL DEFAULT 0,
      missing_charter_before INTEGER NOT NULL DEFAULT 0,
      missing_charter_after INTEGER NOT NULL DEFAULT 0,
      excess_json TEXT NOT NULL DEFAULT '[]',
      actions_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE team_consolidations (
      id TEXT PRIMARY KEY,
      old_team_id TEXT UNIQUE NOT NULL,
      new_team_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      consolidated_at TEXT NOT NULL
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      team_id TEXT REFERENCES teams(id),
      status TEXT NOT NULL DEFAULT 'pending',
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function insertEnabledGeneralAgents(db: Database.Database) {
  const agents = [
    { id: 'ollama', name: 'Ollama', type: 'api', role: 'general', capabilities: '["code","analysis","reasoning","review"]' },
    { id: 'codex', name: 'Codex', type: 'cli', role: 'general', capabilities: '["code","architecture","testing"]' },
    { id: 'cursor-agent', name: 'Cursor Agent', type: 'cli', role: 'general', capabilities: '["code","review","debugging"]' },
    { id: 'hermes', name: 'Hermes', type: 'cli', role: 'general', capabilities: '["tool-use","function-calling","decision"]' },
  ];
  const insert = db.prepare(`INSERT INTO agents (id, name, type, role, capabilities_json, enabled) VALUES (?, ?, ?, ?, ?, 1)`);
  for (const a of agents) insert.run(a.id, a.name, a.type, a.role, a.capabilities);
}

describe('organization-design-audit correctness', () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
  });

  describe('case 1: required org missing + required team missing/inactive -> active/protected', () => {
    beforeEach(() => {
      db = new Database(':memory:');
      createSchema(db);
      insertEnabledGeneralAgents(db);

      db.prepare(`INSERT INTO required_organizations VALUES (?,?,?,?,?,?,?,?)`)
        .run('org_nco-command', 'NCO Command', 'nco-command', 'nova-ax', 'claude-code', null, 1, 1);
      db.prepare(`INSERT INTO required_organizations VALUES (?,?,?,?,?,?,?,?)`)
        .run('org_nco-evolution', 'NCO Evolution', 'nco-evolution', 'nova-ax', 'opencode', null, 1, 1);

      db.prepare(`INSERT INTO required_capabilities VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run('team_gov-command-strategic', 'org_nco-command', 'Strategic', 'strategic', 'desc', '#000', 'ollama', 'charter', 1, 1, 1);
      db.prepare(`INSERT INTO required_capabilities VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run('team_gov-command-intake', 'org_nco-command', 'Intake', 'intake', 'desc', '#001', 'codex', 'charter', 1, 1, 1);

      db.prepare(`INSERT INTO organizations (id,name,slug,graph_type,is_always_on,is_active) VALUES (?,?,?,?,?,?)`)
        .run('org_nco-evolution', 'NCO Evolution', 'nco-evolution', 'nova-ax', 1, 1);
      db.prepare(`INSERT INTO teams (id,organization_id,name,slug,description,color,lead,charter,is_always_on,is_active) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('team_gov-command-strategic', 'org_nco-evolution', 'Strategic', 'strategic', 'desc', '#000', 'ollama', 'charter', 1, 1);
      db.prepare(`INSERT INTO team_lifecycle_profiles (team_id,status,protected) VALUES (?,?,?)`)
        .run('team_gov-command-strategic', 'active', 1);
    });

    it('repairs missing org and missing/inactive teams to active+protected', () => {
      const result = runOrganizationDesignAudit({ database: db, now: new Date('2026-07-27T00:00:00Z'), source: 'manual', repair: true });

      expect(result.orgExpected).toBe(2);
      expect(result.orgRepaired).toBe(1);
      expect(result.orgPresent).toBe(2);

      expect(result.capExpected).toBe(2);
      expect(result.capRepaired).toBe(1);
      expect(result.capPresent).toBe(2);

      const createdOrg = db.prepare(`SELECT is_active FROM organizations WHERE id=?`).get('org_nco-command') as any;
      expect(createdOrg?.is_active).toBe(1);

      const createdTeam = db.prepare(`SELECT is_active FROM teams WHERE id=?`).get('team_gov-command-intake') as any;
      expect(createdTeam?.is_active).toBe(1);

      const profile = db.prepare(`SELECT status,protected FROM team_lifecycle_profiles WHERE team_id=?`).get('team_gov-command-intake') as any;
      expect(profile?.status).toBe('active');
      expect(profile?.protected).toBe(1);

      const auditCount = db.prepare(`SELECT COUNT(*) AS cnt FROM organization_design_audits`).get() as any;
      expect(auditCount.cnt).toBe(1);

      expect(result.activeOrganizations).toBe(3);
      expect(result.activeTeams).toBeGreaterThanOrEqual(2);
    });
  });

  describe('case 2: provider members 0/1/2 -> each team >=3 + lead/charter', () => {
    beforeEach(() => {
      db = new Database(':memory:');
      createSchema(db);
      insertEnabledGeneralAgents(db);

      db.prepare(`INSERT INTO required_organizations VALUES (?,?,?,?,?,?,?,?)`)
        .run('org_test', 'Test', 'test', 'nova-ax', null, null, 1, 1);
      for (const [slug, leadIn, charterIn] of [['team_test-a', '', ''], ['team_test-b', '', ''], ['team_test-c', '', '']])
        db.prepare(`INSERT INTO required_capabilities VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(slug, 'org_test', slug, slug, 'desc', '#000', leadIn, charterIn, 1, 1, 1);

      db.prepare(`INSERT INTO organizations (id,name,slug,graph_type,is_always_on,is_active) VALUES (?,?,?,?,?,?)`)
        .run('org_test', 'Test', 'test', 'nova-ax', 1, 1);

      db.prepare(`INSERT INTO teams (id,organization_id,name,slug,description,color,lead,charter,is_always_on,is_active) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('team_test-a', 'org_test', 'A', 'team-a', 'desc', '#000', null, null, 1, 1);

      db.prepare(`INSERT INTO teams (id,organization_id,name,slug,description,color,lead,charter,is_always_on,is_active) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('team_test-b', 'org_test', 'B', 'team-b', 'desc', '#001', null, null, 1, 1);
      db.prepare(`INSERT INTO team_members (id,team_id,member_type,member_ref) VALUES (?,?,?,?)`)
        .run('tm_b_h', 'team_test-b', 'provider', 'hermes');

      db.prepare(`INSERT INTO teams (id,organization_id,name,slug,description,color,lead,charter,is_always_on,is_active) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('team_test-c', 'org_test', 'C', 'team-c', 'desc', '#002', null, null, 1, 1);
      db.prepare(`INSERT INTO team_members (id,team_id,member_type,member_ref) VALUES (?,?,?,?)`)
        .run('tm_c_h', 'team_test-c', 'provider', 'hermes');
      db.prepare(`INSERT INTO team_members (id,team_id,member_type,member_ref) VALUES (?,?,?,?)`)
        .run('tm_c_c', 'team_test-c', 'provider', 'codex');
    });

    it('fills members to >=3 and assigns lead+charter to all teams', () => {
      const result = runOrganizationDesignAudit({ database: db, now: new Date('2026-07-27T00:00:00Z'), source: 'manual', repair: true });

      expect(result.membersBeforeZero).toBe(1);
      expect(result.membersBeforeOne).toBe(1);
      expect(result.membersBeforeTwo).toBe(1);
      expect(result.membersAfterCoverage).toBe(result.activeTeams);
      expect(result.missingLeadAfter).toBe(0);
      expect(result.missingCharterAfter).toBe(0);

      for (const teamId of ['team_test-a', 'team_test-b', 'team_test-c']) {
        const cnt = db.prepare(
          `SELECT COUNT(*) AS cnt FROM team_members tm
           JOIN agents a ON a.id = tm.member_ref
           WHERE tm.team_id=? AND tm.member_type='provider'
           AND a.enabled=1 AND a.removed_at IS NULL`
        ).get(teamId) as any;
        expect(cnt.cnt).toBe(3);

        const t = db.prepare(`SELECT lead,charter FROM teams WHERE id=?`).get(teamId) as any;
        expect(t.lead).toBeTruthy();
        expect(t.charter).toBeTruthy();
      }
    });
  });

  describe('case 3: team with task 0 -> candidate, NOT deactivated', () => {
    beforeEach(() => {
      db = new Database(':memory:');
      createSchema(db);
      insertEnabledGeneralAgents(db);

      db.prepare(`INSERT INTO required_organizations VALUES (?,?,?,?,?,?,?,?)`)
        .run('org_test', 'Test', 'test', 'nova-ax', null, null, 1, 1);
      db.prepare(`INSERT INTO required_capabilities VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run('team_req', 'org_test', 'Req', 'req', 'desc', '#000', 'ollama', 'charter', 1, 1, 1);

      db.prepare(`INSERT INTO organizations (id,name,slug,graph_type,is_always_on,is_active) VALUES (?,?,?,?,?,?)`)
        .run('org_test', 'Test', 'test', 'nova-ax', 1, 1);
      db.prepare(`INSERT INTO teams (id,organization_id,name,slug,description,color,lead,charter,is_always_on,is_active) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('team_req', 'org_test', 'Req', 'req', 'desc', '#000', 'ollama', 'charter', 1, 1);
      for (const m of ['ollama', 'codex', 'cursor-agent'])
        db.prepare(`INSERT INTO team_members (id,team_id,member_type,member_ref) VALUES (?,?,?,?)`)
          .run(`tm_req_${m}`, 'team_req', 'provider', m);

      db.prepare(`INSERT INTO teams (id,organization_id,name,slug,description,color,lead,charter,is_always_on,is_active) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('team_extra', 'org_test', 'Extra', 'extra', 'desc', '#111', 'ollama', 'charter', 0, 1);
      for (const m of ['hermes', 'codex', 'cursor-agent'])
        db.prepare(`INSERT INTO team_members (id,team_id,member_type,member_ref) VALUES (?,?,?,?)`)
          .run(`tm_ex_${m}`, 'team_extra', 'provider', m);
    });

    it('flags zero-task team as excess candidate but keeps it active', () => {
      const result = runOrganizationDesignAudit({ database: db, now: new Date('2026-07-27T00:00:00Z'), source: 'manual', repair: true });

      expect(result.excessCandidates.length).toBe(1);
      expect(result.excessCandidates[0].teamId).toBe('team_extra');
      expect(result.excessCandidates[0].reason).toContain('zero tasks');

      const team = db.prepare(`SELECT is_active FROM teams WHERE id=?`).get('team_extra') as any;
      expect(team.is_active).toBe(1);

      expect(result.status).toBe('attention');
    });
  });

  describe('case 4: KD old 5 teams -> inactive + target team + 5 receipts', () => {
    beforeEach(() => {
      db = new Database(':memory:');
      createSchema(db);
      insertEnabledGeneralAgents(db);

      db.prepare(`INSERT INTO required_organizations VALUES (?,?,?,?,?,?,?,?)`)
        .run('org_test', 'Test', 'test', 'nova-ax', null, null, 1, 1);
      db.prepare(`INSERT INTO required_capabilities VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run('team_req', 'org_test', 'Req', 'req', 'desc', '#000', 'ollama', 'charter', 1, 1, 1);

      db.prepare(`INSERT INTO organizations (id,name,slug,graph_type,is_always_on,is_active) VALUES (?,?,?,?,?,?)`)
        .run('org_test', 'Test', 'test', 'nova-ax', 1, 1);
      db.prepare(`INSERT INTO teams (id,organization_id,name,slug,description,color,lead,charter,is_always_on,is_active) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('team_req', 'org_test', 'Req', 'req', 'desc', '#000', 'ollama', 'charter', 1, 1);
      for (const m of ['ollama', 'codex', 'cursor-agent'])
        db.prepare(`INSERT INTO team_members (id,team_id,member_type,member_ref) VALUES (?,?,?,?)`)
          .run(`tm_req_${m}`, 'team_req', 'provider', m);

      for (const oldId of ['team_kd-harness', 'team_kd-memory', 'team_kd-obsidian', 'team_kd-prompt', 'team_kd-provider']) {
        db.prepare(`INSERT INTO teams (id,organization_id,name,slug,description,color,lead,charter,is_always_on,is_active) VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(oldId, 'org_test', oldId, oldId, 'desc', '#ccc', null, null, 0, 1);
      }
    });

    it('deactivates 5 KD old teams and creates target + 5 receipts', () => {
      const result = runOrganizationDesignAudit({ database: db, now: new Date('2026-07-27T00:00:00Z'), source: 'manual', repair: true });

      for (const oldId of ['team_kd-harness', 'team_kd-memory', 'team_kd-obsidian', 'team_kd-prompt', 'team_kd-provider']) {
        const team = db.prepare(`SELECT is_active FROM teams WHERE id=?`).get(oldId) as any;
        expect(team.is_active).toBe(0);
      }

      const kdTeam = db.prepare(`SELECT is_active FROM teams WHERE id=?`).get('team_kd-quality-hygiene') as any;
      expect(kdTeam?.is_active).toBe(1);

      const kdOrg = db.prepare(`SELECT is_active FROM organizations WHERE id=?`).get('org_knowledge-diet') as any;
      expect(kdOrg?.is_active).toBe(1);

      const consCount = db.prepare(`SELECT COUNT(*) AS cnt FROM team_consolidations`).get() as any;
      expect(consCount.cnt).toBe(5);

      const kdDeactivated = result.actions.filter(a => a.startsWith('kd-old deactivated'));
      expect(kdDeactivated.length).toBe(5);

      expect(result.status).toBe('attention');
    });
  });

  describe('case 5: second repair -> actions 0, pass', () => {
    beforeEach(() => {
      db = new Database(':memory:');
      createSchema(db);
      insertEnabledGeneralAgents(db);

      db.prepare(`INSERT INTO required_organizations VALUES (?,?,?,?,?,?,?,?)`)
        .run('org_ok', 'OK', 'ok', 'nova-ax', null, null, 1, 1);
      db.prepare(`INSERT INTO required_capabilities VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run('team_ok', 'org_ok', 'OK', 'ok', 'desc', '#000', 'ollama', 'charter', 1, 1, 1);

      db.prepare(`INSERT INTO organizations (id,name,slug,graph_type,is_always_on,is_active) VALUES (?,?,?,?,?,?)`)
        .run('org_ok', 'OK', 'ok', 'nova-ax', 1, 1);
      db.prepare(`INSERT INTO teams (id,organization_id,name,slug,description,color,lead,charter,is_always_on,is_active) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('team_ok', 'org_ok', 'OK', 'ok', 'desc', '#000', 'ollama', 'charter', 1, 1);
      for (const m of ['ollama', 'codex', 'cursor-agent'])
        db.prepare(`INSERT INTO team_members (id,team_id,member_type,member_ref) VALUES (?,?,?,?)`)
          .run(`tm_ok_${m}`, 'team_ok', 'provider', m);

      db.prepare(`INSERT INTO team_lifecycle_profiles (team_id,status,protected) VALUES (?,?,?)`)
        .run('team_ok', 'active', 1);

      runOrganizationDesignAudit({ database: db, now: new Date('2026-07-27T00:00:00Z'), source: 'manual', repair: true });
    });

    it('second repair produces 0 actions and pass status', () => {
      const result = runOrganizationDesignAudit({ database: db, now: new Date('2026-07-27T01:00:00Z'), source: 'manual', repair: true });

      expect(result.actions.length).toBe(0);
      expect(result.status).toBe('pass');

      const auditCount = db.prepare(`SELECT COUNT(*) AS cnt FROM organization_design_audits`).get() as any;
      expect(auditCount.cnt).toBe(2);
    });
  });
});
