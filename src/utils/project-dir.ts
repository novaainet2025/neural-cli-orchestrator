import { existsSync } from 'node:fs';

export interface TaskProjectDirInput {
  organizationId?: string | null;
  teamId?: string | null;
  requestedProjectDir?: string | null;
}

interface OrgProjectDirMappings {
  orgs: Record<string, string>;
  teams: Record<string, string>;
}

const ORG_PROJECT_DIR_ROUTING_DISABLED = new Set(['0', 'false', 'off']);

// CLI 독립 검증팀은 NCO 메인 워크스페이스에서 검증해야 한다. nova-ax로 라우팅되면
// 잘못된 코드베이스에서 검증이 실행된다 (실측 2026-07-30: task_VB6fzKfIhmnp4uEw 등).
const TEAM_PROJECT_DIR_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  'team_cli-assurance-2026': [
    '/Users/nova-ai/orca/workspaces/nco/main',
    '/Users/nova-ai/project/nco',
  ],
};

export function resolveInternalProjectDir(): string {
  const configured = process.env.NCO_PROJECT_DIR?.trim();
  if (configured && existsSync(configured)) {
    return configured;
  }

  const cwd = process.cwd();
  return existsSync(cwd) ? cwd : process.cwd();
}

export function isOrgProjectDirRoutingEnabled(
  toggle: string | undefined = process.env.NCO_ORG_PROJECT_DIR_ROUTING,
): boolean {
  return !ORG_PROJECT_DIR_ROUTING_DISABLED.has(toggle?.trim().toLowerCase() ?? '');
}

function firstExistingDir(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed && existsSync(trimmed)) return trimmed;
  }
  return undefined;
}

function parseEnvProjectDirMappings(): OrgProjectDirMappings {
  const raw = process.env.NCO_ORG_PROJECT_DIRS?.trim();
  if (!raw) return { orgs: {}, teams: {} };
  try {
    const parsed = JSON.parse(raw) as {
      organizations?: Record<string, string>;
      teams?: Record<string, string>;
    };
    return {
      orgs: parsed.organizations ?? {},
      teams: parsed.teams ?? {},
    };
  } catch {
    return { orgs: {}, teams: {} };
  }
}

export function resolveTaskProjectDir(input: TaskProjectDirInput = {}): string {
  const requested = input.requestedProjectDir?.trim();
  if (!isOrgProjectDirRoutingEnabled()) {
    return requested || resolveInternalProjectDir();
  }

  const envMappings = parseEnvProjectDirMappings();
  const teamId = input.teamId?.trim() ?? '';
  const organizationId = input.organizationId?.trim() ?? '';

  if (teamId) {
    const envTeamDir = envMappings.teams[teamId]?.trim();
    if (envTeamDir) {
      const resolved = firstExistingDir([envTeamDir]);
      if (resolved) return resolved;
    }
    const teamCandidates = TEAM_PROJECT_DIR_CANDIDATES[teamId];
    if (teamCandidates) {
      const resolved = firstExistingDir(teamCandidates);
      if (resolved) return resolved;
    }
  }

  if (organizationId) {
    const envOrgDir = envMappings.orgs[organizationId]?.trim();
    if (envOrgDir) {
      const resolved = firstExistingDir([envOrgDir]);
      if (resolved) return resolved;
    }
  }

  return requested || resolveInternalProjectDir();
}
