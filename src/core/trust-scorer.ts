import { getDb } from '../storage/database.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_SAMPLE_SIZE = 10;
const CLAIM_PATTERN = /done:|완료|성공/iu;

export interface TrustScores {
  verifiedSr: number;
  claimAccuracy: number | null;
  sampleSize: number;
}

type TaskTrustRow = {
  response: string | null;
  verifier_result_json: string;
};

type CacheEntry = {
  expiresAt: number;
  value: TrustScores | null;
};

const cache = new Map<string, CacheEntry>();

function verifierPassed(verifierResultJson: string): boolean {
  try {
    const result = JSON.parse(verifierResultJson) as { passed?: unknown };
    return result.passed === true;
  } catch {
    return false;
  }
}

function makesCompletionClaim(response: string | null): boolean {
  return CLAIM_PATTERN.test((response ?? '').slice(0, 400));
}

export function computeTrustScores(agentId?: string): TrustScores | null {
  const cacheKey = agentId === undefined ? 'all' : `agent:${agentId}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const rows = (agentId === undefined
    ? getDb().prepare(`
        SELECT response, verifier_result_json
        FROM tasks
        WHERE status = 'completed' AND verifier_result_json IS NOT NULL
      `).all()
    : getDb().prepare(`
        SELECT response, verifier_result_json
        FROM tasks
        WHERE status = 'completed'
          AND verifier_result_json IS NOT NULL
          AND assigned_to = ?
      `).all(agentId)) as TaskTrustRow[];

  let value: TrustScores | null = null;
  if (rows.length >= MIN_SAMPLE_SIZE) {
    let verifiedPasses = 0;
    let claimCount = 0;
    let accurateClaims = 0;

    for (const row of rows) {
      const passed = verifierPassed(row.verifier_result_json);
      const claimed = makesCompletionClaim(row.response);
      if (passed) verifiedPasses += 1;
      if (claimed) {
        claimCount += 1;
        if (passed) accurateClaims += 1;
      }
    }

    value = {
      verifiedSr: verifiedPasses / rows.length,
      claimAccuracy: claimCount > 0 ? accurateClaims / claimCount : null,
      sampleSize: rows.length,
    };
  }

  cache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, value });
  return value;
}
