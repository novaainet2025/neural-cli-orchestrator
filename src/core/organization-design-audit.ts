import type Database from 'better-sqlite3';
import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('org-design-audit');

export const ORG_DESIGN_JOB_ID = 'org-design-hourly-audit';

export interface OrganizationDesignAuditOptions {
  database?: Database.Database;
  now?: Date;
  source?: 'scheduled' | 'startup' | 'manual';
  repair?: boolean;
}

export interface OrganizationDesignAuditResult {
  id: string;
  auditTime: string;
  source: string;
  status: 'pass' | 'attention' | 'fail';
  activeOrganizations: number;
  activeTeams: number;
  orgExpected: number;
  orgPresent: number;
  orgRepaired: number;
  capExpected: number;
  capPresent: number;
  capRepaired: number;
  membersBeforeZero: number;
  membersBeforeOne: number;
  membersBeforeTwo: number;
  membersAfterCoverage: number;
  collaborationCoverageBefore: number;
  collaborationCoverageAfter: number;
  missingLeadBefore: number;
  missingLeadAfter: number;
  missingCharterBefore: number;
  missingCharterAfter: number;
  excessCandidates: Array<{ teamId: string; name: string; slug: string; reason: string }>;
  actions: string[];
  evidence: string[];
}

function getEnabledProviderIds(db: Database.Database): Set<string> {
  const rows = db.prepare(`
    SELECT id FROM agents
    WHERE enabled=1 
      AND removed_at IS NULL
      AND capabilities_json IS NOT NULL
      AND json_valid(capabilities_json) = 1
      AND EXISTS (
        SELECT 1 FROM json_each(capabilities_json)
        WHERE value IN (
          'code', 'analysis', 'reasoning', 'review', 'tool-use',
          'function-calling', 'architecture', 'testing', 'validation',
          'verification', 'debugging', 'decision'
        )
      )
    ORDER BY id
  `).all() as Array<{ id: string }>;
  return new Set(rows.map(r => r.id));
}

function getMemberCount(db: Database.Database, teamId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt FROM team_members tm
     JOIN agents a ON a.id = tm.member_ref
     WHERE tm.team_id=? AND tm.member_type='provider'
     AND a.enabled=1 AND a.removed_at IS NULL`
  ).get(teamId) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

function getAgentLoadMap(db: Database.Database, enabledProviders: Set<string>): Map<string, number> {
  const rows = db.prepare(`
    SELECT tm.member_ref, COUNT(*) AS cnt
    FROM team_members tm
    JOIN agents a ON a.id = tm.member_ref
    WHERE tm.member_type='provider' AND a.enabled=1 AND a.removed_at IS NULL
    GROUP BY tm.member_ref
  `).all() as Array<{ member_ref: string; cnt: number }>;
  const loadMap = new Map<string, number>();
  for (const p of enabledProviders) loadMap.set(p, 0);
  for (const r of rows) {
    if (enabledProviders.has(r.member_ref)) loadMap.set(r.member_ref, r.cnt);
  }
  return loadMap;
}

const KD_OLD_TEAMS = [
  'team_kd-harness',
  'team_kd-memory',
  'team_kd-obsidian',
  'team_kd-prompt',
  'team_kd-provider',
];
const KD_NEW_TEAM = 'team_kd-quality-hygiene';
const KD_NEW_TEAM_ORG = 'org_knowledge-diet';

export function runOrganizationDesignAudit(
  options: OrganizationDesignAuditOptions = {},
): OrganizationDesignAuditResult {
  const database = options.database ?? getDb();
  const now = options.now ?? new Date();
  const source = options.source ?? 'scheduled';
  const repair = options.repair !== false;

  const actions: string[] = [];
  const evidence: string[] = [];
  const excessCandidates: Array<{ teamId: string; name: string; slug: string; reason: string }> = [];
  const enabledProviders = getEnabledProviderIds(database);

  const run = (): OrganizationDesignAuditResult => {
    return runAuditInternal(database, now, source, repair, actions, evidence, excessCandidates, enabledProviders);
  };

  return database.transaction(run)();
}

function runAuditInternal(
  database: Database.Database,
  now: Date,
  source: string,
  repair: boolean,
  actions: string[],
  evidence: string[],
  excessCandidates: Array<{ teamId: string; name: string; slug: string; reason: string }>,
  enabledProviders: Set<string>,
): OrganizationDesignAuditResult {
  const orgCount = (database.prepare(
    `SELECT COUNT(*) AS cnt FROM organizations WHERE is_active=1`
  ).get() as { cnt: number }).cnt;
  const teamCount = (database.prepare(
    `SELECT COUNT(*) AS cnt FROM teams WHERE is_active=1`
  ).get() as { cnt: number }).cnt;

  const memberCountsBefore = database.prepare(`
    SELECT t.id, t.name, t.slug, t.lead, t.charter,
      (SELECT COUNT(*) FROM team_members tm
       JOIN agents a ON a.id = tm.member_ref
       WHERE tm.team_id=t.id AND tm.member_type='provider'
       AND a.enabled=1 AND a.removed_at IS NULL) AS member_cnt
    FROM teams t WHERE t.is_active=1
  `).all() as Array<{ id: string; name: string; slug: string; lead: string | null; charter: string | null; member_cnt: number }>;

  let membersBeforeZero = 0;
  let membersBeforeOne = 0;
  let membersBeforeTwo = 0;
  let missingLeadBefore = 0;
  let missingCharterBefore = 0;
  for (const t of memberCountsBefore) {
    if (t.member_cnt === 0) membersBeforeZero++;
    else if (t.member_cnt === 1) membersBeforeOne++;
    else if (t.member_cnt === 2) membersBeforeTwo++;
    if (!t.lead || !enabledProviders.has(t.lead)) missingLeadBefore++;
    if (!t.charter || !t.charter.trim()) missingCharterBefore++;
  }

  const coverageBefore = teamCount > 0
    ? (teamCount - membersBeforeZero - membersBeforeOne - membersBeforeTwo) / teamCount
    : 1;

  // ===== 1. required organizations (5 rows) =====
  const requiredOrgs = database.prepare(`
    SELECT id, name, slug, graph_type, manager, parent_id, is_always_on, is_active
    FROM required_organizations
  `).all() as Array<{
    id: string; name: string; slug: string; graph_type: string;
    manager: string | null; parent_id: string | null;
    is_always_on: number; is_active: number;
  }>;

  const orgExpected = requiredOrgs.length;
  let orgPresent = 0;
  let orgRepaired = 0;

  const orgParentExists = (parentId: string | null): boolean => {
    if (!parentId) return false;
    const p = database.prepare(`SELECT 1 FROM organizations WHERE id=?`).get(parentId);
    return !!p;
  };

  const upsertOrg = database.prepare(`
    INSERT INTO organizations (id, name, slug, graph_type, manager, parent_id, is_always_on, is_active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, slug=excluded.slug, graph_type=excluded.graph_type,
      manager=excluded.manager, parent_id=excluded.parent_id,
      is_always_on=excluded.is_always_on, is_active=1,
      updated_at=datetime('now')
  `);

  for (const ro of requiredOrgs) {
    const existing = database.prepare(
      `SELECT is_active FROM organizations WHERE id=?`
    ).get(ro.id) as { is_active: number } | undefined;

    const parentId = orgParentExists(ro.parent_id) ? ro.parent_id : null;

    if (existing) {
      if (existing.is_active === 1) {
        orgPresent++;
      } else if (repair) {
        upsertOrg.run(ro.id, ro.name, ro.slug, ro.graph_type, ro.manager, parentId, ro.is_always_on);
        actions.push(`restored required organization: ${ro.id} (was inactive)`);
        orgRepaired++;
      }
    } else if (repair) {
      upsertOrg.run(ro.id, ro.name, ro.slug, ro.graph_type, ro.manager, parentId, ro.is_always_on);
      actions.push(`created required organization: ${ro.id}`);
      orgRepaired++;
    }
  }

  // ===== 2. required capabilities (25 rows) =====
  const requiredCaps = database.prepare(`
    SELECT id, organization_id, name, slug, description, color, lead, charter, is_always_on, protected, is_active
    FROM required_capabilities
  `).all() as Array<{
    id: string; organization_id: string; name: string; slug: string;
    description: string; color: string; lead: string; charter: string;
    is_always_on: number; protected: number; is_active: number;
  }>;

  const capExpected = requiredCaps.length;
  let capPresent = 0;
  let capRepaired = 0;

  const upsertTeam = database.prepare(`
    INSERT INTO teams (id, organization_id, name, slug, description, color, lead, charter, is_always_on, is_active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      organization_id=excluded.organization_id, name=excluded.name, slug=excluded.slug,
      description=excluded.description, color=excluded.color,
      lead=excluded.lead, charter=excluded.charter,
      is_always_on=excluded.is_always_on, is_active=1,
      updated_at=datetime('now')
  `);
  const upsertLifecycle = database.prepare(`
    INSERT INTO team_lifecycle_profiles (team_id, status, protected, updated_at)
    VALUES (?, 'active', 1, datetime('now'))
    ON CONFLICT(team_id) DO UPDATE SET
      status='active', protected=1, retired_at=NULL, retirement_reason=NULL,
      updated_at=datetime('now')
  `);

  for (const rc of requiredCaps) {
    const existing = database.prepare(
      `SELECT is_active FROM teams WHERE id=?`
    ).get(rc.id) as { is_active: number } | undefined;

    if (existing) {
      if (existing.is_active === 1) {
        capPresent++;
      } else if (repair) {
        upsertTeam.run(rc.id, rc.organization_id, rc.name, rc.slug, rc.description, rc.color, rc.lead, rc.charter, rc.is_always_on);
        actions.push(`restored required capability team: ${rc.id} (was inactive)`);
        capRepaired++;
      }
    } else if (repair) {
      upsertTeam.run(rc.id, rc.organization_id, rc.name, rc.slug, rc.description, rc.color, rc.lead, rc.charter, rc.is_always_on);
      actions.push(`created required capability team: ${rc.id}`);
      capRepaired++;
    }

    if (repair) {
      const existingProfile = database.prepare(
        `SELECT status, protected, retired_at, retirement_reason FROM team_lifecycle_profiles WHERE team_id=?`
      ).get(rc.id) as { status: string; protected: number; retired_at: string | null; retirement_reason: string | null } | undefined;

      upsertLifecycle.run(rc.id);

      const hasDrift = !existingProfile
        || existingProfile.status !== 'active'
        || existingProfile.protected !== 1
        || existingProfile.retired_at !== null
        || existingProfile.retirement_reason !== null;

      if (hasDrift) {
        actions.push(`lifecycle normalized for ${rc.id}`);
      }
    }
  }

  // ===== 3. KD old soft integration (exactly 5 targets) =====
  const ensureKdConsolidation = database.prepare(`
    INSERT OR IGNORE INTO team_consolidations (id, old_team_id, new_team_id, reason, evidence_json, consolidated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const oldId of KD_OLD_TEAMS) {
    const oldTeam = database.prepare(`SELECT is_active FROM teams WHERE id=?`).get(oldId) as { is_active: number } | undefined;
    if (oldTeam && oldTeam.is_active === 1 && repair) {
      database.prepare(`UPDATE teams SET is_active=0, updated_at=datetime('now') WHERE id=?`).run(oldId);
      actions.push(`kd-old deactivated: ${oldId}`);
    }
    if (repair) {
      const receiptId = 'tc_audit_' + oldId.replace(/^team_/, '');
      const insResult = ensureKdConsolidation.run(
        receiptId,
        oldId,
        KD_NEW_TEAM,
        'KD old team soft-integrated via org-design audit',
        JSON.stringify({ action: 'org-design-audit', audit_time: now.toISOString() }),
        now.toISOString(),
      );
      if (insResult.changes === 1) {
        actions.push(`kd-old consolidation receipt: ${oldId} -> ${KD_NEW_TEAM} (${receiptId})`);
      }
    }
  }

  // ===== 3b. KD target — create if missing =====
  if (repair) {
    const kdOrgExists = database.prepare(`SELECT 1 FROM organizations WHERE id=?`).get(KD_NEW_TEAM_ORG);
    if (!kdOrgExists) {
      database.prepare(`
        INSERT INTO organizations (id, name, slug, graph_type, manager, is_always_on, is_active, updated_at)
        VALUES (?, 'Knowledge Diet', 'knowledge-diet', 'nova-ax', 'ollama', 1, 1, datetime('now'))
        ON CONFLICT(id) DO NOTHING
      `).run(KD_NEW_TEAM_ORG);
      actions.push(`created KD organization: ${KD_NEW_TEAM_ORG}`);
    }

    const kdTeamExists = database.prepare(`SELECT is_active FROM teams WHERE id=?`).get(KD_NEW_TEAM) as { is_active: number } | undefined;
    if (!kdTeamExists) {
      database.prepare(`
        INSERT INTO teams (id, organization_id, name, slug, description, color, lead, charter, is_always_on, is_active, updated_at)
        VALUES (?, ?, 'Quality and Hygiene', 'kd-quality-hygiene',
          'Maintain data quality, deduplication, and context hygiene for AI diet.',
          '#F59E0B', 'ollama',
          '지식 다이어트의 품질과 위생을 관리한다. 중복되거나 불필요한 맥락을 제거하고 고품질 지식만 선별하여 AI가 섭취하도록 보장한다.',
          0, 1, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          organization_id=excluded.organization_id, name=excluded.name, slug=excluded.slug,
          description=excluded.description, color=excluded.color,
          lead=excluded.lead, charter=excluded.charter,
          is_always_on=excluded.is_always_on, is_active=1,
          updated_at=datetime('now')
      `).run(KD_NEW_TEAM, KD_NEW_TEAM_ORG);
      actions.push(`created KD target team: ${KD_NEW_TEAM}`);

      const kdMembers = ['ollama', 'cursor-agent', 'codex'];
      const insertMember = database.prepare(
        `INSERT OR IGNORE INTO team_members (id, team_id, member_type, member_ref) VALUES (?, ?, 'provider', ?)`
      );
      for (const m of kdMembers) {
        insertMember.run(createId('tm'), KD_NEW_TEAM, m);
      }
      actions.push(`added default members to ${KD_NEW_TEAM}`);

      upsertLifecycle.run(KD_NEW_TEAM);
      actions.push(`lifecycle initialized for ${KD_NEW_TEAM}`);
    } else if (kdTeamExists.is_active === 0) {
      database.prepare(`UPDATE teams SET is_active=1, updated_at=datetime('now') WHERE id=?`).run(KD_NEW_TEAM);
      upsertLifecycle.run(KD_NEW_TEAM);
      actions.push(`restored KD new team: ${KD_NEW_TEAM}`);
    }
  }

  // ===== 4. member sufficiency (lead + charter + >=3 members) =====
  const teamsToFix = database.prepare(`
    SELECT t.id, t.name, t.slug, t.lead, t.charter,
      (SELECT COUNT(*) FROM team_members tm
       JOIN agents a ON a.id = tm.member_ref
       WHERE tm.team_id=t.id AND tm.member_type='provider'
       AND a.enabled=1 AND a.removed_at IS NULL) AS member_cnt
    FROM teams t WHERE t.is_active=1
  `).all() as Array<{ id: string; name: string; slug: string; lead: string | null; charter: string | null; member_cnt: number }>;

  let afterCoverageNumerator = 0;
  let missingLeadAfter = 0;
  let missingCharterAfter = 0;

  for (const team of teamsToFix) {
    const needsLead = !team.lead || !enabledProviders.has(team.lead);
    const needsCharter = !team.charter || !team.charter.trim();
    const needsMembers = team.member_cnt < 3;

    if (needsLead && repair) {
      const preferredLead = [...enabledProviders].find(p => p === 'ollama' || p === 'hermes' || p === 'claude-code');
      if (preferredLead) {
        database.prepare(`UPDATE teams SET lead=?, updated_at=datetime('now') WHERE id=?`).run(preferredLead, team.id);
        actions.push(`assigned lead ${preferredLead} to ${team.id}`);
      }
    }
    if (needsCharter && repair) {
      database.prepare(`UPDATE teams SET charter=?, updated_at=datetime('now') WHERE id=?`).run(
        `${team.name} — 자동 운영팀. 설계된 역량을 유지하고 협업을 수행한다.`,
        team.id,
      );
      actions.push(`assigned default charter to ${team.id}`);
    }
    if (needsMembers && repair) {
      const existingRefs = new Set(
        (database.prepare(
          `SELECT tm.member_ref FROM team_members tm
           JOIN agents a ON a.id = tm.member_ref
           WHERE tm.team_id=? AND tm.member_type='provider'
           AND a.enabled=1 AND a.removed_at IS NULL`
        ).all(team.id) as Array<{ member_ref: string }>)
          .map(r => r.member_ref)
      );
      const candidates = [...enabledProviders].filter(p => !existingRefs.has(p));
      const loadMap = getAgentLoadMap(database, enabledProviders);
      candidates.sort((a, b) => {
        const la = loadMap.get(a) ?? 0;
        const lb = loadMap.get(b) ?? 0;
        return la !== lb ? la - lb : a.localeCompare(b);
      });
      const toAdd = candidates.slice(0, 3 - team.member_cnt);
      const insertMember = database.prepare(
        `INSERT OR IGNORE INTO team_members (id, team_id, member_type, member_ref) VALUES (?, ?, 'provider', ?)`
      );
      for (const p of toAdd) {
        insertMember.run(createId('tm'), team.id, p);
        actions.push(`added member ${p} to ${team.id}`);
      }
    }

    const finalLead = (database.prepare(`SELECT lead FROM teams WHERE id=?`).get(team.id) as { lead: string | null })?.lead;
    const finalCharter = (database.prepare(`SELECT charter FROM teams WHERE id=?`).get(team.id) as { charter: string | null })?.charter;
    if (!finalLead || !enabledProviders.has(finalLead)) missingLeadAfter++;
    if (!finalCharter || !finalCharter.trim()) missingCharterAfter++;

    const finalCount = getMemberCount(database, team.id);
    if (finalCount >= 3) afterCoverageNumerator++;
  }

  // ===== 4b. post-repair counts =====
  const afterOrgCount = (database.prepare(
    `SELECT COUNT(*) AS cnt FROM organizations WHERE is_active=1`
  ).get() as { cnt: number }).cnt;
  const afterTeamCount = (database.prepare(
    `SELECT COUNT(*) AS cnt FROM teams WHERE is_active=1`
  ).get() as { cnt: number }).cnt;

  if (repair) {
    const actualOrgPresent = (database.prepare(
      `SELECT COUNT(*) AS cnt FROM organizations o
       WHERE o.is_active=1 AND EXISTS (SELECT 1 FROM required_organizations ro WHERE ro.id=o.id)`
    ).get() as { cnt: number }).cnt;
    orgPresent = actualOrgPresent;

    const actualCapPresent = (database.prepare(
      `SELECT COUNT(*) AS cnt FROM teams t
       WHERE t.is_active=1 AND EXISTS (SELECT 1 FROM required_capabilities rc WHERE rc.id=t.id)`
    ).get() as { cnt: number }).cnt;
    capPresent = actualCapPresent;
  }

  const membersAfterCoverage = afterCoverageNumerator;
  const collaborationCoverageAfter = afterTeamCount > 0 ? afterCoverageNumerator / afterTeamCount : 1;

  // ===== 5. excess candidate detection =====
  const requiredCapIds = new Set(requiredCaps.map(c => c.id));
  const excludedTeamIds = new Set([...requiredCapIds, ...KD_OLD_TEAMS, KD_NEW_TEAM]);

  const excessRows = database.prepare(`
    SELECT t.id, t.name, t.slug,
      (SELECT COUNT(*) FROM tasks WHERE team_id=t.id) AS task_cnt
    FROM teams t WHERE t.is_active=1
    ORDER BY task_cnt ASC, t.id ASC
  `).all() as Array<{ id: string; name: string; slug: string; task_cnt: number }>;

  for (const row of excessRows) {
    if (excludedTeamIds.has(row.id)) continue;
    if (row.task_cnt === 0) {
      excessCandidates.push({ teamId: row.id, name: row.name, slug: row.slug, reason: 'zero tasks; not required/KD' });
    }
  }

  // ===== 6. status determination =====
  let status: 'pass' | 'attention' | 'fail' = 'pass';

  if (orgPresent < orgExpected || capPresent < capExpected) {
    status = 'fail';
  }

  if (status !== 'fail' && repair) {
    const failedTeams = database.prepare(`
      SELECT t.id, t.lead, t.charter,
        (SELECT COUNT(*) FROM team_members tm
         JOIN agents a ON a.id = tm.member_ref
         WHERE tm.team_id=t.id AND tm.member_type='provider'
         AND a.enabled=1 AND a.removed_at IS NULL) AS valid_member_cnt
      FROM teams t WHERE t.is_active=1
    `).all() as Array<{ id: string; lead: string | null; charter: string | null; valid_member_cnt: number }>;

    for (const ft of failedTeams) {
      if (ft.valid_member_cnt < 3 || !ft.lead || !enabledProviders.has(ft.lead) || !ft.charter || !ft.charter.trim()) {
        status = 'fail';
        break;
      }
    }
  }

  if (actions.length > 0 || excessCandidates.length > 0) {
    if (status !== 'fail') status = 'attention';
  }

  if (orgRepaired > 0) {
    evidence.push(`Repaired ${orgRepaired} organizations during audit`);
  }
  if (capRepaired > 0) {
    evidence.push(`Repaired ${capRepaired} capabilities during audit`);
  }
  if (orgPresent < orgExpected) {
    evidence.push(`Organization gap: ${orgExpected - orgPresent} required organizations still missing`);
  }
  if (capPresent < capExpected) {
    evidence.push(`Capability gap: ${capExpected - capPresent} required capabilities still missing`);
  }
  if (missingLeadBefore > 0 || missingCharterBefore > 0) {
    evidence.push(`Member insufficiency before: ${missingLeadBefore} teams missing lead, ${missingCharterBefore} teams missing charter`);
  }
  if (missingLeadAfter > 0 || missingCharterAfter > 0) {
    evidence.push(`Member insufficiency after: ${missingLeadAfter} teams missing lead, ${missingCharterAfter} teams missing charter`);
  }
  if (excessCandidates.length > 0) {
    evidence.push(`Excess candidates: ${excessCandidates.length} non-required teams with zero tasks`);
  }
  if (evidence.length === 0) {
    evidence.push('Organization design topology is healthy — all capabilities covered, member sufficiency OK');
  }

  const result: OrganizationDesignAuditResult = {
    id: createId('org-design'),
    auditTime: now.toISOString(),
    source,
    status,
    activeOrganizations: afterOrgCount,
    activeTeams: afterTeamCount,
    orgExpected,
    orgPresent,
    orgRepaired,
    capExpected,
    capPresent,
    capRepaired,
    membersBeforeZero,
    membersBeforeOne,
    membersBeforeTwo,
    membersAfterCoverage,
    collaborationCoverageBefore: Math.round(coverageBefore * 100) / 100,
    collaborationCoverageAfter: Math.round(collaborationCoverageAfter * 100) / 100,
    missingLeadBefore,
    missingLeadAfter,
    missingCharterBefore,
    missingCharterAfter,
    excessCandidates,
    actions,
    evidence,
  };

  database.prepare(`
    INSERT INTO organization_design_audits (
      id, audit_time, source, status,
      active_organizations, active_teams,
      org_expected, org_present, org_repaired,
      cap_expected, cap_present, cap_repaired,
      members_before_zero, members_before_one, members_before_two,
      members_after_coverage,
      collaboration_coverage_before, collaboration_coverage_after,
      missing_lead_before, missing_lead_after,
      missing_charter_before, missing_charter_after,
      excess_json, actions_json, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.id, result.auditTime, result.source, result.status,
    result.activeOrganizations, result.activeTeams,
    result.orgExpected, result.orgPresent, result.orgRepaired,
    result.capExpected, result.capPresent, result.capRepaired,
    result.membersBeforeZero, result.membersBeforeOne, result.membersBeforeTwo,
    result.membersAfterCoverage,
    result.collaborationCoverageBefore, result.collaborationCoverageAfter,
    result.missingLeadBefore, result.missingLeadAfter,
    result.missingCharterBefore, result.missingCharterAfter,
    JSON.stringify(result.excessCandidates),
    JSON.stringify(result.actions),
    JSON.stringify(result.evidence),
  );

  log.info(result, 'Organization design audit completed');
  return result;
}
