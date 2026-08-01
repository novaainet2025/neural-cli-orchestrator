import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod/v4';
import { env } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('task-failover');

const FAILOVER_CHAINS_PATH = resolve(env.ROOT, 'config', 'failover-chains.json');
const FailoverChainsSchema = z.record(z.string(), z.array(z.string().min(1)));

export type FailoverChainsConfig = z.infer<typeof FailoverChainsSchema>;

let cachedFailoverChains: FailoverChainsConfig | null = null;
let cachedFailoverChainsWarning: string | null = null;

export type FailureClass =
  | 'provider_unavailable'
  | 'provider_limit'
  | 'transient'
  | 'verifier'
  | 'silent_output'
  | 'orphan'
  | 'policy';

const POLICY_FAILURE_PATTERNS = [
  /\bquality_rejected\b/i,
  /\bevidence_gate_blocked\b/i,
  /\b(?:user|operator)[ _-]?cancelled\b/i,
];

const PROVIDER_UNAVAILABLE_PATTERN =
  /\b(?:circuit breaker open|provider[_ -]unavailable|connection error|ECONNREFUSED|fetch failed|socket hang up|stream disconnected|error sending request)\b/i;

export function isProviderUnavailableFailureText(
  value: string | null | undefined,
): boolean {
  return typeof value === 'string' && PROVIDER_UNAVAILABLE_PATTERN.test(value);
}

/**
 * 실패를 단일 분류기로 정규화한다. 과거의 retryable 정규식 화이트리스트는 실측 실패의
 * 90% 이상을 조용히 탈락시켰다. 사용자/품질 정책에 의한 명시적 종결만 non-retryable로
 * 두고, 나머지 실행 실패는 bounded retry/failover 체인이 판단하게 한다.
 */
export function classifyFailure(input: {
  status?: string | null;
  error?: string | null;
  response?: string | null;
}): FailureClass | null {
  const status = input.status?.toLowerCase() ?? '';
  const haystack = [input.error, input.response]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');

  if (status === 'cancelled' || POLICY_FAILURE_PATTERNS.some(pattern => pattern.test(haystack))) {
    return 'policy';
  }
  // Check the explicit availability envelope before its trailing reason
  // (for example "(open/quota)") can be mistaken for a raw quota failure.
  if (isProviderUnavailableFailureText(haystack)) {
    return 'provider_unavailable';
  }
  if (/\b(?:rate[ -]?limit|quota|usage limit|weekly limit|monthly limit|429)\b/i.test(haystack)) {
    return 'provider_limit';
  }
  if (/\bverifier failed\b/i.test(haystack)) return 'verifier';
  if (/\b(?:silent-failure|empty completion|no final response)\b/i.test(haystack)) return 'silent_output';
  if (status === 'lease_expired' || /\b(?:orphaned|lease_expired)\b/i.test(haystack)) return 'orphan';
  if (
    status === 'failed'
    || status === 'timed_out'
    || /\b(?:timeout|timed out|aborted|queue_wait_timeout|unknown: failure)\b/i.test(haystack)
  ) {
    return 'transient';
  }
  // 이 함수는 실패 종결 경로에서 호출된다. 명시적 성공 상태가 아닌데 status/error가
  // 존재하면 알 수 없는 실행 실패로 fail-open retry하여 조용한 탈락을 막는다.
  if (!['completed', 'done', 'success'].includes(status) && (status || haystack)) {
    return 'transient';
  }
  return null;
}

export function loadFailoverChainsConfig(): FailoverChainsConfig | null {
  if (cachedFailoverChains) return cachedFailoverChains;
  try {
    if (!existsSync(FAILOVER_CHAINS_PATH)) {
      if (cachedFailoverChainsWarning !== 'missing') {
        cachedFailoverChainsWarning = 'missing';
        log.warn({ path: FAILOVER_CHAINS_PATH }, 'failover-chains config missing — automatic task failover disabled');
      }
      return null;
    }

    const parsed = FailoverChainsSchema.parse(JSON.parse(readFileSync(FAILOVER_CHAINS_PATH, 'utf-8')));
    cachedFailoverChains = parsed;
    cachedFailoverChainsWarning = null;
    return cachedFailoverChains;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cachedFailoverChainsWarning !== message) {
      cachedFailoverChainsWarning = message;
      log.warn({ err: message, path: FAILOVER_CHAINS_PATH }, 'failover-chains config invalid — automatic task failover disabled');
    }
    return null;
  }
}

export function isRetryableFailoverFailure(input: {
  status?: string | null;
  error?: string | null;
  response?: string | null;
}): boolean {
  const failureClass = classifyFailure(input);
  return failureClass !== null && failureClass !== 'policy';
}

const PREFER_TEAM_MEMBERS_DISABLED = new Set(['0', 'false', 'off']);

/**
 * Prefer an untried, available member of the task's declared team before the
 * provider-global fallback chain. An absent/exhausted roster falls through to
 * the existing chain, so this cannot reduce the available candidate set.
 * Runtime rollback: NCO_FAILOVER_PREFER_TEAM_MEMBERS=off.
 */
export function failoverPreferTeamMembersEnabled(
  toggle: string | undefined = process.env.NCO_FAILOVER_PREFER_TEAM_MEMBERS,
): boolean {
  return !PREFER_TEAM_MEMBERS_DISABLED.has(toggle?.trim().toLowerCase() ?? '');
}

export function selectFailoverCandidate(options: {
  chain?: string[];
  preferred?: readonly string[];
  attemptedAgents: Iterable<string>;
  isAvailable: (agentId: string) => boolean;
}): string | null {
  const attempted = new Set(options.attemptedAgents);
  const pick = (candidates: readonly string[] | undefined): string | null => {
    if (!candidates || candidates.length === 0) return null;
    for (const candidate of candidates) {
      if (attempted.has(candidate)) continue;
      if (!options.isAvailable(candidate)) continue;
      return candidate;
    }
    return null;
  };
  return pick(options.preferred) ?? pick(options.chain);
}
