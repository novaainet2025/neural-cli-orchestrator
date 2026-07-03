import { searchGitHub, type RepoCandidate } from './github-agent.js';

export interface AcquisitionDiscoveryInput {
  packageName?: string;
  version?: string;
  goal?: string;
  limit?: number;
}

export interface DiscoveredAcquisition {
  packageName: string;
  version: string | null;
  sourceType: 'manual' | 'github';
  sourceRef: string | null;
  evidence: Record<string, unknown>;
}

export async function discoverAcquisitions(input: AcquisitionDiscoveryInput): Promise<DiscoveredAcquisition[]> {
  if (input.packageName) {
    return [{
      packageName: normalizeNpmPackageName(input.packageName),
      version: input.version ?? null,
      sourceType: 'manual',
      sourceRef: null,
      evidence: { packageName: input.packageName, version: input.version ?? null },
    }];
  }

  if (!input.goal) return [];

  const repos = await searchGitHub(input.goal, input.limit ?? 5);
  return repos.map(repo => normalizeRepoCandidate(repo));
}

export function normalizeNpmPackageName(raw: string): string {
  return raw.trim().replace(/^https?:\/\/registry\.npmjs\.org\//, '').replace(/\/+$/, '').toLowerCase();
}

function normalizeRepoCandidate(repo: RepoCandidate): DiscoveredAcquisition {
  const repoName = repo.name.split('/').pop() ?? repo.name;
  const packageName = normalizeNpmPackageName(
    repoName
      .replace(/\.git$/i, '')
      .replace(/\.js$/i, '')
      .replace(/_/g, '-'),
  );

  return {
    packageName,
    version: null,
    sourceType: 'github',
    sourceRef: repo.url,
    evidence: {
      repo: repo.name,
      url: repo.url,
      transplantScore: repo.transplantScore,
      transplantReason: repo.transplantReason,
    },
  };
}
