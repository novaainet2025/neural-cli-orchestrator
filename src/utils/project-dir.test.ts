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

  it('routes team_cli-assurance-2026 to the NCO workspace when routing is enabled', () => {
    process.env.NCO_ORG_PROJECT_DIR_ROUTING = 'on';
    expect(resolveTaskProjectDir({
      teamId: 'team_cli-assurance-2026',
      organizationId: 'org_nova-cli',
      requestedProjectDir: '/Users/nova-ai/project/nova-ax',
    })).toBe('/Users/nova-ai/project/nco');
  });

  it('prefers env team mappings over built-in defaults', () => {
    process.env.NCO_ORG_PROJECT_DIR_ROUTING = 'on';
    process.env.NCO_ORG_PROJECT_DIRS = JSON.stringify({
      teams: { 'team_cli-assurance-2026': '/Users/nova-ai/project/nco' },
    });
    expect(resolveTaskProjectDir({
      teamId: 'team_cli-assurance-2026',
      requestedProjectDir: '/Users/nova-ai/project/nova-ax',
    })).toBe('/Users/nova-ai/project/nco');
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
