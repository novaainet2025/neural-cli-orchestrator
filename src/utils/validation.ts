import { z } from 'zod/v4';

// ─── Agent ────────────────────────────────────────────
export const AgentRoleSchema = z.enum([
  'Commander', 'Architect', 'Supervisor', 'Designer', 'Analyst',
  'Engineer', 'Worker', 'Reviewer', 'Researcher', 'Validator', 'Generalist',
]);

export const AgentStatusSchema = z.enum([
  'idle', 'thinking', 'working', 'discussing', 'reviewing',
  'waiting', 'error', 'isolated', 'offline',
]);

export const CircuitStateSchema = z.enum(['closed', 'open', 'half-open']);

// ─── Task ─────────────────────────────────────────────
export const TaskStatusSchema = z.enum([
  'pending', 'assigned', 'running', 'streaming',
  'reviewing', 'completed', 'failed', 'cancelled',
]);

export const TaskModeSchema = z.enum([
  'task', 'parallel', 'discussion', 'realtime',
  'consensus', 'hive', 'broadcast', 'agent',
]);

// ─── Messages ─────────────────────────────────────────
export const MessagePrioritySchema = z.enum(['critical', 'high', 'normal', 'low']);

export const MessageTypeSchema = z.enum([
  'direct', 'broadcast', 'review', 'approve', 'reject',
]);

// ─── API Input ────────────────────────────────────────
export const CreateTaskInput = z.object({
  ai: z.enum(['claude-code', 'opencode', 'gemini', 'codex', 'cursor-agent', 'copilot', 'openrouter', 'ollama', 'mlx', 'agy', 'hermes', 'openclaw', 'higgsfield', 'nvidia']).optional(),
  prompt: z.string().min(1),
  mode: TaskModeSchema.optional().default('task'),
  providers: z.array(z.string()).optional(),
  workspaceId: z.string().optional().default('default'),
  priority: z.number().int().min(0).max(10).optional().default(0),
  timeout: z.number().int().min(1000).max(1_800_000).optional(), // per-task wall-clock ms (max 30min)
  systemPrompt: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  verifier: z.object({
    type: z.literal('run'),
    command: z.string().min(1),
    timeoutMs: z.number().int().min(1000).max(300_000).optional(),
  }).optional(),
});

export const CreateDiscussionInput = z.object({
  prompt: z.string().min(1),
  providers: z.array(z.string()).min(2).optional(),
  mode: z.enum(['discussion', 'realtime', 'parallel', 'consensus', 'hive']).optional().default('discussion'),
  maxRounds: z.number().int().min(1).max(10).optional().default(3),
  consensusThreshold: z.number().min(0).max(1).optional().default(0.8),
  workspaceId: z.string().optional().default('default'),
});

export type CreateTaskInputType = z.infer<typeof CreateTaskInput>;
export type CreateDiscussionInputType = z.infer<typeof CreateDiscussionInput>;
