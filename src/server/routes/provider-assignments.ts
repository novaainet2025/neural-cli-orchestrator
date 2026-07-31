import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod/v4';
import type {
  ProviderAssignmentPolicy,
  ProviderAssignmentPolicyOverride,
  ProviderAssignmentScope,
  ProviderAssignmentSnapshot,
} from '../../core/provider-assignment.js';
import type {
  ProviderAssignmentEvent,
  ProviderAssignmentPolicyRecord,
} from '../../core/provider-assignment-store.js';

const PolicySchema = z.object({
  requiredCapabilities: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  preferredCapabilities: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  preferredRoles: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  // The only provider-id policy field is an explicit local deny list. Positive
  // assignment by provider id is intentionally not part of the contract.
  deniedProviderIds: z.array(
    z.string().trim().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/),
  ).max(100).optional(),
  allowedCosts: z.array(z.enum(['free', 'paid'])).max(2).optional(),
  allowedTypes: z.array(z.enum(['cli', 'api', 'local'])).max(3).optional(),
  preferLocal: z.boolean().optional(),
  minimumCandidates: z.number().int().min(1).max(100).optional(),
  assignmentSize: z.number().int().min(1).max(100).optional(),
  fallback: z.enum(['strict', 'relax-preferences', 'any-allowed']).optional(),
  ttlSeconds: z.number().int().min(5).max(86_400).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'at least one policy field is required',
});

const AssignmentQuerySchema = z.object({
  refresh: z.enum(['0', '1']).default('0'),
  taskCapability: z.union([
    z.string().trim().min(1).max(80),
    z.array(z.string().trim().min(1).max(80)).max(100),
  ]).optional(),
}).strict();

const ReconcileSchema = z.object({
  scopeType: z.enum(['organization', 'team']),
  scopeId: z.string().trim().min(1).max(160),
  taskCapabilities: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
}).strict();

export interface ResolveAssignmentRequest {
  scopeType: ProviderAssignmentScope;
  scopeId: string;
  refresh: boolean;
  taskRequiredCapabilities: string[];
}

export interface ProviderAssignmentRouteDependencies {
  scopeExists(scopeType: ProviderAssignmentScope, scopeId: string): boolean | Promise<boolean>;
  getPolicy(
    scopeType: ProviderAssignmentScope,
    scopeId: string,
  ): ProviderAssignmentPolicyRecord | null | Promise<ProviderAssignmentPolicyRecord | null>;
  upsertPolicy(
    scopeType: ProviderAssignmentScope,
    scopeId: string,
    policy: ProviderAssignmentPolicyOverride,
  ): ProviderAssignmentPolicyRecord | Promise<ProviderAssignmentPolicyRecord>;
  getEffectivePolicy(
    scopeType: ProviderAssignmentScope,
    scopeId: string,
    taskRequiredCapabilities?: readonly string[],
  ): ProviderAssignmentPolicy | Promise<ProviderAssignmentPolicy>;
  resolveAssignment(
    request: ResolveAssignmentRequest,
  ): ProviderAssignmentSnapshot | Promise<ProviderAssignmentSnapshot>;
  getSnapshot(
    assignmentId: string,
  ): ProviderAssignmentSnapshot | null | Promise<ProviderAssignmentSnapshot | null>;
  listEvents(
    assignmentId: string,
  ): ProviderAssignmentEvent[] | Promise<ProviderAssignmentEvent[]>;
}

function invalid(reply: FastifyReply, code: string, detail: unknown) {
  return reply.code(400).send({ error: code, detail });
}

async function requireScope(
  reply: FastifyReply,
  dependencies: ProviderAssignmentRouteDependencies,
  scopeType: ProviderAssignmentScope,
  scopeId: string,
): Promise<boolean> {
  if (await dependencies.scopeExists(scopeType, scopeId)) return true;
  reply.code(404).send({
    error: 'provider_assignment_scope_not_found',
    scopeType,
    scopeId,
  });
  return false;
}

function sendAssignment(reply: FastifyReply, snapshot: ProviderAssignmentSnapshot) {
  if (snapshot.status === 'assigned') return reply.send({ assignment: snapshot, stale: false });
  return reply.code(409).send({
    error: 'provider_assignment_unavailable',
    scopeType: snapshot.scopeType,
    scopeId: snapshot.scopeId,
    assignment: snapshot,
    stale: false,
  });
}

function taskCapabilities(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return [...new Set((Array.isArray(value) ? value : [value]).map((entry) => entry.trim()))];
}

export async function registerProviderAssignmentRoutes(
  app: FastifyInstance,
  dependencies: ProviderAssignmentRouteDependencies,
): Promise<void> {
  const registerScope = (plural: 'organizations' | 'teams', scopeType: ProviderAssignmentScope) => {
    app.get(`/api/${plural}/:id/provider-policy`, async (request, reply) => {
      const scopeId = (request.params as { id: string }).id;
      if (!await requireScope(reply, dependencies, scopeType, scopeId)) return;
      return {
        scopeType,
        scopeId,
        policy: await dependencies.getPolicy(scopeType, scopeId),
      };
    });

    app.put(`/api/${plural}/:id/provider-policy`, async (request, reply) => {
      const scopeId = (request.params as { id: string }).id;
      if (!await requireScope(reply, dependencies, scopeType, scopeId)) return;
      const parsed = PolicySchema.safeParse(request.body);
      if (!parsed.success) {
        return invalid(
          reply,
          'invalid_provider_assignment_policy',
          parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        );
      }
      const policy = await dependencies.upsertPolicy(scopeType, scopeId, parsed.data);
      return reply.send({ scopeType, scopeId, policy });
    });

    app.get(`/api/${plural}/:id/provider-policy/effective`, async (request, reply) => {
      const scopeId = (request.params as { id: string }).id;
      if (!await requireScope(reply, dependencies, scopeType, scopeId)) return;
      const parsed = AssignmentQuerySchema.safeParse(request.query);
      if (!parsed.success) return invalid(reply, 'invalid_provider_assignment_query', parsed.error.issues);
      const capabilities = taskCapabilities(parsed.data.taskCapability);
      return {
        scopeType,
        scopeId,
        taskRequiredCapabilities: capabilities,
        policy: await dependencies.getEffectivePolicy(scopeType, scopeId, capabilities),
      };
    });

    app.get(`/api/${plural}/:id/provider-assignment`, async (request, reply) => {
      const scopeId = (request.params as { id: string }).id;
      if (!await requireScope(reply, dependencies, scopeType, scopeId)) return;
      const parsed = AssignmentQuerySchema.safeParse(request.query);
      if (!parsed.success) return invalid(reply, 'invalid_provider_assignment_query', parsed.error.issues);
      const snapshot = await dependencies.resolveAssignment({
        scopeType,
        scopeId,
        refresh: parsed.data.refresh === '1',
        taskRequiredCapabilities: taskCapabilities(parsed.data.taskCapability),
      });
      return sendAssignment(reply, snapshot);
    });
  };

  registerScope('organizations', 'organization');
  registerScope('teams', 'team');

  app.post('/api/provider-assignments/reconcile', async (request, reply) => {
    const parsed = ReconcileSchema.safeParse(request.body);
    if (!parsed.success) {
      return invalid(reply, 'invalid_provider_assignment_reconcile', parsed.error.issues);
    }
    if (!await requireScope(reply, dependencies, parsed.data.scopeType, parsed.data.scopeId)) return;
    const snapshot = await dependencies.resolveAssignment({
      scopeType: parsed.data.scopeType,
      scopeId: parsed.data.scopeId,
      refresh: true,
      taskRequiredCapabilities: parsed.data.taskCapabilities,
    });
    return sendAssignment(reply, snapshot);
  });

  app.get('/api/provider-assignments/:id', async (request, reply) => {
    const assignmentId = (request.params as { id: string }).id;
    const assignment = await dependencies.getSnapshot(assignmentId);
    if (!assignment) {
      return reply.code(404).send({
        error: 'provider_assignment_not_found',
        assignmentId,
      });
    }
    return {
      assignment,
      events: await dependencies.listEvents(assignmentId),
    };
  });
}
