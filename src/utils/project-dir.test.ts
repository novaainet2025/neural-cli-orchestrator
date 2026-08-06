import { afterEach, describe, expect, it } from 'vitest';
import {
  isOrgProjectDirRoutingEnabled,
  resolveInternalProjectDir,
  resolveTaskProjectDir,
} from './project-dir.js';

describe('resolveTaskProjectDir', () => {
  const originalRouting = process.env.NCO_ORG_PROJECT_DIR_ROUTING;
  const originalMappings = process.env.NCO_ORG_PROJECT_DIRS;
  const originalProjectDir = process.env.NCO_PROJECT_DIR;

  afterEach(() => {
    if (originalRouting === undefined) delete process.env.NCO_ORG_PROJECT_DIR_ROUTING;
    else process.env.NCO_ORG_PROJECT_DIR_ROUTING = originalRouting;
    if (originalMappings === undefined) delete process.env.NCO_ORG_PROJECT_DIRS;
    else process.env.NCO_ORG_PROJECT_DIRS = originalMappings;
    if (originalProjectDir === undefined) delete process.env.NCO_PROJECT_DIR;
    else process.env.NCO_PROJECT_DIR = originalProjectDir;
  });

  // 이 테스트들은 **실재하는 디렉터리**를 써야 한다(`firstExistingDir` 가 existsSync 로
  // 거른다). 작성자 기기의 절대경로를 박으면 다른 기기에서 무조건 실패한다 —
  // kangnote 기기(Linux)에서 실제로 그렇게 깨졌다. cwd 로 대신한다.
  const NCO_DIR = process.cwd();
  const OTHER_DIR = '/tmp';

  it('routes team_cli-assurance-2026 to the NCO workspace when routing is enabled', () => {
    process.env.NCO_ORG_PROJECT_DIR_ROUTING = 'on';
    process.env.NCO_PROJECT_DIR = NCO_DIR;
    expect(resolveTaskProjectDir({
      teamId: 'team_cli-assurance-2026',
      organizationId: 'org_nova-cli',
      requestedProjectDir: OTHER_DIR,
    })).toBe(NCO_DIR);
  });

  it('기기마다 다른 경로를 NCO_PROJECT_DIR 로 지정할 수 있다 — 하드코딩 경로가 없는 기기 대비', () => {
    // 초판은 후보가 작성자 기기 절대경로 하나뿐이라, 그 경로가 없는 기기에서는
    // 라우팅 보호가 조용히 꺼졌다(오류도 로그도 없이 요청 경로로 흘러감).
    process.env.NCO_ORG_PROJECT_DIR_ROUTING = 'on';
    process.env.NCO_PROJECT_DIR = NCO_DIR;
    expect(resolveTaskProjectDir({
      teamId: 'team_cli-assurance-2026',
      requestedProjectDir: OTHER_DIR,
    })).toBe(NCO_DIR);
  });

  it('prefers env team mappings over built-in defaults', () => {
    process.env.NCO_ORG_PROJECT_DIR_ROUTING = 'on';
    process.env.NCO_ORG_PROJECT_DIRS = JSON.stringify({
      teams: { 'team_cli-assurance-2026': NCO_DIR },
    });
    expect(resolveTaskProjectDir({
      teamId: 'team_cli-assurance-2026',
      requestedProjectDir: OTHER_DIR,
    })).toBe(NCO_DIR);
  });

  it('falls back to the requested projectDir when routing is disabled', () => {
    process.env.NCO_ORG_PROJECT_DIR_ROUTING = 'off';
    expect(resolveTaskProjectDir({
      teamId: 'team_cli-assurance-2026',
      requestedProjectDir: '/tmp/custom-workspace',
    })).toBe('/tmp/custom-workspace');
  });

  it('reports routing toggle state', () => {
    process.env.NCO_ORG_PROJECT_DIR_ROUTING = 'off';
    expect(isOrgProjectDirRoutingEnabled()).toBe(false);
    process.env.NCO_ORG_PROJECT_DIR_ROUTING = 'on';
    expect(isOrgProjectDirRoutingEnabled()).toBe(true);
  });

  it('keeps resolveInternalProjectDir as the final fallback', () => {
    process.env.NCO_ORG_PROJECT_DIR_ROUTING = 'on';
    expect(resolveTaskProjectDir({ teamId: 'team_other' })).toBe(resolveInternalProjectDir());
  });
});
