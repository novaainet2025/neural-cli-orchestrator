import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod/v4';

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const TEXT = z.string().min(1).max(4_096).refine(value => !value.includes('\0'));
const EXACT_PROMPT = z.string().min(1).max(100_000).refine(value => !value.includes('\0'));
const SHA256 = z.string().regex(/^sha256:[a-f0-9]{64}$/i);
const SESSION_LIMIT = 512;
const DISPATCH_LIMIT = 2_048;
const LEASE_MS = 15 * 60_000;

type ProviderHealthStatus = 'ready' | 'busy' | 'quota' | 'auth' | 'unavailable' | 'local-ready' | 'unknown';

function boundedCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizedIso(value: string | number | null | undefined): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value).toISOString() : undefined;
  const parsed = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function localProvider(provider: { id: string; type: string; endpoint?: string }): boolean {
  if (provider.type === 'local' || provider.id === 'ollama') return true;
  if (!provider.endpoint) return false;
  try {
    const host = new URL(provider.endpoint).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function errorClass(raw: string | null | undefined): 'auth' | 'quota' | 'generic' | null {
  if (!raw) return null;
  if (/(?:unauthori[sz]ed|forbidden|login|required|auth|credential|api[_ -]?key|401|403)/i.test(raw)) return 'auth';
  if (/(?:quota|rate.?limit|too many requests|429|exhausted|usage.?limit)/i.test(raw)) return 'quota';
  return 'generic';
}

const RegisterInput = z.object({
  externalSessionId: ID,
  paneKey: z.string().min(1).max(256).refine(value => !value.includes('\0')),
  providerId: ID,
  workspaceRoot: TEXT,
  owner: z.literal('nova-use'),
  transport: z.literal('pty'),
}).strict();

const DispatchInput = z.object({
  clientDispatchId: ID,
  runId: ID,
  prompt: EXACT_PROMPT,
  role: z.string().min(1).max(256).refine(value => !value.includes('\0')),
  participants: z.array(TEXT).max(32),
}).strict();

const ApprovalInput = z.object({
  commandArgs: z.array(TEXT).min(1).max(64),
  category: z.enum(['read', 'write', 'test', 'build', 'execute', 'network']),
  target: TEXT,
  scope: TEXT,
}).strict();

const EventInput = z.object({
  status: z.enum(['ready', 'working', 'waiting_preauth', 'completed', 'failed', 'cancelled']),
  outputDigest: SHA256,
  evidence: z.record(z.string(), z.unknown()),
}).strict();

interface ExternalSession {
  sessionId: string;
  externalSessionId: string;
  paneKey: string;
  providerId: string;
  workspaceRoot: string;
  capabilityProfileHash: string;
  leaseExpiresAtMs: number;
}

interface ExternalDispatch {
  taskId: string;
  dispatchId: string;
  sessionId: string;
  externalSessionId: string;
  exactPayload: string;
  payloadSha256: string;
  acceptedAt: string;
  status: 'ready' | 'working' | 'waiting_preauth' | 'completed' | 'failed' | 'cancelled';
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function identifier(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function receipt(kind: string, fields: Record<string, unknown>): Record<string, unknown> {
  const acceptedAt = new Date().toISOString();
  const evidenceSha256 = digest(JSON.stringify({ kind, acceptedAt, ...fields }));
  return {
    schema: 'nco-external-pty-receipt/v1',
    receiptId: identifier('receipt'),
    kind,
    acceptedAt,
    evidenceSha256,
    ...fields,
  };
}

function invalid(reply: FastifyReply, issues: unknown): FastifyReply {
  return reply.code(400).send({ error: 'invalid_request', issues });
}

function destructiveCommand(commandArgs: string[]): boolean {
  const command = commandArgs.join(' ').toLowerCase();
  return /(?:^|\s)(?:rm\s+-[^\n]*r[^\n]*f|git\s+push[^\n]*--force|mkfs(?:\.|\s)|dd\s+if=|diskpart(?:\s|$)|format(?:\.com)?\s|shutdown(?:\.exe)?\s|reboot(?:\s|$)|drop\s+(?:database|table)|remove-item[^\n]*-recurse|del\s+\/[sq])/.test(command);
}

export async function registerExternalPtyRoutes(app: FastifyInstance): Promise<void> {
  const sessions = new Map<string, ExternalSession>();
  const sessionsByExternalId = new Map<string, string>();
  const dispatches = new Map<string, ExternalDispatch>();

  app.get('/api/provider-control', async (_request, reply) => {
    const [databaseModule, runtimeModule, stateModule, circuitModule] = await Promise.all([
      import('../../storage/database.js'),
      import('../../core/provider-runtime-coordinator.js'),
      import('../../core/shared-state.js'),
      import('../../security/circuit-breaker-registry.js'),
    ]);
    const registry = runtimeModule.providerRuntimeCoordinator.getSnapshot();
    if (!registry) return reply.code(503).send({ error: 'provider_control_registry_unavailable' });

    const database = databaseModule.getDb();
    const states = await stateModule.sharedState.getAllAgentStates();
    const workflowRows = database.prepare(`
      SELECT assigned_to AS provider_id,
             SUM(CASE
               WHEN status IN ('running','streaming')
                AND lease_expires_at IS NOT NULL
                AND datetime(lease_expires_at) > datetime('now')
               THEN 1 ELSE 0 END) AS running,
             SUM(CASE WHEN status IN ('pending','queued','assigned') THEN 1 ELSE 0 END) AS queued,
             SUM(CASE WHEN created_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS day_tasks,
             SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS week_tasks,
             MAX(created_at) AS last_task_at,
             MAX(CASE WHEN status IN ('completed','reviewing') THEN created_at END) AS last_success_at
      FROM tasks
      WHERE assigned_to IS NOT NULL
      GROUP BY assigned_to
    `).all() as Array<{
      provider_id: string;
      running: number;
      queued: number;
      day_tasks: number;
      week_tasks: number;
      last_task_at: string | null;
      last_success_at: string | null;
    }>;
    const workflow = new Map(workflowRows.map(row => [row.provider_id, row]));
    const rateRows = database.prepare(`
      SELECT agent_id, is_limited, reset_at
      FROM rate_limit_state
      WHERE is_limited=1
        AND reset_at IS NOT NULL
        AND datetime(reset_at) > datetime('now')
    `).all() as Array<{ agent_id: string; is_limited: number; reset_at: string | null }>;
    const rateLimits = new Map(rateRows.map(row => [row.agent_id, row]));

    const providers = registry.providers.map(provider => {
      const state = states[provider.id];
      const availability = circuitModule.circuitBreakerRegistry.getAvailability(provider.id);
      const row = workflow.get(provider.id);
      const rateLimit = rateLimits.get(provider.id);
      const local = localProvider(provider);
      const classifiedError = errorClass(state?.health?.lastError ?? null);
      let healthStatus: ProviderHealthStatus = local ? 'local-ready' : 'ready';
      let healthReason: string | undefined;
      if (!provider.enabled) {
        healthStatus = 'unavailable';
        healthReason = 'provider_disabled';
      } else if (!provider.runtime.loaded) {
        healthStatus = 'unavailable';
        healthReason = 'runtime_not_loaded';
      } else if (rateLimit?.is_limited) {
        healthStatus = 'quota';
        healthReason = 'rate_limited';
      } else if (classifiedError === 'auth') {
        healthStatus = 'auth';
        healthReason = 'authentication_required';
      } else if (!availability.available) {
        healthStatus = classifiedError === 'quota' ? 'quota' : 'unavailable';
        healthReason = classifiedError === 'quota' ? 'quota_exhausted' : `circuit_${availability.circuitState}`;
      } else if (['working', 'thinking', 'coding', 'reviewing', 'discussing'].includes(state?.status ?? '')) {
        healthStatus = 'busy';
      }
      const observedAt = normalizedIso(state?.lastActionAt ?? null);
      const resetsAt = normalizedIso(rateLimit?.reset_at ?? null);
      const lastTaskAt = normalizedIso(row?.last_task_at ?? null);
      const authConfigured = Boolean(provider.auth?.ref && process.env[provider.auth.ref]);
      return {
        id: provider.id,
        name: provider.name,
        enabled: provider.enabled,
        runtimeScope: local ? 'local' : process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP ? 'wsl' : 'host',
        desiredInstallState: provider.enabled ? 'managed' : 'absent',
        install: { status: provider.runtime.loaded ? 'installed' : 'unknown' },
        auth: {
          status: local ? 'not-required' : healthStatus === 'auth' ? 'required' : authConfigured || Boolean(row?.last_success_at) ? 'ready' : 'unknown',
          profileCount: 0,
        },
        health: {
          status: healthStatus,
          ...(healthReason ? { reason: healthReason } : {}),
          ...(observedAt ? { observedAt } : {}),
        },
        usage: {
          kind: local ? 'local' : 'quota',
          dayTasks: boundedCount(row?.day_tasks),
          weekTasks: boundedCount(row?.week_tasks),
          ...(resetsAt ? { resetsAt } : {}),
        },
        workflow: {
          running: boundedCount(row?.running),
          queued: boundedCount(row?.queued),
          ...(lastTaskAt ? { lastTaskAt } : {}),
        },
      };
    }).sort((left, right) => left.id.localeCompare(right.id));

    return {
      schema: 'nova-provider-control/v1',
      authority: 'nco',
      revision: digest(JSON.stringify({ registryRevision: registry.revision, providers })),
      generatedAt: new Date().toISOString(),
      providers,
    };
  });

  const prune = (): void => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (session.leaseExpiresAtMs > now) continue;
      sessions.delete(sessionId);
      if (sessionsByExternalId.get(session.externalSessionId) === sessionId) {
        sessionsByExternalId.delete(session.externalSessionId);
      }
    }
    for (const [dispatchId, dispatch] of dispatches) {
      if (!sessions.has(dispatch.sessionId)) dispatches.delete(dispatchId);
    }
  };

  app.post('/api/external-sessions', async (request, reply) => {
    prune();
    const parsed = RegisterInput.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error.issues);
    if (sessions.size >= SESSION_LIMIT) {
      return reply.code(503).send({ error: 'external_session_capacity' });
    }

    const previousSessionId = sessionsByExternalId.get(parsed.data.externalSessionId);
    if (previousSessionId) sessions.delete(previousSessionId);
    const sessionId = identifier('session');
    const leaseExpiresAtMs = Date.now() + LEASE_MS;
    const capabilityProfileHash = digest(JSON.stringify({
      protocol: 'external-pty-v1',
      owner: parsed.data.owner,
      transport: parsed.data.transport,
      providerId: parsed.data.providerId,
      workspaceRoot: parsed.data.workspaceRoot,
      approvals: 'safe-auto-destructive-preauth',
    }));
    const session: ExternalSession = {
      sessionId,
      externalSessionId: parsed.data.externalSessionId,
      paneKey: parsed.data.paneKey,
      providerId: parsed.data.providerId,
      workspaceRoot: parsed.data.workspaceRoot,
      capabilityProfileHash,
      leaseExpiresAtMs,
    };
    sessions.set(sessionId, session);
    sessionsByExternalId.set(session.externalSessionId, sessionId);
    return {
      sessionId,
      externalSessionId: session.externalSessionId,
      providerId: session.providerId,
      workspaceRoot: session.workspaceRoot,
      capabilityProfileHash,
      leaseExpiresAt: new Date(leaseExpiresAtMs).toISOString(),
      authority: 'nco-http',
    };
  });

  app.post('/api/external-sessions/:sessionId/dispatch', async (request, reply) => {
    prune();
    const sessionId = ID.safeParse((request.params as { sessionId?: unknown }).sessionId);
    const body = DispatchInput.safeParse(request.body);
    if (!sessionId.success || !body.success) {
      return invalid(reply, [...(sessionId.success ? [] : sessionId.error.issues), ...(body.success ? [] : body.error.issues)]);
    }
    const session = sessions.get(sessionId.data);
    if (!session) return reply.code(404).send({ error: 'external_session_not_found' });
    if (dispatches.size >= DISPATCH_LIMIT) {
      return reply.code(503).send({ error: 'external_dispatch_capacity' });
    }
    const taskId = identifier('task');
    const dispatchId = identifier('dispatch');
    const acceptedAt = new Date().toISOString();
    const payloadSha256 = digest(body.data.prompt);
    const dispatch: ExternalDispatch = {
      taskId,
      dispatchId,
      sessionId: session.sessionId,
      externalSessionId: session.externalSessionId,
      exactPayload: body.data.prompt,
      payloadSha256,
      acceptedAt,
      status: 'ready',
    };
    dispatches.set(dispatchId, dispatch);
    return {
      taskId,
      dispatchId,
      externalSessionId: session.externalSessionId,
      exactPayload: body.data.prompt,
      payloadSha256,
      acceptedAt,
      authority: 'nco-http',
      receipt: receipt('dispatch-accepted', {
        taskId,
        dispatchId,
        sessionId: session.sessionId,
        clientDispatchId: body.data.clientDispatchId,
        runId: body.data.runId,
        role: body.data.role,
        participants: body.data.participants,
        payloadSha256,
      }),
    };
  });

  app.post('/api/external-dispatches/:dispatchId/approval-decision', async (request, reply) => {
    prune();
    const dispatchId = ID.safeParse((request.params as { dispatchId?: unknown }).dispatchId);
    const body = ApprovalInput.safeParse(request.body);
    if (!dispatchId.success || !body.success) {
      return invalid(reply, [...(dispatchId.success ? [] : dispatchId.error.issues), ...(body.success ? [] : body.error.issues)]);
    }
    const dispatch = dispatches.get(dispatchId.data);
    if (!dispatch) return reply.code(404).send({ error: 'external_dispatch_not_found' });
    const session = sessions.get(dispatch.sessionId);
    if (!session) return reply.code(410).send({ error: 'external_session_expired' });
    if (body.data.target !== body.data.commandArgs[0]) {
      return reply.code(400).send({ error: 'approval_target_mismatch' });
    }
    if (body.data.scope !== session.workspaceRoot) {
      return reply.code(403).send({ error: 'approval_scope_mismatch' });
    }

    const requiresPreauthorization = destructiveCommand(body.data.commandArgs);
    const decision = requiresPreauthorization ? 'waiting_preauth' : 'allow';
    if (requiresPreauthorization) dispatch.status = 'waiting_preauth';
    return {
      taskId: dispatch.taskId,
      dispatchId: dispatch.dispatchId,
      decision,
      ...(decision === 'allow' ? { responseBase64: Buffer.from('y\r').toString('base64') } : {}),
      ...(requiresPreauthorization ? { reason: 'destructive command requires signed preauthorization' } : {}),
      receipt: receipt('approval-decision', {
        taskId: dispatch.taskId,
        dispatchId: dispatch.dispatchId,
        decision,
        category: body.data.category,
        target: body.data.target,
        scope: body.data.scope,
        commandSha256: digest(body.data.commandArgs.join('\0')),
      }),
    };
  });

  app.post('/api/external-dispatches/:dispatchId/events', async (request, reply) => {
    prune();
    const dispatchId = ID.safeParse((request.params as { dispatchId?: unknown }).dispatchId);
    const body = EventInput.safeParse(request.body);
    if (!dispatchId.success || !body.success) {
      return invalid(reply, [...(dispatchId.success ? [] : dispatchId.error.issues), ...(body.success ? [] : body.error.issues)]);
    }
    const dispatch = dispatches.get(dispatchId.data);
    if (!dispatch) return reply.code(404).send({ error: 'external_dispatch_not_found' });
    dispatch.status = body.data.status;
    if (['completed', 'failed', 'cancelled'].includes(body.data.status)) {
      dispatches.delete(dispatch.dispatchId);
    }
    return { accepted: true };
  });

  app.post('/api/external-dispatches/:dispatchId/cancel', async (request, reply) => {
    prune();
    const dispatchId = ID.safeParse((request.params as { dispatchId?: unknown }).dispatchId);
    if (!dispatchId.success) return invalid(reply, dispatchId.error.issues);
    const dispatch = dispatches.get(dispatchId.data);
    if (!dispatch) {
      return {
        cancelled: false,
        receipt: receipt('dispatch-cancel', { dispatchId: dispatchId.data, cancelled: false }),
      };
    }
    dispatch.status = 'cancelled';
    dispatches.delete(dispatch.dispatchId);
    return {
      cancelled: true,
      receipt: receipt('dispatch-cancel', {
        taskId: dispatch.taskId,
        dispatchId: dispatch.dispatchId,
        cancelled: true,
      }),
    };
  });
}
