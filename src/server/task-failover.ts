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

const RETRYABLE_FAILOVER_PATTERNS = [
  /empty completion from provider/i,
  /no final response — process aborted \(timeout\)/i,
  /timeout waiting/i,
  // executor 레벨 AbortSignal 타임아웃 — status=failed로 귀결되는 실전 최다 패턴 (E2E task_Iu1JtUsJR6tf8auo에서 실측)
  /aborted due to timeout/i,
];

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
  if (input.status === 'timed_out') return true;
  const haystack = [input.error, input.response].filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n');
  return RETRYABLE_FAILOVER_PATTERNS.some(pattern => pattern.test(haystack));
}

export function selectFailoverCandidate(options: {
  chain?: string[];
  attemptedAgents: Iterable<string>;
  isAvailable: (agentId: string) => boolean;
}): string | null {
  if (!options.chain || options.chain.length === 0) return null;
  const attempted = new Set(options.attemptedAgents);
  for (const candidate of options.chain) {
    if (attempted.has(candidate)) continue;
    if (!options.isAvailable(candidate)) continue;
    return candidate;
  }
  return null;
}
