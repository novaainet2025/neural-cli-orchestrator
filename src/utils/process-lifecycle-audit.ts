import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { env } from './config.js';

export type ProcessLifecycleEvent =
  | 'startup'
  | 'signal'
  | 'uncaught_exception'
  | 'exit';

export interface ProcessLifecycleDetails {
  signal?: string;
  code?: number;
  origin?: string;
  errorName?: string;
  errorMessage?: string;
}

export function processLifecycleAuditPath(): string {
  return process.env.NCO_PROCESS_LIFECYCLE_LOG
    || resolve(env.ROOT, 'logs/nco-process-lifecycle.ndjson');
}

/**
 * Synchronous and intentionally independent from Pino. A process can receive a
 * signal while the event loop or logger transport is congested; appendFileSync
 * gives the next incident investigation durable evidence that the JS handler
 * actually ran. Audit failure must never interfere with process lifecycle.
 */
export function recordProcessLifecycle(
  event: ProcessLifecycleEvent,
  details: ProcessLifecycleDetails = {},
  path = processLifecycleAuditPath(),
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      pid: process.pid,
      ppid: process.ppid,
      uptimeSeconds: Number(process.uptime().toFixed(3)),
      ...details,
    })}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Best-effort audit only. Shutdown and crash semantics must stay unchanged.
  }
}
