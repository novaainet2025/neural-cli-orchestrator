import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, runMigrations } from '../src/storage/database.js';

vi.mock('../src/core/acquisition-installer.js', () => ({
  installAcquiredPackage: vi.fn(async ({ packageName, version }: { packageName: string; version: string }) => {
    const installDir = join(tmpdir(), `nco-acq-${packageName}-${version}`);
    const packageDir = join(installDir, 'node_modules', packageName);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: packageName,
      version,
      description: `mocked package ${packageName}`,
      bin: {
        [packageName]: 'cli.js',
      },
    }));
    return {
      installDir,
      packageDir,
      packageSha256: `sha-${packageName}-${version}`,
    };
  }),
}));

import { createGateway } from '../src/server/gateway.js';

const AUTO_PACKAGE = 'safe-auto-package';
const APPROVAL_PACKAGE = 'safe-approval-package';

let server: Awaited<ReturnType<typeof createGateway>>;

function cleanupRows() {
  const db = getDb();
  db.prepare(`DELETE FROM dynamic_skills WHERE name IN (?, ?)`).run('acquired_safe_auto_package', 'acquired_safe_approval_package');
  db.prepare(`DELETE FROM acquisitions WHERE package_name IN (?, ?)`).run(AUTO_PACKAGE, APPROVAL_PACKAGE);
}

beforeAll(async () => {
  runMigrations();
  server = await createGateway();
});

beforeEach(() => {
  cleanupRows();
  const db = getDb();
  db.prepare(`
    INSERT INTO acquisitions (
      id, package_name, version, source_type, source_ref,
      discovered_from_json, vet_results_json, decision, decision_reason, approval_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'seed_auto_package',
    AUTO_PACKAGE,
    '0.9.0',
    'manual',
    null,
    JSON.stringify({ seeded: true }),
    JSON.stringify({
      maintainer: {
        evidence: {
          maintainers: ['alice'],
        },
      },
    }),
    'active',
    'seed',
    'approved',
  );
});

afterEach(() => {
  cleanupRows();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  cleanupRows();
  await server.close();
});

function stubAcquisitionFetch(overrides?: { osvBody?: unknown }) {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('registry.npmjs.org')) {
      const packageName = decodeURIComponent(url.split('/').pop() ?? '');
      const isApproval = packageName === APPROVAL_PACKAGE;
      return new Response(JSON.stringify({
        maintainers: [{ name: 'alice' }],
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            _npmUser: { name: 'alice' },
            scripts: isApproval ? {} : {},
          },
        },
      }), { status: 200 });
    }
    if (url.includes('/v3alpha/systems/npm/packages/')) {
      return new Response(JSON.stringify({
        licenses: [{ spdxId: 'MIT' }],
        relatedProjects: [{ projectKey: { name: 'owner/repo' } }],
      }), { status: 200 });
    }
    if (url.includes('/v3alpha/projects/')) {
      return new Response(JSON.stringify({ scorecard: { overallScore: 6.2 } }), { status: 200 });
    }
    if (url.includes('api.osv.dev')) {
      return new Response(JSON.stringify(overrides?.osvBody ?? { results: [{ vulns: [] }] }), { status: 200 });
    }
    throw new Error(`unexpected url ${url}`);
  }));
}

describe('acquisitions gateway routes', () => {
  it('POST /api/acquisitions/discover auto-installs auto_pass candidates', async () => {
    stubAcquisitionFetch();

    const response = await server.inject({
      method: 'POST',
      url: '/api/acquisitions/discover',
      payload: { packageName: AUTO_PACKAGE },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      acquisitions: Array<{ record: { decision: string }; skill: { name: string } | null }>;
    };
    expect(body.acquisitions).toHaveLength(1);
    expect(body.acquisitions[0].record.decision).toBe('active');
    expect(body.acquisitions[0].skill?.name).toBe('acquired_safe_auto_package');
  });

  it('POST /api/acquisitions/:id/approve installs and registers approval_required candidates', async () => {
    stubAcquisitionFetch();

    const discover = await server.inject({
      method: 'POST',
      url: '/api/acquisitions/discover',
      payload: { packageName: APPROVAL_PACKAGE },
    });
    const discoverBody = discover.json() as {
      acquisitions: Array<{ record: { id: string; decision: string } }>;
    };

    expect(discover.statusCode).toBe(200);
    expect(discoverBody.acquisitions[0].record.decision).toBe('approval_required');

    const approve = await server.inject({
      method: 'POST',
      url: `/api/acquisitions/${discoverBody.acquisitions[0].record.id}/approve`,
    });

    expect(approve.statusCode).toBe(200);
    const approveBody = approve.json() as {
      record: { decision: string; approval_state: string };
      skill: { name: string } | null;
    };
    expect(approveBody.record.decision).toBe('active');
    expect(approveBody.record.approval_state).toBe('approved');
    expect(approveBody.skill?.name).toBe('acquired_safe_approval_package');
  });

  it('treats OSV response without vulns key as 0 vulns (clean-package regression)', async () => {
    // OSV querybatch는 취약점 0이면 results[0]={} (vulns 키 생략) — reject하면 클린 패키지 전부 거부됨
    stubAcquisitionFetch({ osvBody: { results: [{}] } });

    const response = await server.inject({
      method: 'POST',
      url: '/api/acquisitions/discover',
      payload: { packageName: AUTO_PACKAGE },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      acquisitions: Array<{ record: { decision: string; vet_results: { osv: { status: string } } } }>;
    };
    expect(body.acquisitions[0].record.vet_results.osv.status).toBe('pass');
    expect(body.acquisitions[0].record.decision).toBe('active');
  });

  it('rejects when OSV results array is missing (fail-closed)', async () => {
    stubAcquisitionFetch({ osvBody: {} });

    const response = await server.inject({
      method: 'POST',
      url: '/api/acquisitions/discover',
      payload: { packageName: AUTO_PACKAGE },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      acquisitions: Array<{ record: { decision: string; vet_results: { osv: { status: string } } } }>;
    };
    expect(body.acquisitions[0].record.vet_results.osv.status).toBe('reject');
    expect(body.acquisitions[0].record.decision).toBe('rejected');
  });

  it('GET /api/acquisitions filters by decision', async () => {
    stubAcquisitionFetch();

    await server.inject({
      method: 'POST',
      url: '/api/acquisitions/discover',
      payload: { packageName: AUTO_PACKAGE },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/acquisitions?decision=active',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      acquisitions: Array<{ package_name: string; decision: string }>;
    };
    expect(body.acquisitions.some(record => record.package_name === AUTO_PACKAGE && record.decision === 'active')).toBe(true);
  });
});
