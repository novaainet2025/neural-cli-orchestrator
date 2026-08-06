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
//
// **기기마다 경로가 다르다.** 초판은 작성자 기기의 절대경로 하나만 두었는데, 그 경로가
// 없는 기기(Linux·WSL2)에서는 `firstExistingDir` 가 undefined 를 내 **이 보호가 조용히
// 꺼졌다.** 오류도 로그도 없이 nova-ax 로 라우팅된다 — 정확히 막으려던 상황이다.
// (kangnote 보고 2026-08-07: 그 기기에서 하드코딩 경로 탓에 테스트가 무조건 실패.)
//
// 그래서 `NCO_PROJECT_DIR` 를 첫 후보로 둔다. 기기별 설정은 이 변수 하나로 끝나고,
// 팀별로 다른 경로가 필요하면 기존 `NCO_ORG_PROJECT_DIRS` 가 이보다 우선한다.
function teamProjectDirCandidates(teamId: string): readonly string[] {
  if (teamId !== 'team_cli-assurance-2026') return [];
  const configured = process.env.NCO_PROJECT_DIR?.trim();
  return [
    ...(configured ? [configured] : []),
    '/Users/nova-ai/project/nco',
  ];
}

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
    const teamCandidates = teamProjectDirCandidates(teamId);
    if (teamCandidates.length > 0) {
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
