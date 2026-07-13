import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { eventBus } from '../../core/event-bus.js';
import { getDb } from '../../storage/database.js';
import { createId } from '../../utils/id.js';

type TeamMemberType = 'provider' | 'session' | 'nco-session';
type TeamStage = 'discussion' | 'design' | 'implementation' | 'review' | 'verification';
type TeamWorkflowState = 'pending' | 'running' | 'completed' | 'failed';

interface TeamTaskLike {
  mode?: string | null;
  status?: string | null;
  prompt?: string | null;
}

interface TeamWorkflowBucket {
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export interface TeamWorkflowSummary {
  discussion: TeamWorkflowBucket;
  design: TeamWorkflowBucket;
  implementation: TeamWorkflowBucket;
  review: TeamWorkflowBucket;
  verification: TeamWorkflowBucket;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NAME_MIN = 1;
const NAME_MAX = 80;
const MEMBER_TYPES = new Set<TeamMemberType>(['provider', 'session', 'nco-session']);
const RUNNING_STATUSES = new Set(['assigned', 'running', 'streaming', 'reviewing']);

function randomSlug(prefix: 'org' | 'team'): string {
  return `${prefix}-${randomBytes(3).toString('hex')}`;
}

function slugifyName(name: string, prefix: 'org' | 'team'): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return SLUG_RE.test(slug) ? slug : randomSlug(prefix);
}

function normalizeOptionalText(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < NAME_MIN || trimmed.length > NAME_MAX) return null;
  return trimmed;
}

function parseSlug(value: unknown, fallbackName: string, prefix: 'org' | 'team'): string | null {
  if (value === undefined || value === null || value === '') return slugifyName(fallbackName, prefix);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return SLUG_RE.test(trimmed) ? trimmed : null;
}

function parseMembers(value: unknown): Array<{ type: TeamMemberType; ref: string }> | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const members: Array<{ type: TeamMemberType; ref: string }> = [];
  for (const entry of value) {
    const type = (entry as any)?.type;
    const refRaw = (entry as any)?.ref;
    if (!MEMBER_TYPES.has(type) || typeof refRaw !== 'string') return null;
    const ref = refRaw.trim();
    if (!ref) return null;
    members.push({ type, ref });
  }
  return members;
}

function mapWorkflowState(status: string | null | undefined): TeamWorkflowState {
  if (status === 'completed') return 'completed';
  if (status === 'pending' || status === 'queued') return 'pending';
  if (status === 'assigned' || status === 'running' || status === 'streaming' || status === 'reviewing') return 'running';
  if (status === 'failed' || status === 'timed_out' || status === 'cancelled') return 'failed';
  return 'pending';
}

export function classifyTaskStage(task: TeamTaskLike): TeamStage {
  const mode = String(task.mode ?? '').toLowerCase();
  const prompt = String(task.prompt ?? '');
  if (['discussion', 'consensus', 'hive', 'realtime', 'parallel'].includes(mode)) return 'discussion';
  if (/리뷰|review/i.test(prompt)) return 'review';
  if (/검증|verify|test|tsc|lint|e2e|validation/i.test(prompt)) return 'verification';
  if (/설계|design|architecture|schema|spec/i.test(prompt)) return 'design';
  return 'implementation';
}

export function createEmptyWorkflowSummary(): TeamWorkflowSummary {
  return {
    discussion: { pending: 0, running: 0, completed: 0, failed: 0 },
    design: { pending: 0, running: 0, completed: 0, failed: 0 },
    implementation: { pending: 0, running: 0, completed: 0, failed: 0 },
    review: { pending: 0, running: 0, completed: 0, failed: 0 },
    verification: { pending: 0, running: 0, completed: 0, failed: 0 },
  };
}

export function summarizeTeamWorkflow(tasks: TeamTaskLike[]): TeamWorkflowSummary {
  const workflow = createEmptyWorkflowSummary();
  for (const task of tasks) {
    const stage = classifyTaskStage(task);
    const state = mapWorkflowState(task.status);
    workflow[stage][state] += 1;
  }
  return workflow;
}

function findActiveTaskPrompt(tasks: Array<{ prompt?: string | null; status?: string | null }>): string | null {
  for (const task of tasks) {
    if (RUNNING_STATUSES.has(String(task.status ?? ''))) {
      return task.prompt?.slice(0, 60) ?? null;
    }
  }
  return null;
}

function ensureOrganizationExists(organizationId: string | null): boolean {
  if (!organizationId) return true;
  const db = getDb();
  const row = db.prepare('SELECT id FROM organizations WHERE id=?').get(organizationId) as { id: string } | undefined;
  return Boolean(row);
}

function readTeamMembers(teamId: string): Array<{ type: TeamMemberType; ref: string }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT member_type, member_ref
    FROM team_members
    WHERE team_id=?
    ORDER BY created_at ASC, id ASC
  `).all(teamId) as Array<{ member_type: TeamMemberType; member_ref: string }>;
  return rows.map((row) => ({ type: row.member_type, ref: row.member_ref }));
}

function publishTeamEvent(type: string, payload: Record<string, unknown>): void {
  try { eventBus.publish({ type: type as any, ...payload }); } catch {}
}

export async function registerTeamsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/organizations', async (req, reply) => {
    const body = (req.body as { name?: unknown; slug?: unknown; manager?: unknown; parentId?: unknown; isAlwaysOn?: boolean; isActive?: boolean } | null) ?? {};
    const name = parseName(body.name);
    if (!name) return reply.code(400).send({ error: 'name required (1-80 chars)' });

    const slug = parseSlug(body.slug, name, 'org');
    if (!slug) return reply.code(400).send({ error: 'invalid slug' });

    const parentId = body.parentId === undefined
      ? null
      : typeof body.parentId === 'string' && body.parentId.trim()
        ? body.parentId.trim()
        : null;
    if (parentId && !ensureOrganizationExists(parentId)) {
      return reply.code(404).send({ error: `parent organization not found: ${parentId}` });
    }

    const isAlwaysOn = body.isAlwaysOn !== false;
    const isActive = body.isActive !== false;

    const organization = {
      id: `org_${slug}`,
      name,
      slug,
      graph_type: 'nova-ax',
      manager: normalizeOptionalText(body.manager),
      parent_id: parentId,
      is_always_on: isAlwaysOn ? 1 : 0,
      is_active: isActive ? 1 : 0,
    };

    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO organizations (id, name, slug, graph_type, manager, parent_id, is_always_on, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(organization.id, organization.name, organization.slug, organization.graph_type, organization.manager, organization.parent_id, organization.is_always_on, organization.is_active);
      publishTeamEvent('organization:created', { organizationId: organization.id });
      reply.code(201);
      return {
        organization: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          graphType: organization.graph_type,
          manager: organization.manager,
          parentId: organization.parent_id,
          isAlwaysOn: isAlwaysOn,
          isActive: isActive,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('UNIQUE')) return reply.code(409).send({ error: `organization slug already exists: ${slug}` });
      return reply.code(400).send({ error: message });
    }
  });

  app.get('/api/organizations', async () => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT o.id, o.name, o.slug, o.manager, o.parent_id as parentId, COUNT(t.id) AS teamCount, o.is_always_on as isAlwaysOn, o.is_active as isActive
      FROM organizations o
      LEFT JOIN teams t ON t.organization_id = o.id
      GROUP BY o.id, o.name, o.slug, o.manager, o.parent_id
      ORDER BY o.created_at ASC, o.name ASC
    `).all() as Array<{ id: string; name: string; slug: string; manager: string | null; parentId: string | null; teamCount: number; isAlwaysOn: number; isActive: number }>;
    return { organizations: rows.map(r => ({ ...r, isAlwaysOn: !!r.isAlwaysOn, isActive: !!r.isActive })) };
  });

  // 조직 관리 주체/이름 수정
  app.patch<{ Params: { id: string } }>('/api/organizations/:id', async (req, reply) => {
    const { id } = req.params;
    const body = (req.body as { name?: unknown; manager?: unknown; parentId?: unknown; isAlwaysOn?: boolean; isActive?: boolean } | null) ?? {};
    const db = getDb();
    const existing = db.prepare('SELECT id, name, manager, parent_id, is_always_on, is_active FROM organizations WHERE id=?').get(id) as
      { id: string; name: string; manager: string | null; parent_id: string | null; is_always_on: number; is_active: number } | undefined;
    if (!existing) return reply.code(404).send({ error: `organization not found: ${id}` });

    const nextName = body.name === undefined ? existing.name : parseName(body.name);
    if (!nextName) return reply.code(400).send({ error: 'name required (1-80 chars)' });
    const nextManager = body.manager === undefined ? existing.manager : normalizeOptionalText(body.manager);
    
    const nextParentId = body.parentId === undefined 
      ? existing.parent_id 
      : (typeof body.parentId === 'string' && body.parentId.trim() ? body.parentId.trim() : null);
    
    if (nextParentId && !ensureOrganizationExists(nextParentId)) {
      return reply.code(404).send({ error: `parent organization not found: ${nextParentId}` });
    }

    const nextIsAlwaysOn = body.isAlwaysOn === undefined ? existing.is_always_on : (body.isAlwaysOn ? 1 : 0);
    const nextIsActive = body.isActive === undefined ? existing.is_active : (body.isActive ? 1 : 0);

    db.prepare("UPDATE organizations SET name=?, manager=?, parent_id=?, is_always_on=?, is_active=?, updated_at=datetime('now') WHERE id=?")
      .run(nextName, nextManager, nextParentId, nextIsAlwaysOn, nextIsActive, id);
    publishTeamEvent('organization:updated', { organizationId: id });
    return { organization: { id, name: nextName, manager: nextManager, parentId: nextParentId, isAlwaysOn: !!nextIsAlwaysOn, isActive: !!nextIsActive } };
  });

  app.delete<{ Params: { id: string } }>('/api/organizations/:id', async (req) => {
    const { id } = req.params;
    const db = getDb();
    db.prepare('DELETE FROM organizations WHERE id=?').run(id);
    publishTeamEvent('organization:deleted', { organizationId: id });
    return { ok: true };
  });

  app.post('/api/teams', async (req, reply) => {
    const body = (req.body as {
      name?: unknown;
      slug?: unknown;
      organizationId?: unknown;
      description?: unknown;
      color?: unknown;
      members?: unknown;
      lead?: unknown;
      charter?: unknown;
      isAlwaysOn?: boolean;
      isActive?: boolean;
    } | null) ?? {};
    const name = parseName(body.name);
    if (!name) return reply.code(400).send({ error: 'name required (1-80 chars)' });

    const slug = parseSlug(body.slug, name, 'team');
    if (!slug) return reply.code(400).send({ error: 'invalid slug' });

    const organizationId = body.organizationId === undefined
      ? null
      : typeof body.organizationId === 'string' && body.organizationId.trim()
        ? body.organizationId.trim()
        : null;
    if (!ensureOrganizationExists(organizationId)) {
      return reply.code(404).send({ error: `organization not found: ${organizationId}` });
    }

    const members = parseMembers(body.members);
    if (!members) return reply.code(400).send({ error: 'invalid members' });

    const description = normalizeOptionalText(body.description);
    const color = normalizeOptionalText(body.color);
    const lead = normalizeOptionalText(body.lead);
    const charter = normalizeOptionalText(body.charter);
    const isAlwaysOn = body.isAlwaysOn !== false;
    const isActive = body.isActive !== false;
    const team = {
      id: `team_${slug}`,
      organizationId,
      name,
      slug,
      description,
      color,
      lead,
      charter,
      isAlwaysOn,
      isActive,
    };

    try {
      const db = getDb();
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO teams (id, organization_id, name, slug, description, color, lead, charter, is_always_on, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(team.id, team.organizationId, team.name, team.slug, team.description, team.color, team.lead, team.charter, team.isAlwaysOn ? 1 : 0, team.isActive ? 1 : 0);
        const insertMember = db.prepare(`
          INSERT OR IGNORE INTO team_members (id, team_id, member_type, member_ref)
          VALUES (?, ?, ?, ?)
        `);
        for (const member of members) {
          insertMember.run(createId('tm'), team.id, member.type, member.ref);
        }
      });
      tx();
      publishTeamEvent('team:created', { teamId: team.id, organizationId: team.organizationId });
      reply.code(201);
      return {
        team: {
          ...team,
          members: readTeamMembers(team.id),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('UNIQUE')) return reply.code(409).send({ error: `team slug already exists: ${slug}` });
      return reply.code(400).send({ error: message });
    }
  });

  app.get('/api/teams', async () => {
    const db = getDb();
    const teams = db.prepare(`
      SELECT id, organization_id, name, slug, description, color, lead, charter, created_at, updated_at, is_always_on, is_active
      FROM teams
      ORDER BY created_at ASC, name ASC
    `).all() as Array<{
      id: string;
      organization_id: string | null;
      name: string;
      slug: string;
      description: string | null;
      color: string | null;
      lead: string | null;
      charter: string | null;
      created_at: string;
      updated_at: string;
      is_always_on: number;
      is_active: number;
    }>;
    const memberRows = db.prepare(`
      SELECT team_id, member_type, member_ref
      FROM team_members
      ORDER BY created_at ASC, id ASC
    `).all() as Array<{ team_id: string; member_type: TeamMemberType; member_ref: string }>;
    const taskRows = db.prepare(`
      SELECT team_id, mode, status, prompt, created_at
      FROM tasks
      WHERE team_id IS NOT NULL
      ORDER BY created_at DESC
    `).all() as Array<{
      team_id: string | null;
      mode: string | null;
      status: string | null;
      prompt: string | null;
      created_at: string | null;
    }>;

    const membersByTeam = new Map<string, Array<{ type: TeamMemberType; ref: string }>>();
    for (const row of memberRows) {
      const list = membersByTeam.get(row.team_id) ?? [];
      list.push({ type: row.member_type, ref: row.member_ref });
      membersByTeam.set(row.team_id, list);
    }

    const tasksByTeam = new Map<string, TeamTaskLike[]>();
    for (const row of taskRows) {
      if (!row.team_id) continue;
      const list = tasksByTeam.get(row.team_id) ?? [];
      list.push(row);
      tasksByTeam.set(row.team_id, list);
    }

    return {
      teams: teams.map((team) => {
        const relatedTasks = tasksByTeam.get(team.id) ?? [];
        const activeTask = findActiveTaskPrompt(relatedTasks);
        return {
          id: team.id,
          organizationId: team.organization_id,
          name: team.name,
          slug: team.slug,
          description: team.description,
          color: team.color,
          lead: team.lead,
          charter: team.charter,
          createdAt: team.created_at,
          updatedAt: team.updated_at,
          isAlwaysOn: !!team.is_always_on,
          isActive: !!team.is_active,
          members: membersByTeam.get(team.id) ?? [],
          workflow: summarizeTeamWorkflow(relatedTasks),
          activeTask,
          status: activeTask ? 'working' : 'idle',
        };
      }),
    };
  });

  // 팀 위임 메트릭 — "회사 팀에 몇 % 위임하는가" 가시화 (read-only, additive)
  // tasks.team_id 태그 비율 + 세션(spawned_by_cli)별 위임률 + 팀별 카운트 + 7일 추이
  app.get('/api/teams/metrics', async () => {
    const db = getDb();
    const total = (db.prepare(`SELECT COUNT(*) c FROM tasks`).get() as { c: number }).c;
    const teamTagged = (db.prepare(
      `SELECT COUNT(*) c FROM tasks WHERE team_id IS NOT NULL AND team_id<>''`
    ).get() as { c: number }).c;
    const bySession = db.prepare(`
      SELECT spawned_by_cli AS session,
             COUNT(*) AS total,
             SUM(CASE WHEN team_id IS NOT NULL AND team_id<>'' THEN 1 ELSE 0 END) AS team
      FROM tasks
      WHERE spawned_by_cli IS NOT NULL AND spawned_by_cli<>''
      GROUP BY spawned_by_cli
      ORDER BY total DESC
      LIMIT 20
    `).all() as Array<{ session: string; total: number; team: number }>;
    const byTeam = db.prepare(`
      SELECT t.id, t.name, t.lead,
             COUNT(k.team_id) AS tasks,
             SUM(CASE WHEN k.status IN ('running','streaming','assigned','pending') THEN 1 ELSE 0 END) AS active
      FROM teams t
      LEFT JOIN tasks k ON k.team_id = t.id
      GROUP BY t.id, t.name, t.lead
      ORDER BY tasks DESC
    `).all() as Array<{ id: string; name: string; lead: string | null; tasks: number; active: number }>;
    const trend = db.prepare(`
      SELECT DATE(created_at) AS day, COUNT(*) AS tasks
      FROM tasks
      WHERE team_id IS NOT NULL AND team_id<>'' AND created_at >= datetime('now','-7 days')
      GROUP BY day ORDER BY day
    `).all() as Array<{ day: string; tasks: number }>;
    const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10000) / 100 : 0);
    return {
      totalTasks: total,
      teamTaggedTasks: teamTagged,
      teamDelegationPct: pct(teamTagged, total),
      bySession: bySession.map((s) => ({ ...s, pct: pct(s.team, s.total) })),
      byTeam,
      last7dTrend: trend,
      generatedAt: new Date().toISOString(),
    };
  });

  app.patch<{ Params: { id: string } }>('/api/teams/:id', async (req, reply) => {
    const { id } = req.params;
    const body = (req.body as {
      name?: unknown;
      organizationId?: unknown;
      description?: unknown;
      color?: unknown;
      lead?: unknown;
      charter?: unknown;
      isAlwaysOn?: boolean;
      isActive?: boolean;
    } | null) ?? {};
    const db = getDb();
    const existing = db.prepare(`
      SELECT id, organization_id, name, slug, description, color, lead, charter, created_at, updated_at, is_always_on, is_active
      FROM teams
      WHERE id=?
    `).get(id) as {
      id: string;
      organization_id: string | null;
      name: string;
      slug: string;
      description: string | null;
      color: string | null;
      lead: string | null;
      charter: string | null;
      created_at: string;
      updated_at: string;
      is_always_on: number;
      is_active: number;
    } | undefined;
    if (!existing) return reply.code(404).send({ error: `team not found: ${id}` });

    const nextName = body.name === undefined ? existing.name : parseName(body.name);
    if (!nextName) return reply.code(400).send({ error: 'name required (1-80 chars)' });

    const nextOrganizationId = body.organizationId === undefined
      ? existing.organization_id
      : typeof body.organizationId === 'string' && body.organizationId.trim()
        ? body.organizationId.trim()
        : null;
    if (!ensureOrganizationExists(nextOrganizationId)) {
      return reply.code(404).send({ error: `organization not found: ${nextOrganizationId}` });
    }

    const nextDescription = body.description === undefined ? existing.description : normalizeOptionalText(body.description);
    const nextColor = body.color === undefined ? existing.color : normalizeOptionalText(body.color);
    const nextLead = body.lead === undefined ? existing.lead : normalizeOptionalText(body.lead);
    const nextCharter = body.charter === undefined ? existing.charter : normalizeOptionalText(body.charter);
    const nextIsAlwaysOn = body.isAlwaysOn === undefined ? existing.is_always_on : (body.isAlwaysOn ? 1 : 0);
    const nextIsActive = body.isActive === undefined ? existing.is_active : (body.isActive ? 1 : 0);

    db.prepare(`
      UPDATE teams
      SET name=?, organization_id=?, description=?, color=?, lead=?, charter=?, is_always_on=?, is_active=?, updated_at=datetime('now')
      WHERE id=?
    `).run(nextName, nextOrganizationId, nextDescription, nextColor, nextLead, nextCharter, nextIsAlwaysOn, nextIsActive, id);

    const updated = db.prepare(`
      SELECT id, organization_id, name, slug, description, color, created_at, updated_at, is_always_on, is_active
      FROM teams
      WHERE id=?
    `).get(id) as {
      id: string;
      organization_id: string | null;
      name: string;
      slug: string;
      description: string | null;
      color: string | null;
      created_at: string;
      updated_at: string;
      is_always_on: number;
      is_active: number;
    };

    publishTeamEvent('team:updated', { teamId: id, organizationId: updated.organization_id });
    return {
      team: {
        id: updated.id,
        organizationId: updated.organization_id,
        name: updated.name,
        slug: updated.slug,
        description: updated.description,
        color: updated.color,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
        isAlwaysOn: !!updated.is_always_on,
        isActive: !!updated.is_active,
        members: readTeamMembers(id),
      },
    };
  });

  app.delete<{ Params: { id: string } }>('/api/teams/:id', async (req) => {
    const { id } = req.params;
    const db = getDb();
    const row = db.prepare('SELECT organization_id FROM teams WHERE id=?').get(id) as { organization_id: string | null } | undefined;
    // tasks.team_id FK(액션 없음) — 연결 태스크를 먼저 해제하지 않으면
    // foreign_keys=ON 환경에서 DELETE가 SQLITE_CONSTRAINT로 500 실패한다 (T1 재현 확인).
    db.prepare('UPDATE tasks SET team_id=NULL WHERE team_id=?').run(id);
    db.prepare('DELETE FROM teams WHERE id=?').run(id);
    publishTeamEvent('team:deleted', { teamId: id, organizationId: row?.organization_id ?? null });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/teams/:id/members', async (req, reply) => {
    const { id } = req.params;
    const body = (req.body as { members?: unknown } | null) ?? {};
    const members = parseMembers(body.members);
    if (!members) return reply.code(400).send({ error: 'invalid members' });

    const db = getDb();
    const exists = db.prepare('SELECT id FROM teams WHERE id=?').get(id) as { id: string } | undefined;
    if (!exists) return reply.code(404).send({ error: `team not found: ${id}` });

    const tx = db.transaction(() => {
      const insertMember = db.prepare(`
        INSERT OR IGNORE INTO team_members (id, team_id, member_type, member_ref)
        VALUES (?, ?, ?, ?)
      `);
      for (const member of members) {
        insertMember.run(createId('tm'), id, member.type, member.ref);
      }
      db.prepare("UPDATE teams SET updated_at=datetime('now') WHERE id=?").run(id);
    });
    tx();

    const team = db.prepare(`
      SELECT id, organization_id, name, slug, description, color, created_at, updated_at
      FROM teams
      WHERE id=?
    `).get(id) as {
      id: string;
      organization_id: string | null;
      name: string;
      slug: string;
      description: string | null;
      color: string | null;
      created_at: string;
      updated_at: string;
    };

    publishTeamEvent('team:members_updated', { teamId: id, organizationId: team.organization_id });
    return {
      team: {
        id: team.id,
        organizationId: team.organization_id,
        name: team.name,
        slug: team.slug,
        description: team.description,
        color: team.color,
        createdAt: team.created_at,
        updatedAt: team.updated_at,
        members: readTeamMembers(id),
      },
    };
  });

  app.delete<{ Params: { id: string } }>('/api/teams/:id/members', async (req, reply) => {
    const { id } = req.params;
    const body = (req.body as { members?: unknown } | null) ?? {};
    const members = parseMembers(body.members);
    if (!members) return reply.code(400).send({ error: 'invalid members' });

    const db = getDb();
    const team = db.prepare('SELECT organization_id FROM teams WHERE id=?').get(id) as { organization_id: string | null } | undefined;
    if (!team) return reply.code(404).send({ error: `team not found: ${id}` });

    const tx = db.transaction(() => {
      const deleteMember = db.prepare(`
        DELETE FROM team_members
        WHERE team_id=? AND member_type=? AND member_ref=?
      `);
      for (const member of members) {
        deleteMember.run(id, member.type, member.ref);
      }
      db.prepare("UPDATE teams SET updated_at=datetime('now') WHERE id=?").run(id);
    });
    tx();

    publishTeamEvent('team:members_updated', { teamId: id, organizationId: team.organization_id });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/teams/:id/tasks', async (req, reply) => {
    const { id } = req.params;
    const body = (req.body as { taskId?: unknown } | null) ?? {};
    const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
    if (!taskId) return reply.code(400).send({ error: 'taskId required' });

    const db = getDb();
    const team = db.prepare('SELECT organization_id FROM teams WHERE id=?').get(id) as { organization_id: string | null } | undefined;
    if (!team) return reply.code(404).send({ error: `team not found: ${id}` });
    const task = db.prepare('SELECT id FROM tasks WHERE id=?').get(taskId) as { id: string } | undefined;
    if (!task) return reply.code(404).send({ error: `task not found: ${taskId}` });

    db.prepare("UPDATE tasks SET team_id=?, updated_at=datetime('now') WHERE id=?").run(id, taskId);
    publishTeamEvent('team:updated', { teamId: id, organizationId: team.organization_id, taskId });
    return { ok: true };
  });

  // 팀에 연결된 태스크 목록 — 대시보드 TEAM TASKS 패널용.
  // 전역 최근 목록(recency window)에 팀 태스크가 밀려도 항상 조회 가능해야 한다.
  app.get<{ Params: { id: string } }>('/api/teams/:id/tasks', async (req, reply) => {
    const { id } = req.params;
    const db = getDb();
    const team = db.prepare('SELECT id FROM teams WHERE id=?').get(id) as { id: string } | undefined;
    if (!team) return reply.code(404).send({ error: `team not found: ${id}` });

    const rawLimit = Number((req.query as { limit?: string }).limit ?? 20);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20, 100);
    const rows = db.prepare(`
      SELECT id, mode, status, assigned_to, prompt, created_at, completed_at
      FROM tasks WHERE team_id=?
      ORDER BY created_at DESC LIMIT ?
    `).all(id, limit) as Array<{
      id: string; mode: string | null; status: string | null; assigned_to: string | null;
      prompt: string | null; created_at: string | null; completed_at: string | null;
    }>;
    return {
      tasks: rows.map((r) => ({
        ...r,
        prompt: (r.prompt ?? '').slice(0, 160),
        stage: classifyTaskStage(r),
      })),
    };
  });
}
