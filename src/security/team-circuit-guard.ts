import type Database from 'better-sqlite3';
import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('team-circuit-guard');

export const TEAM_CIRCUIT_AGENT_PREFIX = 'team:';
const TEAM_CIRCUIT_GUARD_DISABLED = new Set(['0', 'false', 'off']);
const DEFAULT_WINDOW_HOURS = 48;
const DEFAULT_FAILURE_THRESHOLD = 2;

export interface TeamCircuitPolicy {
  teamId: string;
  windowHours?: number;
  failureThreshold?: number;
}

const DEFAULT_TEAM_CIRCUIT_POLICIES: readonly TeamCircuitPolicy[] = [
  { teamId: 'team_cli-assurance-2026', windowHours: 48, failureThreshold: 2 },
];

export function isTeamCircuitGuardEnabled(
  toggle: string | undefined = process.env.NCO_TEAM_CIRCUIT_GUARD,
): boolean {
  return !TEAM_CIRCUIT_GUARD_DISABLED.has(toggle?.trim().toLowerCase() ?? '');
}

export function teamCircuitAgentId(teamId: string): string {
  return `${TEAM_CIRCUIT_AGENT_PREFIX}${teamId}`;
}

function normalizeFailureSignature(error: string | null | undefined): string {
  const trimmed = (error ?? '').trim();
  if (!trimmed) return 'unknown';
  return trimmed.slice(0, 160);
}

export function refreshTeamCircuitFromRecentFailures(
  database: Database.Database,
  teamId: string,
  policy: TeamCircuitPolicy = { teamId },
): boolean {
  if (!isTeamCircuitGuardEnabled()) return false;

  const windowHours = policy.windowHours ?? DEFAULT_WINDOW_HOURS;
  const failureThreshold = policy.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const rows = database.prepare(`
    SELECT error, COUNT(*) AS count
    FROM tasks
    WHERE team_id = ?
      AND status IN ('failed', 'timed_out', 'lease_expired')
      AND julianday(created_at) >= julianday('now', ?)
      AND COALESCE(error, '') <> ''
    GROUP BY error
    ORDER BY count DESC
    LIMIT 1
  `).all(teamId, `-${windowHours} hours`) as Array<{ error: string | null; count: number }>;

  const top = rows[0];
  if (!top || top.count < failureThreshold) return false;

  const agentId = teamCircuitAgentId(teamId);
  const now = Date.now();
  const cooldownUntil = now + (60 * 60 * 1000);
  const signature = normalizeFailureSignature(top.error);
  database.prepare(`
    INSERT INTO circuit_states (agent_id, state, failure_count, opened_at, cooldown_until, reason)
    VALUES (?, 'open', ?, ?, ?, 'generic')
    ON CONFLICT(agent_id) DO UPDATE SET
      state='open',
      failure_count=excluded.failure_count,
      opened_at=excluded.opened_at,
      cooldown_until=excluded.cooldown_until,
      reason='generic'
  `).run(agentId, top.count, now, cooldownUntil);
  log.warn({ teamId, agentId, signature, count: top.count }, 'team circuit opened from repeated failures');
  return true;
}

export function refreshConfiguredTeamCircuits(
  database: Database.Database = getDb(),
  policies: readonly TeamCircuitPolicy[] = DEFAULT_TEAM_CIRCUIT_POLICIES,
): number {
  let opened = 0;
  for (const policy of policies) {
    if (refreshTeamCircuitFromRecentFailures(database, policy.teamId, policy)) {
      opened += 1;
    }
  }
  return opened;
}

export function isTeamCircuitOpen(
  teamId: string,
  database: Database.Database = getDb(),
): boolean {
  if (!isTeamCircuitGuardEnabled()) return false;
  const row = database.prepare(`
    SELECT state, cooldown_until
    FROM circuit_states
    WHERE agent_id = ?
  `).get(teamCircuitAgentId(teamId)) as { state: string; cooldown_until: number | null } | undefined;
  if (!row || row.state !== 'open') return false;
  if (row.cooldown_until != null && row.cooldown_until <= Date.now()) return false;
  return true;
}
