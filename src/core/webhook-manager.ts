/**
 * WebhookManager — OpenClaw/Hermes webhook feature transplant
 * Dynamic webhook route registration + HMAC verification + NCO action dispatch
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { createId } from '../utils/id.js';
import { getDb } from '../storage/database.js';
import { eventBus } from './event-bus.js';
import { createLogger } from '../utils/logger.js';
import { resolveInternalProjectDir } from '../utils/project-dir.js';

const log = createLogger('webhook-manager');

export interface WebhookRouteDef {
  id?: string;
  /** URL path under /api/webhook/ e.g. "github/push" or "slack/events" */
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  description?: string;
  /** What to do when triggered */
  actionType?: 'nco_task' | 'forward' | 'log';
  /** JSON payload template: {ai,prompt} | {url,method} | {} */
  actionPayload?: Record<string, unknown>;
  /** Optional HMAC-SHA256 secret for request verification */
  secret?: string;
  enabled?: boolean;
}

export interface WebhookRouteRecord extends Required<Omit<WebhookRouteDef, 'id'>> {
  id: string;
  hitCount: number;
  lastHitAt?: string;
  createdAt: string;
}

export function registerWebhook(def: WebhookRouteDef): WebhookRouteRecord {
  const db = getDb();
  const id = def.id || createId();
  const path = def.path.replace(/^\/+/, ''); // strip leading slashes

  const record: WebhookRouteRecord = {
    id,
    path,
    method: def.method || 'POST',
    description: def.description || '',
    actionType: def.actionType || 'log',
    actionPayload: def.actionPayload || {},
    secret: def.secret || '',
    enabled: def.enabled ?? true,
    hitCount: 0,
    lastHitAt: undefined,
    createdAt: new Date().toISOString(),
  };

  db.prepare(`
    INSERT OR REPLACE INTO webhook_routes
      (id, path, method, description, action_type, action_payload, secret, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, path, record.method, record.description, record.actionType,
    JSON.stringify(record.actionPayload), record.secret, record.enabled ? 1 : 0);

  log.info({ id, path, method: record.method }, 'Webhook registered');
  return record;
}

export function unregisterWebhook(id: string): boolean {
  try {
    const db = getDb();
    const r = db.prepare(`DELETE FROM webhook_routes WHERE id=?`).run(id);
    return r.changes > 0;
  } catch { return false; }
}

export function listWebhooks(): WebhookRouteRecord[] {
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM webhook_routes ORDER BY created_at DESC`).all() as any[];
    return rows.map(rowToRecord);
  } catch { return []; }
}

export function getWebhookByPath(path: string, method: string): WebhookRouteRecord | null {
  try {
    const db = getDb();
    const r = db.prepare(
      `SELECT * FROM webhook_routes WHERE path=? AND method=? AND enabled=1`
    ).get(path.replace(/^\/+/, ''), method.toUpperCase()) as any;
    return r ? rowToRecord(r) : null;
  } catch { return null; }
}

/** Dispatch an incoming webhook request */
export async function dispatchWebhook(
  path: string,
  method: string,
  body: unknown,
  rawBody: string,
  signature?: string,
): Promise<{ status: number; message: string }> {
  const route = getWebhookByPath(path, method);
  if (!route) {
    return { status: 404, message: `No webhook registered for ${method} /api/webhook/${path}` };
  }

  // HMAC verification
  if (route.secret) {
    if (!signature) {
      return { status: 401, message: 'Missing X-Hub-Signature-256 header' };
    }
    const expected = 'sha256=' + createHmac('sha256', route.secret).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return { status: 403, message: 'Invalid signature' };
    }
  }

  // Update hit count
  try {
    const db = getDb();
    db.prepare(`UPDATE webhook_routes SET hit_count=hit_count+1, last_hit_at=datetime('now') WHERE id=?`).run(route.id);
  } catch { /* ignore */ }

  await eventBus.publish({ type: 'webhook:received' as any, taskId: route.id, agentId: 'webhook-manager' });
  log.info({ path, method, actionType: route.actionType }, 'Webhook dispatched');

  // Execute action
  const NCO_API = process.env.NCO_API_URL || 'http://localhost:6200';
  const TOKEN = process.env.NCO_API_TOKEN || 'nco_secret_key_change_me_in_production';

  try {
    if (route.actionType === 'nco_task') {
      const { ai, prompt: promptTemplate } = route.actionPayload as { ai: string; prompt: string };
      // Simple template substitution: {{body}} → JSON.stringify(body)
      const prompt = (promptTemplate || '').replace('{{body}}', JSON.stringify(body));
      await fetch(`${NCO_API}/api/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          ai: ai || 'openrouter',
          prompt,
          callerAgentId: 'webhook-manager',
          metadata: { projectDir: resolveInternalProjectDir() },
        }),
        signal: AbortSignal.timeout(10_000),
      });

    } else if (route.actionType === 'forward') {
      const { url, method: fMethod = 'POST' } = route.actionPayload as { url: string; method?: string };
      await fetch(url, {
        method: fMethod,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

    } else {
      // log only
      log.info({ path, body: JSON.stringify(body).slice(0, 200) }, 'Webhook payload logged');
    }
  } catch (err: any) {
    log.error({ err: err.message }, 'Webhook action failed');
    return { status: 500, message: `Action failed: ${err.message}` };
  }

  return { status: 200, message: 'ok' };
}

function rowToRecord(r: any): WebhookRouteRecord {
  return {
    id: r.id,
    path: r.path,
    method: r.method as WebhookRouteRecord['method'],
    description: r.description || '',
    actionType: r.action_type as WebhookRouteRecord['actionType'],
    actionPayload: JSON.parse(r.action_payload || '{}'),
    secret: r.secret || '',
    enabled: r.enabled === 1,
    hitCount: r.hit_count,
    lastHitAt: r.last_hit_at,
    createdAt: r.created_at,
  };
}
