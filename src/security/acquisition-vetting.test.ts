import { describe, expect, it } from 'vitest';
import { vetAcquisitionCandidate } from './acquisition-vetting.js';
import type { AcquisitionPolicy } from './acquisition-policy.js';

const policy: AcquisitionPolicy = {
  defaultPolicy: 'deny',
  ecosystems: ['npm'],
  scorecard: { rejectBelow: 3, approvalBelow: 5, failMode: 'closed' },
  licenses: { allow: ['MIT'], failMode: 'closed' },
  scripts: { defaultInstallMode: 'ignore', approvalOnPresence: true, rejectPatternsFrom: 'src/security/command-gate.ts', failMode: 'closed' },
  typosquat: { maxAutoDistance: 0, approvalDistance: 2, requirePopularityCheck: true, failMode: 'closed' },
  maintainers: { approvalOnChange: true, failMode: 'closed' },
  popularPackages: ['react', 'express', 'lodash'],
};

describe('vetAcquisitionCandidate', () => {
  it('rejects fail-closed when OSV request times out', async () => {
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({
          maintainers: [{ name: 'alice' }],
          versions: {
            '1.0.0': {
              _npmUser: { name: 'alice' },
              scripts: {},
            },
          },
        }), { status: 200 });
      }
      throw new Error('timeout');
    };

    const result = await vetAcquisitionCandidate(
      { packageName: 'safe-package', version: '1.0.0' },
      { fetchImpl, policy, getTrustedPackageNames: () => ['safe-package-old'] },
    );

    expect(result.decision).toBe('hard_reject');
    expect(result.gateResults.osv.status).toBe('reject');
  });

  it('requires approval when install scripts are present but not dangerous', async () => {
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.osv.dev')) {
        return new Response(JSON.stringify({ results: [{ vulns: [] }] }), { status: 200 });
      }
      if (url.includes('/v3alpha/systems/npm/packages/')) {
        return new Response(JSON.stringify({
          licenses: [{ spdxId: 'MIT' }],
          relatedProjects: [{ projectKey: { name: 'owner/repo' } }],
        }), { status: 200 });
      }
      if (url.includes('/v3alpha/projects/')) {
        return new Response(JSON.stringify({ scorecard: { overallScore: 5.8 } }), { status: 200 });
      }
      if (url.includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({
          maintainers: [{ name: 'alice' }],
          versions: {
            '1.0.0': {
              _npmUser: { name: 'alice' },
              scripts: { postinstall: 'node build.js' },
            },
          },
        }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    };

    const result = await vetAcquisitionCandidate(
      { packageName: 'safe-package', version: '1.0.0' },
      { fetchImpl, policy, getTrustedPackageNames: () => ['react'], getPreviousMaintainers: () => ['alice'] },
    );

    expect(result.decision).toBe('approval_required');
    expect(result.gateResults.scripts.status).toBe('approval_required');
  });
});
