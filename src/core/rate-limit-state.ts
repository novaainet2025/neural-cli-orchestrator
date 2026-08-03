export const ACTIVE_RATE_LIMIT_PREDICATE =
  `is_limited=1 AND reset_at IS NOT NULL AND datetime(reset_at) > datetime('now')`;

interface RateLimitDb {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
}

/**
 * reset_at이 없는 legacy/stale 행은 영구 차단 근거로 사용하지 않는다.
 * 무기한 auth/quota 차단은 circuit-breaker registry가 별도로 소유한다.
 */
export function listActivelyRateLimited(db: RateLimitDb): Set<string> {
  const rows = db.prepare(
    `SELECT agent_id FROM rate_limit_state WHERE ${ACTIVE_RATE_LIMIT_PREDICATE}`,
  ).all() as Array<{ agent_id: string }>;
  return new Set(rows.map((row) => row.agent_id));
}

export function isAgentActivelyRateLimited(db: RateLimitDb, agentId: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 AS active FROM rate_limit_state
     WHERE agent_id=? AND ${ACTIVE_RATE_LIMIT_PREDICATE}`,
  ).get(agentId));
}
