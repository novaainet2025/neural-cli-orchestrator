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
  // 정적 enum 제거 (2026-07-08): 신규 프로바이더(mlx-instruct 실측)가 영구 400 차단되던 결함.
  // 실검증은 gateway intake의 validateDelegationPayload(agentManager.listEnabledIds() 대조)가
  // 런타임 레지스트리 기준으로 수행 — 여기서는 형식만 본다.
  ai: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'invalid provider id format').optional(),
  model: z.string().min(1).optional(),
  prompt: z.string().min(1),
  mode: TaskModeSchema.optional().default('task'),
  providers: z.array(z.string()).optional(),
  workspaceId: z.string().optional().default('default'),
  priority: z.number().int().min(0).max(10).optional().default(0),
  timeout: z.number().int().min(1000).max(1_800_000).optional(), // per-task wall-clock ms (max 30min)
  systemPrompt: z.string().optional(),
  // retry/failover lineage — 생성 시점에 세팅해 비원자 사후 UPDATE로 인한 cap 우회 방지
  parentTaskId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  verifier: z.object({
    type: z.literal('run'),
    command: z.string().min(1).refine(
      command => !/[;|&<>$`(){}\n'"\\]/.test(command),
      'verifier.command must be a plain binary invocation (no shell metacharacters)',
    ),
    timeoutMs: z.number().int().min(1000).max(300_000).optional(),
  }).optional(),
  // P1-6 evidence-gate opt-in: 이 목록이 있으면 완료 시 해당 증거가 모두 있어야 'completed',
  // 아니면 'failed'(evidence_gate_blocked)로 강등된다. 없으면 기존 완료 흐름 무영향.
  requiredEvidence: z.array(z.string().min(1)).optional(),
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
