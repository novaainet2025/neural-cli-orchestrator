import { CommandGate } from './command-gate.js';
import {
  decideAcquisitionPolicy,
  loadAcquisitionPolicy,
  type AcquisitionDecision,
  type AcquisitionGateResult,
  type AcquisitionPolicy,
} from './acquisition-policy.js';

const OSV_QUERY_URL = 'https://api.osv.dev/v1/querybatch';
const DEPS_VERSION_BASE = 'https://api.deps.dev/v3alpha/systems/npm/packages';
const DEPS_PROJECT_BASE = 'https://api.deps.dev/v3alpha/projects';
const NPM_REGISTRY_BASE = 'https://registry.npmjs.org';
const FETCH_TIMEOUT_MS = 10_000;
const INSTALL_SCRIPT_KEYS = ['preinstall', 'install', 'postinstall', 'prepare'];

export interface AcquisitionCandidate {
  packageName: string;
  version: string;
  sourceType?: string;
  sourceRef?: string | null;
  repository?: string | null;
}

export interface AcquisitionVettingDeps {
  fetchImpl?: typeof fetch;
  policy?: AcquisitionPolicy;
  getTrustedPackageNames?: () => Promise<string[]> | string[];
  getPreviousMaintainers?: (packageName: string) => Promise<string[] | null> | string[] | null;
}

export interface AcquisitionVettingResult {
  decision: AcquisitionDecision;
  reasons: string[];
  packageName: string;
  version: string;
  packageMetadata: {
    repository: string;
    licenses: string[];
    maintainers: string[];
    publisher: string;
    scripts: Record<string, string>;
    scorecard: number;
  };
  gateResults: Record<string, AcquisitionGateResult>;
}

export async function vetAcquisitionCandidate(
  candidate: AcquisitionCandidate,
  deps: AcquisitionVettingDeps = {},
): Promise<AcquisitionVettingResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const policy = deps.policy ?? loadAcquisitionPolicy();
  let packument: any;
  try {
    packument = await fetchPackument(candidate.packageName, fetchImpl);
  } catch (error) {
    const reason = String(error);
    const gateResults = {
      osv: rejectGate(reason, 'osv querybatch'),
      scorecard: rejectGate(reason, 'deps.dev project'),
      typosquat: rejectGate(reason, 'local policy'),
      license: rejectGate(reason, 'deps.dev version'),
      scripts: rejectGate(reason, 'npm version packument'),
      maintainer: rejectGate(reason, 'npm packument'),
    };
    const decision = decideAcquisitionPolicy(gateResults, policy);
    return {
      decision: decision.decision,
      reasons: decision.reasons,
      packageName: candidate.packageName,
      version: candidate.version,
      packageMetadata: {
        repository: '',
        licenses: [],
        maintainers: [],
        publisher: '',
        scripts: {},
        scorecard: 0,
      },
      gateResults,
    };
  }
  const versionMeta = packument.versions?.[candidate.version];
  if (!versionMeta || typeof versionMeta !== 'object') {
    const gateResults = {
      osv: rejectGate(`version metadata missing for ${candidate.packageName}@${candidate.version}`, 'osv querybatch'),
      scorecard: rejectGate(`version metadata missing for ${candidate.packageName}@${candidate.version}`, 'deps.dev project'),
      typosquat: rejectGate(`version metadata missing for ${candidate.packageName}@${candidate.version}`, 'local policy'),
      license: rejectGate(`version metadata missing for ${candidate.packageName}@${candidate.version}`, 'deps.dev version'),
      scripts: rejectGate(`version metadata missing for ${candidate.packageName}@${candidate.version}`, 'npm version packument'),
      maintainer: rejectGate(`version metadata missing for ${candidate.packageName}@${candidate.version}`, 'npm packument'),
    };
    const decision = decideAcquisitionPolicy(gateResults, policy);
    return {
      decision: decision.decision,
      reasons: decision.reasons,
      packageName: candidate.packageName,
      version: candidate.version,
      packageMetadata: {
        repository: '',
        licenses: [],
        maintainers: [],
        publisher: '',
        scripts: {},
        scorecard: 0,
      },
      gateResults,
    };
  }

  const osvGate = await runOsvGate(candidate, fetchImpl);
  const depsVersion = await fetchDepsVersion(candidate, fetchImpl);
  const scorecardGate = await runScorecardGate(depsVersion, policy, fetchImpl);
  const licenseGate = runLicenseGate(depsVersion, policy);
  const trustedPackageNames = deps.getTrustedPackageNames ? await deps.getTrustedPackageNames() : [];
  const typosquatGate = runTyposquatGate(candidate.packageName, trustedPackageNames, policy);
  const scriptsGate = runScriptsGate(versionMeta.scripts);
  const previousMaintainers = deps.getPreviousMaintainers
    ? await deps.getPreviousMaintainers(candidate.packageName)
    : null;
  const maintainerGate = runMaintainerGate(packument, versionMeta, previousMaintainers);

  const gateResults = {
    osv: osvGate,
    scorecard: scorecardGate,
    typosquat: typosquatGate,
    license: licenseGate,
    scripts: scriptsGate,
    maintainer: maintainerGate,
  };

  const decision = decideAcquisitionPolicy(gateResults, policy);
  const scorecard = extractScorecard(scorecardGate.evidence);
  const licenses = extractLicenses(depsVersion);
  const maintainers = extractMaintainers(packument);
  const publisher = extractPublisher(versionMeta);
  const scripts = normalizeScripts(versionMeta.scripts);
  const repository = extractRepositoryFromDeps(depsVersion);

  return {
    decision: decision.decision,
    reasons: decision.reasons,
    packageName: candidate.packageName,
    version: candidate.version,
    packageMetadata: {
      repository,
      licenses,
      maintainers,
      publisher,
      scripts,
      scorecard,
    },
    gateResults,
  };
}

async function fetchPackument(packageName: string, fetchImpl: typeof fetch): Promise<any> {
  return fetchJson(`${NPM_REGISTRY_BASE}/${encodeURIComponent(packageName)}`, fetchImpl);
}

async function fetchDepsVersion(candidate: AcquisitionCandidate, fetchImpl: typeof fetch): Promise<any> {
  try {
    return await fetchJson(
      `${DEPS_VERSION_BASE}/${encodeURIComponent(candidate.packageName)}/versions/${encodeURIComponent(candidate.version)}`,
      fetchImpl,
    );
  } catch (error) {
    return { __error: String(error) };
  }
}

async function runOsvGate(candidate: AcquisitionCandidate, fetchImpl: typeof fetch): Promise<AcquisitionGateResult> {
  try {
    const body = {
      queries: [{
        package: { ecosystem: 'npm', name: candidate.packageName },
        version: candidate.version,
      }],
    };
    const data = await fetchJson(OSV_QUERY_URL, fetchImpl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // OSV querybatch는 취약점이 없으면 results[0]을 빈 객체({})로 반환하고 vulns 키를 생략한다
    // (T1 실측 2026-07-03: left-pad@1.3.0 → {"results":[{}]}). 키 부재 = 0 vulns이므로 pass.
    // fail-closed는 응답 구조 자체가 깨진 경우(results 배열 부재/빈 배열/비객체 엔트리)에만 적용.
    const results = data?.results;
    if (!Array.isArray(results) || results.length === 0) {
      return rejectGate('results array missing or empty', 'osv querybatch');
    }
    const first = results[0];
    if (typeof first !== 'object' || first === null) {
      return rejectGate('results[0] is not an object', 'osv querybatch');
    }
    const rawVulns = (first as Record<string, unknown>).vulns;
    if (rawVulns !== undefined && !Array.isArray(rawVulns)) {
      return rejectGate('results[0].vulns is not an array', 'osv querybatch');
    }
    const vulns = Array.isArray(rawVulns) ? rawVulns : [];
    if (vulns.length > 0) {
      const advisoryIds = vulns
        .map((entry: any) => entry?.id)
        .filter((id: unknown): id is string => typeof id === 'string');
      return rejectGate({ vulns: advisoryIds, count: advisoryIds.length }, 'osv querybatch');
    }
    return passGate('0 vulns', 'osv querybatch');
  } catch (error) {
    return rejectGate(String(error), 'osv querybatch');
  }
}

async function runScorecardGate(depsVersion: any, policy: AcquisitionPolicy, fetchImpl: typeof fetch): Promise<AcquisitionGateResult> {
  if (depsVersion?.__error) return rejectGate(depsVersion.__error, 'deps.dev version');
  const repository = extractRepositoryFromDeps(depsVersion);
  if (!repository) return rejectGate('relatedProjects repo key missing', 'deps.dev version');

  try {
    const data = await fetchJson(`${DEPS_PROJECT_BASE}/${encodeURIComponent(repository)}`, fetchImpl);
    const overallScore = data?.scorecard?.overallScore;
    if (typeof overallScore !== 'number') {
      return rejectGate('scorecard.overallScore missing', 'deps.dev project');
    }
    if (overallScore < policy.scorecard.rejectBelow) {
      return rejectGate({ repository, overallScore }, 'deps.dev project');
    }
    if (overallScore < policy.scorecard.approvalBelow) {
      return approvalGate({ repository, overallScore }, 'deps.dev project');
    }
    return passGate({ repository, overallScore }, 'deps.dev project');
  } catch (error) {
    return rejectGate(String(error), 'deps.dev project');
  }
}

function runLicenseGate(depsVersion: any, policy: AcquisitionPolicy): AcquisitionGateResult {
  if (depsVersion?.__error) return rejectGate(depsVersion.__error, 'deps.dev version');
  const licenses = extractLicenses(depsVersion);
  if (licenses.length === 0) return rejectGate('licenses missing', 'deps.dev version');
  const disallowed = licenses.filter(license => !policy.licenses.allow.includes(license));
  if (disallowed.length > 0) {
    return rejectGate({ licenses, disallowed }, 'deps.dev version');
  }
  return passGate({ licenses }, 'deps.dev version');
}

function runTyposquatGate(packageName: string, trustedPackageNames: string[], policy: AcquisitionPolicy): AcquisitionGateResult {
  const corpus = [...new Set([...policy.popularPackages, ...trustedPackageNames])]
    .filter(name => name !== packageName);
  if (corpus.length === 0) return rejectGate('comparison corpus missing', 'local policy');

  let closestName = '';
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const entry of corpus) {
    const distance = levenshtein(normalizeForDistance(packageName), normalizeForDistance(entry));
    if (distance < closestDistance) {
      closestDistance = distance;
      closestName = entry;
    }
  }

  if (!Number.isFinite(closestDistance)) return rejectGate('distance computation failed', 'local policy');
  if (closestDistance <= 1) {
    return rejectGate({ closestName, closestDistance }, 'local policy');
  }
  if (closestDistance <= policy.typosquat.approvalDistance) {
    return approvalGate({ closestName, closestDistance }, 'local policy');
  }
  return passGate({ closestName, closestDistance }, 'local policy');
}

function runScriptsGate(rawScripts: unknown): AcquisitionGateResult {
  const scripts = normalizeScripts(rawScripts);
  const installScripts = Object.fromEntries(
    Object.entries(scripts).filter(([name]) => INSTALL_SCRIPT_KEYS.includes(name)),
  );
  if (Object.keys(installScripts).length === 0) {
    return passGate('no install scripts', 'npm version packument');
  }

  const gate = new CommandGate({ allowedCommands: [], deniedCommands: [] });
  for (const [name, command] of Object.entries(installScripts)) {
    const result = gate.validate('sh', ['-c', command]);
    if (!result.ok) {
      return rejectGate({ script: name, command, reason: result.reason }, 'npm version packument');
    }
  }

  return approvalGate({ installScripts }, 'npm version packument');
}

function runMaintainerGate(packument: any, versionMeta: any, previousMaintainers: string[] | null): AcquisitionGateResult {
  const maintainers = extractMaintainers(packument);
  const publisher = extractPublisher(versionMeta);
  if (maintainers.length === 0 || !publisher) {
    return rejectGate({ maintainers, publisher }, 'npm packument');
  }

  if (!previousMaintainers || previousMaintainers.length === 0) {
    return approvalGate({ maintainers, publisher, reason: 'first observation' }, 'npm packument');
  }

  const current = [...new Set(maintainers)].sort();
  const previous = [...new Set(previousMaintainers)].sort();
  if (JSON.stringify(current) !== JSON.stringify(previous)) {
    return approvalGate({ maintainers: current, previous, publisher }, 'npm packument');
  }

  return passGate({ maintainers: current, publisher }, 'npm packument');
}

async function fetchJson(url: string, fetchImpl: typeof fetch, init?: RequestInit): Promise<any> {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${url} ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.json();
}

function extractRepositoryFromDeps(depsVersion: any): string {
  const relatedProjects = Array.isArray(depsVersion?.relatedProjects) ? depsVersion.relatedProjects : [];
  for (const project of relatedProjects) {
    const candidates = [
      project?.projectKey?.name,
      project?.projectKey?.id,
      project?.name,
      project?.repository,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.includes('/')) return candidate;
    }
  }
  const links = Array.isArray(depsVersion?.links) ? depsVersion.links : [];
  for (const link of links) {
    const url = typeof link?.url === 'string' ? link.url : typeof link === 'string' ? link : '';
    const match = url.match(/github\.com\/([^/]+\/[^/#?]+)/i);
    if (match) return match[1];
  }
  return '';
}

function extractLicenses(depsVersion: any): string[] {
  const licenses = new Set<string>();
  const entries = Array.isArray(depsVersion?.licenses) ? depsVersion.licenses : [];
  for (const entry of entries) {
    const values = [
      entry?.spdxId,
      entry?.license?.spdxId,
      entry?.license?.name,
      entry?.name,
    ];
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) licenses.add(value.trim());
    }
  }
  const details = Array.isArray(depsVersion?.licenseDetails) ? depsVersion.licenseDetails : [];
  for (const entry of details) {
    const value = entry?.spdx;
    if (typeof value === 'string' && value.trim()) licenses.add(value.trim());
  }
  return [...licenses];
}

function extractMaintainers(packument: any): string[] {
  const maintainers = Array.isArray(packument?.maintainers) ? packument.maintainers : [];
  return maintainers
    .map((entry: any) => entry?.name || entry?.email)
    .filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0);
}

function extractPublisher(versionMeta: any): string {
  if (typeof versionMeta?._npmUser?.name === 'string' && versionMeta._npmUser.name.trim()) {
    return versionMeta._npmUser.name.trim();
  }
  if (typeof versionMeta?._npmUser?.email === 'string' && versionMeta._npmUser.email.trim()) {
    return versionMeta._npmUser.email.trim();
  }
  return '';
}

function normalizeScripts(rawScripts: unknown): Record<string, string> {
  if (!rawScripts || typeof rawScripts !== 'object') return {};
  return Object.fromEntries(
    Object.entries(rawScripts as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'string')
      .map(([name, value]) => [name, value as string]),
  );
}

function normalizeForDistance(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i++) table[i][0] = i;
  for (let j = 0; j < cols; j++) table[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      table[i][j] = Math.min(
        table[i - 1][j] + 1,
        table[i][j - 1] + 1,
        table[i - 1][j - 1] + cost,
      );
    }
  }

  return table[a.length][b.length];
}

function extractScorecard(evidence: unknown): number {
  if (typeof evidence === 'object' && evidence && typeof (evidence as { overallScore?: unknown }).overallScore === 'number') {
    return (evidence as { overallScore: number }).overallScore;
  }
  return 0;
}

function passGate(evidence: unknown, source: string): AcquisitionGateResult {
  return { status: 'pass', evidence, source, failMode: 'closed' };
}

function approvalGate(evidence: unknown, source: string): AcquisitionGateResult {
  return { status: 'approval_required', evidence, source, failMode: 'closed' };
}

function rejectGate(evidence: unknown, source: string): AcquisitionGateResult {
  return { status: 'reject', evidence, source, failMode: 'closed' };
}
