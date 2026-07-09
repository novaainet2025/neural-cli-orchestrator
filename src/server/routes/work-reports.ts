import type { FastifyInstance } from 'fastify';
import { getDb } from '../../storage/database.js';
import {
  finalizeMissedWorkReports,
  formatKstDate,
  getDefaultWorkReportSlot,
  issueWorkReports,
  type WorkReportSlot,
  type WorkReportStatus,
} from '../../core/work-report-scheduler.js';

interface WorkReportRow {
  id: string;
  report_date: string;
  report_slot: WorkReportSlot;
  subject_kind: 'organization' | 'team';
  subject_id: string;
  organization_id: string | null;
  team_id: string | null;
  org_root_id: string | null;
  org_parent_id: string | null;
  org_path: string;
  org_depth: number;
  unit_level: 'company' | 'department' | 'team';
  source_task_id: string | null;
  status: WorkReportStatus;
  due_at: string;
  submitted_at: string | null;
  lateness_minutes: number;
  title: string | null;
  body_md: string | null;
  summary_json: string | null;
  created_at: string;
  updated_at: string;
  subject_name: string | null;
  organization_name: string | null;
  team_name: string | null;
}

interface OrganizationNode {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  is_active: number;
}

interface TeamNode {
  id: string;
  organization_id: string | null;
  name: string;
  slug: string;
  lead: string | null;
  is_active: number;
}

interface CoverageCounts {
  total: number;
  pending: number;
  submitted: number;
  late: number;
  missed: number;
  waived: number;
  completed: number;
  expected: number;
  completionRate: number;
}

interface CoverageTeamNode {
  id: string;
  name: string;
  slug: string;
  lead: string | null;
  isActive: boolean;
  report: ReturnType<typeof serializeReport> | null;
  aggregate: CoverageCounts;
}

interface CoverageOrganizationNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  isActive: boolean;
  report: ReturnType<typeof serializeReport> | null;
  aggregate: CoverageCounts;
  children: CoverageOrganizationNode[];
  teams: CoverageTeamNode[];
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// 미제공 → fallback, 제공됐지만 무효 → null(호출부 400) — 조용한 fallback이 오발행을 숨기던 문제 수정(리뷰 Low)
function parseDateParam(value: unknown, fallback: string): string | null {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

function parseSlotParam(value: unknown, fallback: WorkReportSlot): WorkReportSlot | null {
  if (value === undefined || value === null || value === '') return fallback;
  return value === 'am' || value === 'pm' ? value : null;
}

function parseStatusParam(value: unknown): WorkReportStatus | null {
  return value === 'pending'
    || value === 'submitted'
    || value === 'late'
    || value === 'missed'
    || value === 'waived'
    ? value
    : null;
}

function createEmptyCoverage(): CoverageCounts {
  return {
    total: 0,
    pending: 0,
    submitted: 0,
    late: 0,
    missed: 0,
    waived: 0,
    completed: 0,
    expected: 0,
    completionRate: 0,
  };
}

function addReportCount(counts: CoverageCounts, report: WorkReportRow | null): CoverageCounts {
  if (!report) return counts;
  counts.total += 1;
  counts[report.status] += 1;
  if (report.status === 'submitted' || report.status === 'late') {
    counts.completed += 1;
  }
  counts.expected = counts.total - counts.waived;
  counts.completionRate = counts.expected > 0
    ? Number((counts.completed / counts.expected).toFixed(4))
    : 0;
  return counts;
}

function mergeCoverage(target: CoverageCounts, source: CoverageCounts): CoverageCounts {
  target.total += source.total;
  target.pending += source.pending;
  target.submitted += source.submitted;
  target.late += source.late;
  target.missed += source.missed;
  target.waived += source.waived;
  target.completed += source.completed;
  target.expected = target.total - target.waived;
  target.completionRate = target.expected > 0
    ? Number((target.completed / target.expected).toFixed(4))
    : 0;
  return target;
}

function buildDescendantSet(rootOrgId: string | null, organizations: OrganizationNode[]): Set<string> | null {
  if (!rootOrgId) return null;
  const childrenByParent = new Map<string | null, string[]>();
  for (const organization of organizations) {
    const siblings = childrenByParent.get(organization.parent_id) ?? [];
    siblings.push(organization.id);
    childrenByParent.set(organization.parent_id, siblings);
  }

  const descendants = new Set<string>();
  const stack = [rootOrgId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || descendants.has(current)) continue;
    descendants.add(current);
    const children = childrenByParent.get(current) ?? [];
    for (const child of children) {
      stack.push(child);
    }
  }
  return descendants;
}

function serializeReport(report: WorkReportRow) {
  return {
    id: report.id,
    reportDate: report.report_date,
    reportSlot: report.report_slot,
    subjectKind: report.subject_kind,
    subjectId: report.subject_id,
    subjectName: report.subject_name,
    organizationId: report.organization_id,
    organizationName: report.organization_name,
    teamId: report.team_id,
    teamName: report.team_name,
    orgRootId: report.org_root_id,
    orgParentId: report.org_parent_id,
    orgPath: report.org_path,
    orgDepth: report.org_depth,
    unitLevel: report.unit_level,
    sourceTaskId: report.source_task_id,
    status: report.status,
    dueAt: report.due_at,
    submittedAt: report.submitted_at,
    latenessMinutes: report.lateness_minutes,
    title: report.title,
    bodyMd: report.body_md,
    summaryJson: report.summary_json ? JSON.parse(report.summary_json) : null,
    createdAt: report.created_at,
    updatedAt: report.updated_at,
  };
}

export async function registerWorkReportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/work-reports', async (req, reply) => {
    const query = (req.query as {
      date?: unknown;
      slot?: unknown;
      org?: unknown;
      status?: unknown;
    } | null) ?? {};

    const reportDate = parseDateParam(query.date, formatKstDate());
    const reportSlot = parseSlotParam(query.slot, getDefaultWorkReportSlot());
    if (reportDate === null) return reply.code(400).send({ error: 'invalid date (expected YYYY-MM-DD)' });
    if (reportSlot === null) return reply.code(400).send({ error: "invalid slot (expected 'am' or 'pm')" });
    const statusFilter = parseStatusParam(query.status);
    const orgFilter = typeof query.org === 'string' && query.org.trim() ? query.org.trim() : null;
    const db = getDb();

    const organizations = db.prepare(`
      SELECT id, name, slug, parent_id, is_active
      FROM organizations
      ORDER BY created_at ASC, name ASC
    `).all() as OrganizationNode[];
    const teams = db.prepare(`
      SELECT id, organization_id, name, slug, lead, is_active
      FROM teams
      ORDER BY created_at ASC, name ASC
    `).all() as TeamNode[];
    const reports = db.prepare(`
      SELECT
        wr.*,
        CASE
          WHEN wr.subject_kind='organization' THEN so.name
          ELSE st.name
        END AS subject_name,
        oo.name AS organization_name,
        st.name AS team_name
      FROM work_reports wr
      LEFT JOIN organizations so ON wr.subject_kind='organization' AND wr.subject_id = so.id
      LEFT JOIN teams st ON wr.subject_kind='team' AND wr.subject_id = st.id
      LEFT JOIN organizations oo ON wr.organization_id = oo.id
      WHERE wr.report_date=? AND wr.report_slot=?
      ORDER BY wr.org_path ASC, wr.unit_level ASC, wr.subject_kind ASC, wr.subject_id ASC
    `).all(reportDate, reportSlot) as WorkReportRow[];

    const descendantOrgIds = buildDescendantSet(orgFilter, organizations);
    const allowedOrgIds = descendantOrgIds ?? new Set(organizations.map((organization) => organization.id));
    const allowedTeamIds = new Set(
      teams
        .filter((team) => team.organization_id && allowedOrgIds.has(team.organization_id))
        .map((team) => team.id),
    );

    const treeReports = reports.filter((report) => {
      if (report.subject_kind === 'organization') {
        return allowedOrgIds.has(report.subject_id);
      }
      return allowedTeamIds.has(report.subject_id);
    });

    const visibleReports = statusFilter
      ? treeReports.filter((report) => report.status === statusFilter)
      : treeReports;

    const reportBySubject = new Map<string, WorkReportRow>();
    for (const report of treeReports) {
      reportBySubject.set(`${report.subject_kind}:${report.subject_id}`, report);
    }

    const childOrgsByParent = new Map<string | null, OrganizationNode[]>();
    for (const organization of organizations) {
      if (!allowedOrgIds.has(organization.id)) continue;
      const children = childOrgsByParent.get(organization.parent_id) ?? [];
      children.push(organization);
      childOrgsByParent.set(organization.parent_id, children);
    }

    const teamsByOrg = new Map<string | null, TeamNode[]>();
    for (const team of teams) {
      if (!team.organization_id || !allowedOrgIds.has(team.organization_id) || !allowedTeamIds.has(team.id)) continue;
      const list = teamsByOrg.get(team.organization_id) ?? [];
      list.push(team);
      teamsByOrg.set(team.organization_id, list);
    }

    const buildCoverageNode = (organization: OrganizationNode): CoverageOrganizationNode => {
      const selfReport = reportBySubject.get(`organization:${organization.id}`) ?? null;
      const children: CoverageOrganizationNode[] = (childOrgsByParent.get(organization.id) ?? []).map(buildCoverageNode);
      const teamItems: CoverageTeamNode[] = (teamsByOrg.get(organization.id) ?? []).map((team) => {
        const report = reportBySubject.get(`team:${team.id}`) ?? null;
        const counts = addReportCount(createEmptyCoverage(), report);
        return {
          id: team.id,
          name: team.name,
          slug: team.slug,
          lead: team.lead,
          isActive: team.is_active === 1,
          report: report ? serializeReport(report) : null,
          aggregate: counts,
        };
      });

      const aggregate = addReportCount(createEmptyCoverage(), selfReport);
      for (const child of children) {
        mergeCoverage(aggregate, child.aggregate);
      }
      for (const team of teamItems) {
        mergeCoverage(aggregate, team.aggregate);
      }

      return {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        parentId: organization.parent_id,
        isActive: organization.is_active === 1,
        report: selfReport ? serializeReport(selfReport) : null,
        aggregate,
        children,
        teams: teamItems,
      };
    };

    const rootOrganizations = organizations.filter((organization) => {
      if (!allowedOrgIds.has(organization.id)) return false;
      if (orgFilter) return organization.id === orgFilter;
      return organization.parent_id === null || !allowedOrgIds.has(organization.parent_id);
    });

    const coverageOrganizations = rootOrganizations.map(buildCoverageNode);
    const totals = coverageOrganizations.reduce<CoverageCounts>((sum, organization) => {
      mergeCoverage(sum, organization.aggregate);
      return sum;
    }, createEmptyCoverage());

    return {
      filters: {
        date: reportDate,
        slot: reportSlot,
        org: orgFilter,
        status: statusFilter,
      },
      reports: visibleReports.map(serializeReport),
      coverage: {
        totals,
        visibleCount: visibleReports.length,
        organizations: coverageOrganizations,
      },
    };
  });

  app.post<{ Params: { id: string } }>('/api/work-reports/:id/submit', async (req, reply) => {
    const { id } = req.params;
    const body = (req.body as {
      title?: unknown;
      bodyMd?: unknown;
      summaryJson?: unknown;
    } | null) ?? {};

    const bodyMd = normalizeOptionalText(body.bodyMd);
    if (!bodyMd) return reply.code(400).send({ error: 'bodyMd required' });

    const db = getDb();
    const report = db.prepare(`
      SELECT *
      FROM work_reports
      WHERE id=?
    `).get(id) as WorkReportRow | undefined;
    if (!report) return reply.code(404).send({ error: `work report not found: ${id}` });
    if (report.status === 'waived') return reply.code(409).send({ error: 'waived work report cannot be submitted' });

    const title = normalizeOptionalText(body.title);
    const submittedAt = new Date().toISOString();
    const dueAt = new Date(report.due_at);
    const lateMs = Number.isNaN(dueAt.getTime()) ? 0 : Math.max(0, Date.parse(submittedAt) - dueAt.getTime());
    const status: WorkReportStatus = lateMs > 0 ? 'late' : 'submitted';
    const latenessMinutes = lateMs > 0 ? Math.ceil(lateMs / 60_000) : 0;
    // missed 재제출은 설계대로 late 전이를 허용하되, was_missed 이력을 summary_json에 병합 보존(리뷰 반영)
    let summaryObj: Record<string, unknown> | null = null;
    if (body.summaryJson !== undefined && body.summaryJson !== null) {
      summaryObj = (typeof body.summaryJson === 'object' && !Array.isArray(body.summaryJson))
        ? { ...(body.summaryJson as Record<string, unknown>) }
        : { value: body.summaryJson };
    } else if (report.summary_json) {
      try {
        const prev: unknown = JSON.parse(report.summary_json);
        if (prev && typeof prev === 'object' && !Array.isArray(prev)) summaryObj = prev as Record<string, unknown>;
      } catch { /* 파손 JSON은 무시 */ }
    }
    if (report.status === 'missed') {
      summaryObj = { ...(summaryObj ?? {}), was_missed: true };
    }
    const summaryJson = summaryObj === null ? null : JSON.stringify(summaryObj);

    db.prepare(`
      UPDATE work_reports
      SET title=?, body_md=?, summary_json=?, submitted_at=?, status=?, lateness_minutes=?, updated_at=datetime('now')
      WHERE id=?
    `).run(title, bodyMd, summaryJson, submittedAt, status, latenessMinutes, id);

    const updated = db.prepare(`
      SELECT
        wr.*,
        CASE
          WHEN wr.subject_kind='organization' THEN so.name
          ELSE st.name
        END AS subject_name,
        oo.name AS organization_name,
        st.name AS team_name
      FROM work_reports wr
      LEFT JOIN organizations so ON wr.subject_kind='organization' AND wr.subject_id = so.id
      LEFT JOIN teams st ON wr.subject_kind='team' AND wr.subject_id = st.id
      LEFT JOIN organizations oo ON wr.organization_id = oo.id
      WHERE wr.id=?
    `).get(id) as WorkReportRow;

    return { report: serializeReport(updated) };
  });

  app.post('/api/work-reports/issue', async (req, reply) => {
    const body = (req.body as {
      date?: unknown;
      slot?: unknown;
    } | null) ?? {};
    const reportDate = parseDateParam(body.date, formatKstDate());
    const reportSlot = parseSlotParam(body.slot, getDefaultWorkReportSlot());
    if (reportDate === null) return reply.code(400).send({ error: 'invalid date (expected YYYY-MM-DD)' });
    if (reportSlot === null) return reply.code(400).send({ error: "invalid slot (expected 'am' or 'pm')" });
    const issue = await issueWorkReports(app, reportDate, reportSlot);
    const missed = finalizeMissedWorkReports(reportDate, reportSlot);
    return {
      ...issue,
      missedFinalized: missed.updated,
    };
  });
}
