import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'db/migrations/086_nco_ai_government_foundation.sql',
);
const PROVIDERS_PATH = resolve(process.cwd(), 'config/ai-providers.json');

const FOUNDATION_ORG_IDS = [
  'org_nco-command',
  'org_nco-evolution',
  'org_nco-engineering',
  'org_nco-assurance',
  'org_nco-government',
] as const;

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

describe('086 NCO AI government foundation migration', () => {
  let db: Database.Database;
  let migrationSql: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        graph_type TEXT NOT NULL DEFAULT 'nova-ax',
        manager TEXT,
        parent_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
        is_always_on INTEGER NOT NULL DEFAULT 1,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE teams (
        id TEXT PRIMARY KEY,
        organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
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

      CREATE TABLE team_goals (
        id TEXT PRIMARY KEY,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        period TEXT NOT NULL,
        period_key TEXT NOT NULL,
        title TEXT NOT NULL,
        metric TEXT,
        target_value REAL,
        current_value REAL NOT NULL DEFAULT 0,
        unit TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        note TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE team_lifecycle_profiles (
        team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
        protected INTEGER NOT NULL DEFAULT 0 CHECK(protected IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO organizations (id, name, slug)
      VALUES ('org_nova-ax', 'NOVA AX Group', 'nova-ax');
    `);
    migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
  });

  afterEach(() => {
    db.close();
  });

  it('is idempotent and creates exactly five active foundation companies', () => {
    db.exec(migrationSql);
    db.exec(migrationSql);

    const organizations = db.prepare(`
      SELECT id, parent_id, manager, is_always_on, is_active
      FROM organizations
      WHERE id IN (${placeholders(FOUNDATION_ORG_IDS.length)})
      ORDER BY id
    `).all(...FOUNDATION_ORG_IDS) as Array<{
      id: string;
      parent_id: string | null;
      manager: string;
      is_always_on: number;
      is_active: number;
    }>;

    expect(organizations).toHaveLength(5);
    expect(new Set(organizations.map((organization) => organization.manager)).size).toBe(5);
    expect(organizations.every((organization) => organization.parent_id === 'org_nova-ax')).toBe(true);
    expect(organizations.every((organization) => organization.is_always_on === 1)).toBe(true);
    expect(organizations.every((organization) => organization.is_active === 1)).toBe(true);
  });

  it('also installs safely when the optional NOVA AX parent is absent', () => {
    db.prepare("DELETE FROM organizations WHERE id='org_nova-ax'").run();

    expect(() => db.exec(migrationSql)).not.toThrow();
    const parents = db.prepare(`
      SELECT parent_id
      FROM organizations
      WHERE id IN (${placeholders(FOUNDATION_ORG_IDS.length)})
    `).all(...FOUNDATION_ORG_IDS) as Array<{ parent_id: string | null }>;

    expect(parents).toHaveLength(5);
    expect(parents.every((organization) => organization.parent_id === null)).toBe(true);
  });

  it('creates five teams per company with active leads and complete charters', () => {
    db.exec(migrationSql);
    const organizationPlaceholders = placeholders(FOUNDATION_ORG_IDS.length);

    const counts = db.prepare(`
      SELECT organization_id, COUNT(*) AS count
      FROM teams
      WHERE organization_id IN (${organizationPlaceholders})
      GROUP BY organization_id
      ORDER BY organization_id
    `).all(...FOUNDATION_ORG_IDS) as Array<{ organization_id: string; count: number }>;
    expect(counts).toHaveLength(5);
    expect(counts.every((row) => row.count === 5)).toBe(true);

    const summary = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(is_always_on) AS always_on,
        SUM(CASE WHEN is_active=1 AND length(charter) >= 80 THEN 1 ELSE 0 END) AS chartered,
        SUM(CASE WHEN EXISTS (
          SELECT 1
          FROM team_members tm
          WHERE tm.team_id=teams.id AND tm.member_ref=teams.lead
        ) THEN 1 ELSE 0 END) AS lead_is_member
      FROM teams
      WHERE organization_id IN (${organizationPlaceholders})
    `).get(...FOUNDATION_ORG_IDS) as {
      total: number;
      always_on: number;
      chartered: number;
      lead_is_member: number;
    };

    expect(summary).toEqual({
      total: 25,
      always_on: 16,
      chartered: 25,
      lead_is_member: 25,
    });

    const staffing = db.prepare(`
      SELECT
        COUNT(*) AS team_count,
        SUM(member_count) AS assignments,
        MIN(member_count) AS minimum,
        MAX(member_count) AS maximum
      FROM (
        SELECT t.id, COUNT(tm.id) AS member_count
        FROM teams t
        LEFT JOIN team_members tm ON tm.team_id=t.id
        WHERE t.organization_id IN (${organizationPlaceholders})
        GROUP BY t.id
      )
    `).get(...FOUNDATION_ORG_IDS) as {
      team_count: number;
      assignments: number;
      minimum: number;
      maximum: number;
    };
    expect(staffing).toEqual({
      team_count: 25,
      assignments: 75,
      minimum: 3,
      maximum: 3,
    });

    const providerConfig = JSON.parse(readFileSync(PROVIDERS_PATH, 'utf8')) as {
      providers: Array<{ id: string; enabled: boolean }>;
    };
    const enabledProviders = new Set(
      providerConfig.providers.filter((provider) => provider.enabled).map((provider) => provider.id),
    );
    const assignedProviders = db.prepare(`
      SELECT DISTINCT tm.member_ref
      FROM team_members tm
      JOIN teams t ON t.id=tm.team_id
      WHERE t.organization_id IN (${organizationPlaceholders})
    `).all(...FOUNDATION_ORG_IDS) as Array<{ member_ref: string }>;

    expect(assignedProviders).toHaveLength(7);
    expect(assignedProviders.every((provider) => enabledProviders.has(provider.member_ref))).toBe(true);
  });

  it('enforces separation of command, build, verification, and constitutional leadership', () => {
    db.exec(migrationSql);

    const roleLeads = db.prepare(`
      SELECT id, lead
      FROM teams
      WHERE id IN (
        'team_gov-command-strategic',
        'team_gov-engineering-build',
        'team_gov-assurance-verification',
        'team_gov-government-constitution'
      )
      ORDER BY id
    `).all() as Array<{ id: string; lead: string }>;

    expect(roleLeads).toHaveLength(4);
    expect(new Set(roleLeads.map((team) => team.lead)).size).toBe(4);

    const verificationCharter = db.prepare(`
      SELECT charter
      FROM teams
      WHERE id='team_gov-assurance-verification'
    `).pluck().get() as string;
    const buildCharter = db.prepare(`
      SELECT charter
      FROM teams
      WHERE id='team_gov-engineering-build'
    `).pluck().get() as string;

    expect(verificationCharter).toContain('수정 구현을 직접 소유하지 않는다');
    expect(buildCharter).toContain('자기 변경을 최종 승인하지 않으며');
  });

  it('seeds measurable company goals and protects only the constitutional minimum', () => {
    db.exec(migrationSql);

    const goals = db.prepare(`
      SELECT subject_id, target_value, status, source
      FROM team_goals
      WHERE subject_id IN (${placeholders(FOUNDATION_ORG_IDS.length)})
      ORDER BY subject_id
    `).all(...FOUNDATION_ORG_IDS) as Array<{
      subject_id: string;
      target_value: number;
      status: string;
      source: string;
    }>;
    expect(goals).toHaveLength(5);
    expect(goals.every((goal) => goal.target_value > 0)).toBe(true);
    expect(goals.every((goal) => goal.status === 'active')).toBe(true);
    expect(goals.every((goal) => goal.source === 'hr-foundation-2026-07-26')).toBe(true);

    const protectedCount = db.prepare(`
      SELECT COUNT(*)
      FROM team_lifecycle_profiles
      WHERE protected=1
    `).pluck().get() as number;
    expect(protectedCount).toBe(9);
  });
});
