import Fastify, { type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod/v4';
import { env } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { getRedis, isRedisConnected, redisHealthCheck } from '../storage/redis.js';
import { getDb } from '../storage/database.js';
import { agentManager } from '../agent/agent-manager.js';
import { validateDelegationPayload } from '../utils/delegation-payload.js';
import { fleetGateway, hiveRelay, getPaInbox, paLifecycle } from '../core/ported-integrations.js';
import type { LifecycleMode } from '../core/pa-lifecycle.js';
import { decompose, getLeaves, countNodes } from '../core/recursive-decomposer.js';
import { requireEvidence } from '../security/evidence-gate.js';
import { compressPlan, MAX_PLAN_CHARS } from '../core/context-budget.js';
import { discussionEngine } from '../core/discussion-engine.js';
import { sharedState, type AgentState } from '../core/shared-state.js';
import { eventBus, type NCOEvent } from '../core/event-bus.js';
import { discoverAcquisitions } from '../core/acquisition-discovery.js';
import { installAcquiredPackage } from '../core/acquisition-installer.js';
import { acquisitionRegistry, type AcquisitionRecord } from '../core/acquisition-registry.js';
import { createTaskId, createSessionId } from '../utils/id.js';
import { CreateTaskInput, CreateDiscussionInput } from '../utils/validation.js';
import { parseIntent } from '../utils/intent-parser.js';
import { taskQueue } from '../core/task-queue.js';
import { TERMINAL_STATES, transitionTask } from '../core/task-state.js';
import { checkResponseQuality } from '../verification/response-quality.js';
import { vetAcquisitionCandidate } from '../security/acquisition-vetting.js';
import {
  circuitBreakerRegistry,
  type ProviderAvailabilitySnapshot,
} from '../security/circuit-breaker-registry.js';

/** 응답 텍스트에 에러 패턴이 있으면 true — completed 오탐 방지 */
function detectFailedCompletion(response: string | null | undefined): boolean {
  if (!response) return false;
  const text = response.trim();
  if (/^Error:\s/i.test(text)) return true;

  // HARD 시그니처: 정상 콘텐츠(코드리뷰·작업로그)에 등장하지 않는 강한 실패 신호.
  // 위치/길이 무관하게 실패로 판정한다.
  const hard = [
    /\bActionRequiredError\b/i,
    /\bProviderModelNotFoundError\b/i,
    /\b(?:connection\s*refused|ECONNREFUSED)\b/i,
    /\brequest\s+timed\s+out\b/i,
    // 오케스트레이터가 붙이는 선두 래퍼("[codex: no final response — process failed]")만.
    // 리뷰가 이 문자열을 인용하는 경우(본문 중간)는 제외하려고 ^ 앵커 사용.
    /^\[[\w-]+:[^\]]*\bno final response\b/i,
    /^\s*ERROR:\s/im,
    /^status:\s*failed\b/im,
  ];
  if (hard.some(p => p.test(text))) return true;

  // SOFT 시그니처: 정상 텍스트에도 등장할 수 있는 단어들(error/failed/usage limit 등).
  // 긴 substantive 출력의 본문 중간 등장은 오탐이므로, 짧은 출력 전체 또는 긴 출력의
  // 선두 200자에서만 판정한다. 근접 제한(.{0,N})으로 span-매칭 오탐도 차단.
  const soft = [
    /\bfailed\s+(?:to|with)\b/i,
    /\b(?:error|exception)\b.{0,15}\b(?:occurred|happened|encountered)\b/i,
    /\b(?:exceeded|over)\b.{0,20}\b(?:limit|quota|rate)\b/i,
    /\bAPI\s*(?:key|quota|limit)\b.{0,20}\b(?:invalid|expired|exceeded)\b/i,
    /\b(?:streaming|execution)\s+error\b/i,
    /\busage.{0,20}exceeded\b/i,
    /\btimeout\b.{0,20}\b(?:error|exceeded|after)\b/i,
    /\busage\s+limit\b/i,
    /\bhit\s+your\s+(?:usage\s+)?limit\b/i,
  ];
  const SHORT_OUTPUT = 500;
  const target = text.length <= SHORT_OUTPUT ? text : text.slice(0, 200);
  return soft.some(p => p.test(target));
}

function buildFailureError(result: { error?: string; output?: string }): string {
  return result.error
    || (result.output && detectFailedCompletion(result.output) ? 'unknown: failure pattern in output' : undefined)
    || 'unknown: execution failed';
}

function withTaskRuntime<T extends { id: string; last_activity_at?: string | null }>(task: T) {
  const runtime = taskQueue.getTaskSnapshot(task.id);
  return {
    ...task,
    lastActivityAt: runtime.lastActivityAt ?? task.last_activity_at ?? null,
    liveness: runtime.liveness,
  };
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

// ── R1: 품질-인지 라우팅 — failover 시 성공률 높은 프로바이더 우선 ──
// tasks 테이블 기반 프로바이더별 성공률을 TTL 캐시(5분)해 라우터 hot-path 부담 최소화.
// 표본<10건은 중립(0.5)으로 두어 sparse 노이즈가 cost-order를 해치지 않게 한다.
// adaptive-scorer는 데이터 테이블 미존재로 no-op이라, 라이브 tasks 집계를 직접 사용.
let _provQualityCache: { at: number; map: Map<string, number> } | null = null;
function getProviderSuccessRates(): Map<string, number> {
  const now = Date.now();
  if (_provQualityCache && now - _provQualityCache.at < 300_000) return _provQualityCache.map;
  const map = new Map<string, number>();
  try {
    const rows = getDb().prepare(`
      SELECT assigned_to AS ai,
             COUNT(*) AS total,
             SUM(CASE WHEN status IN ('completed','done') THEN 1 ELSE 0 END) AS ok
      FROM tasks
      WHERE assigned_to IS NOT NULL AND created_at > datetime('now','-14 days')
      GROUP BY assigned_to
    `).all() as Array<{ ai: string; total: number; ok: number }>;
    for (const r of rows) {
      map.set(r.ai, r.total >= 10 ? r.ok / r.total : 0.5);
    }
  } catch { /* DB 실패 시 빈 맵 → cost-order 유지(안전) */ }
  _provQualityCache = { at: now, map };
  return map;
}

function listAvailableProviders(exclude: string[] = []): string[] {
  const excluded = new Set(exclude);
  const avail = sortProvidersByCostOrder(agentManager.listEnabledIds())
    .filter(agentId => !excluded.has(agentId))
    .filter(agentId => circuitBreakerRegistry.getAvailability(agentId).status === 'available');
  // R1: 성공률 내림차순 정렬. 동률·데이터없음(0.5)은 원래 cost-order 유지(stable).
  const sr = getProviderSuccessRates();
  return avail
    .map((id, i) => ({ id, i, q: sr.get(id) ?? 0.5 }))
    .sort((a, b) => (b.q - a.q) || (a.i - b.i))
    .map(x => x.id);
}

function toGateResponse(availability: ProviderAvailabilitySnapshot) {
  return {
    status: availability.status,
    reason: availability.reason,
    circuitState: availability.circuitState,
    cooldownUntil: availability.cooldownUntil,
  };
}

function buildProviderGatedBody(requestedProvider: string) {
  const availability = circuitBreakerRegistry.getAvailability(requestedProvider);
  const availableProviders = listAvailableProviders([requestedProvider]);
  return {
    error: 'provider_gated',
    requestedProvider,
    gate: toGateResponse(availability),
    availableProviders,
    suggestedProvider: availableProviders[0] ?? null,
    canFailover: availableProviders.length > 0,
  };
}

function selectTaskProvider(requestedProvider: string, allowProviderFailover: boolean) {
  const availability = circuitBreakerRegistry.getAvailability(requestedProvider);
  if (availability.status === 'available' || availability.status === 'probe') {
    return { agentId: requestedProvider };
  }

  // B2: 요청 프로바이더가 gated(리밋/다운/circuit open)면 — allowProviderFailover 여부와 무관하게 —
  //     건강한 '같은 role' 프로바이더로 자동 failover한다. 같은 role 건강한 곳이 없으면 409로 명확히 거부
  //     (엉뚱한 role로 크로스 라우팅해 '가짜 성공' 내는 것 방지). "리밋 걸린 곳엔 위임 안 한다"의 인테이크 구현.
  const availableProviders = listAvailableProviders([requestedProvider]);
  const requestedRole = agentManager.getProvider(requestedProvider)?.role;
  const sameRoleHealthy = availableProviders.filter(id => agentManager.getProvider(id)?.role === requestedRole);
  const failoverTarget = sameRoleHealthy[0]
    ?? (allowProviderFailover ? availableProviders[0] : undefined); // 명시적 opt-in 시에만 크로스role 허용
  if (!failoverTarget) {
    return { error: buildProviderGatedBody(requestedProvider) };
  }

  return {
    agentId: failoverTarget,
    failover: {
      applied: true,
      originalProvider: requestedProvider,
      originalGate: availability.status,
    },
  };
}

function resolveRealtimeProviders(mode: RealtimeGateMode, requestedProviders?: string[]) {
  const requiredMinimum = REALTIME_MINIMUMS[mode];
  const providers = requestedProviders && requestedProviders.length > 0
    ? requestedProviders
    : listAvailableProviders().slice(0, Math.max(requiredMinimum, 3));
  const gatedProviders = providers
    .map(id => ({ id, gate: circuitBreakerRegistry.getAvailability(id) }))
    .filter(entry => entry.gate.status !== 'available')
    .map(entry => ({ id: entry.id, gate: entry.gate.status }));
  const eligibleProviders = providers.filter(id => circuitBreakerRegistry.getAvailability(id).status === 'available');

  if (eligibleProviders.length < requiredMinimum) {
    return {
      ok: false as const,
      body: {
        error: 'insufficient_available_providers',
        mode,
        requestedProviders: providers,
        eligibleProviders,
        gatedProviders,
        requiredMinimum,
      },
    };
  }

  return { ok: true as const, providers: eligibleProviders };
}
import { injectContext } from '../core/conversation-context.js';
import { registerDashboardRoutes } from './routes/dashboard-compat.js';
import { registerMathRoutes } from './routes/math.js';
import { registerCircuitRoutes } from './routes/circuit.js';
import { registerInterSessionRoutes } from './routes/inter-session.js';
import { registerHandoffRoutes } from './routes/handoff.js';
import { registerFleetOpsRoutes } from './routes/fleet-ops.js';
import { registerTeamsRoutes } from './routes/teams.js';
import { registerWorkReportRoutes } from './routes/work-reports.js';
import { registerAuditRoutes } from './routes/audit.js';
import { invocationTracker } from '../core/invocation-tracker.js';
import { delegationManager } from '../core/delegation-manager.js';
import { collaborationEngine } from '../core/collaboration-engine.js';
import { ProviderSelectionError, sortProvidersByCostOrder } from '../core/smart-router.js';
import {
  isRetryableFailoverFailure,
  loadFailoverChainsConfig,
  selectFailoverCandidate,
} from './task-failover.js';

const log = createLogger('gateway');
let draining = false;

const REALTIME_MINIMUMS = {
  parallel: 2,
  discussion: 3,
  consensus: 3,
  hive: 2,
} as const;

type RealtimeGateMode = keyof typeof REALTIME_MINIMUMS;

const MESH_COMM_GRAPH_PATH = resolve(env.ROOT, 'config', 'comm-graph.json');
const MeshRouteTypeSchema = z.enum([
  'info',
  'task',
  'review',
  'approval',
  'question',
  'warning',
  'request',
  'conflict',
]);
const MeshSendBodySchema = z.object({
  fromSessionId: z.string().min(1),
  fromAgent: z.string().min(1).optional(),
  toSessionId: z.string().min(1).optional(),
  content: z.string().min(1).max(64_000),
  type: MeshRouteTypeSchema.default('info'),
});

type MeshRouteType = z.infer<typeof MeshRouteTypeSchema>;
type RetryTaskPayload = {
  ai?: string;
  parentTaskId?: string;
  prompt: string;
  mode?: z.infer<typeof CreateTaskInput.shape.mode>;
  workspaceId?: string;
  priority?: number;
  systemPrompt?: string;
  verifier?: z.infer<NonNullable<typeof CreateTaskInput.shape.verifier>>;
};
type RetryTaskResult =
  | { ok: true; newTaskId: string; sourceTaskId: string; retryCount: number }
  | { ok: false; statusCode: number; body: Record<string, unknown> };
type RetryPayloadOptions = {
  allowCompletedSource?: boolean;
};

type RetryTaskOptions = {
  overrideAi?: string;
  allowCompletedSource?: boolean;
  reason?: string;
};

interface CommGraphEdge {
  from: string;
  to: string;
  types: MeshRouteType[];
}

interface CommGraphConfig {
  edges: CommGraphEdge[];
  defaultPolicy: 'allow' | 'deny';
}

type MeshCommGraphMode = 'off' | 'shadow' | 'enforce';

const CommGraphConfigSchema = z.object({
  edges: z.array(z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    types: z.array(MeshRouteTypeSchema).min(1),
  })),
  defaultPolicy: z.enum(['allow', 'deny']),
});
const RetryTaskBodySchema = z.object({
  ai: CreateTaskInput.shape.ai.optional(),
});
const AcquisitionDiscoverBodySchema = z.object({
  packageName: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  goal: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(20).optional(),
}).refine(value => Boolean(value.packageName || value.goal), {
  message: 'packageName or goal is required',
});
const AcquisitionApproveBodySchema = z.object({
  approvedBy: z.string().min(1).optional(),
}).optional();
const AcquisitionDecisionFilterSchema = z.enum([
  'discovered',
  'vet_passed',
  'approval_required',
  'rejected',
  'installed',
  'install_failed',
  'registration_failed',
  'active',
]);
const DiscussionRouteBodySchema = z.object({
  topic: z.string().min(1),
  participants: z.array(z.string().min(1)).min(1).optional(),
  providers: z.array(z.string().min(1)).min(1).optional(),
  rounds: z.number().int().min(1).max(10).optional(),
  maxRounds: z.number().int().min(1).max(10).optional(),
  consensusThreshold: z.number().min(0).max(1).optional(),
  mode: z.enum(['discussion', 'consensus', 'hive']).optional().default('discussion'),
  initiator: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
}).refine(value => !(value.participants && value.providers), {
  message: 'Use either participants or providers, not both',
  path: ['participants'],
});
const ParallelRouteBodySchema = z.object({
  prompt: z.string().min(1),
  providers: z.array(z.string().min(1)).min(1),
});
const CreateCollabBodySchema = z.object({
  title: z.string().min(1),
  type: z.enum(['brainstorm', 'consensus', 'parallel_work', 'review']).optional(),
  description: z.string().min(1).optional(),
  createdBy: z.string().min(1).optional(),
});
const JoinCollabBodySchema = z.object({
  agentId: z.string().min(1),
});
const ContributeCollabBodySchema = z.object({
  agentId: z.string().min(1),
  content: z.string().min(1),
});
const VoteCollabBodySchema = z.object({
  agentId: z.string().min(1),
  choice: z.string().min(1),
  vote: z.union([z.literal(-1), z.literal(1)]).optional(),
});
const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

type ActiveLock = {
  path: string;
  holder: string;
  ttlMs: number | null;
};

const LOCK_KEY_PREFIX = 'nco:lock:file:';

async function listActiveLocks(): Promise<ActiveLock[]> {
  if (!isRedisConnected()) return [];
  const redis = await getRedis();
  const keys = await redis.keys(`${LOCK_KEY_PREFIX}*`);
  const locks = await Promise.all(keys.map(async (key) => {
    const [holder, ttlMs] = await Promise.all([redis.get(key), redis.pttl(key)]);
    if (!holder) return null;
    return {
      path: key.slice(LOCK_KEY_PREFIX.length),
      holder,
      ttlMs: ttlMs >= 0 ? ttlMs : null,
    };
  }));
  return locks
    .filter((lock): lock is ActiveLock => lock !== null)
    .sort((a, b) => a.path.localeCompare(b.path));
}

let cachedCommGraph: CommGraphConfig | null = null;
let cachedCommGraphWarning: string | null = null;

const readRetryCount = (db: ReturnType<typeof getDb>, taskId: string) => db.prepare(`
  SELECT count
  FROM retry_counts
  WHERE task_id=?
`).get(taskId) as { count: number } | undefined;

const reserveRetry = (db: ReturnType<typeof getDb>, taskId: string) => db.transaction((sourceTaskId: string) => {
  const row = readRetryCount(db, sourceTaskId);
  const count = row?.count ?? 0;
  if (count >= 3) {
    return { allowed: false as const, count };
  }
  db.prepare(`
    INSERT INTO retry_counts (task_id, count)
    VALUES (?, 1)
    ON CONFLICT(task_id) DO UPDATE SET count = retry_counts.count + 1
  `).run(sourceTaskId);
  const updated = readRetryCount(db, sourceTaskId) as { count: number };
  return { allowed: true as const, count: updated.count };
});

const rollbackRetryReservation = (db: ReturnType<typeof getDb>, taskId: string) => {
  db.prepare('UPDATE retry_counts SET count = MAX(count - 1, 0) WHERE task_id=?').run(taskId);
};

const resolveRetrySourceTaskId = (db: ReturnType<typeof getDb>, taskId: string) => {
  const taskLineage = db.prepare(`
    SELECT parent_task_id
    FROM tasks
    WHERE id=?
  `).get(taskId) as { parent_task_id: string | null } | undefined;
  return taskLineage?.parent_task_id ?? taskId;
};

const parseRetryTaskAi = (value: string | null | undefined): string | undefined => {
  if (!value) return undefined;
  const parsed = CreateTaskInput.shape.ai.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export const loadRetryPayload = (
  db: ReturnType<typeof getDb>,
  taskId: string,
  opts?: RetryPayloadOptions,
): RetryTaskPayload | null => {
  const deadLetter = db.prepare(`
    SELECT ai, prompt
    FROM dead_letter_tasks
    WHERE task_id=?
    ORDER BY id DESC
    LIMIT 1
  `).get(taskId) as { ai: string | null; prompt: string | null } | undefined;
  const verifierRow = db.prepare(`
    SELECT verifier_json, verifier_result_json
    FROM tasks
    WHERE id=?
  `).get(taskId) as {
    verifier_json: string | null;
    verifier_result_json: string | null;
  } | undefined;
  const sourceStatusFilter = opts?.allowCompletedSource
    ? "status IN ('failed', 'timed_out', 'completed')"
    : "status IN ('failed', 'timed_out')";
  const sourceTask = deadLetter ? undefined : db.prepare(`
    SELECT assigned_to, prompt, mode, workspace_id, priority, system_prompt
    FROM tasks
    WHERE id=? AND ${sourceStatusFilter}
  `).get(taskId) as {
    assigned_to: string | null;
    prompt: string;
    mode: z.infer<typeof CreateTaskInput.shape.mode> | null;
    workspace_id: string | null;
    priority: number | null;
    system_prompt: string | null;
  } | undefined;

  const parsedVerifier = (() => {
    if (!verifierRow?.verifier_json) return undefined;
    try {
      return JSON.parse(verifierRow.verifier_json) as z.infer<NonNullable<typeof CreateTaskInput.shape.verifier>>;
    } catch {
      return undefined;
    }
  })();

  const payload = deadLetter
    ? { ai: parseRetryTaskAi(deadLetter.ai), prompt: deadLetter.prompt ?? '', verifier: parsedVerifier }
    : sourceTask
      ? {
          ai: parseRetryTaskAi(sourceTask.assigned_to),
          prompt: sourceTask.prompt,
          mode: sourceTask.mode ?? undefined,
          workspaceId: sourceTask.workspace_id ?? undefined,
          priority: sourceTask.priority ?? undefined,
          systemPrompt: sourceTask.system_prompt ?? undefined,
          verifier: parsedVerifier,
        }
      : null;

  if (!payload || !payload.prompt) {
    return null;
  }

  if (verifierRow?.verifier_result_json) {
    try {
      const parsed = JSON.parse(verifierRow.verifier_result_json) as {
        passed?: boolean;
        outputSnippet?: string;
        command?: string;
        timedOut?: boolean;
        spawnError?: string | null;
        exitCode?: number | null;
      };
      if (parsed.passed === false && parsed.outputSnippet) {
        payload.prompt += `\n\n[Previous verifier failure]\nCommand: ${parsed.command}\nExit: ${parsed.timedOut ? 'timeout' : parsed.spawnError ? 'spawn-error' : parsed.exitCode}\nOutput:\n${parsed.outputSnippet}`;
      }
    } catch {}
  }

  try {
    const handoffRow = db.prepare(`
      SELECT packet_json
      FROM handoff_packets
      WHERE task_id = ? AND accepted = 1
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(taskId) as { packet_json: string } | undefined;

    if (handoffRow?.packet_json) {
      const packet = JSON.parse(handoffRow.packet_json);
      let handoffInfo = `\n\n[Handoff Resume Info]\nOutcome: ${packet.outcome}\nSummary: ${packet.summary}`;
      if (packet.evidence && packet.evidence.length > 0) {
        handoffInfo += `\nEvidence:\n` + packet.evidence.map((e: any) => `- [${e.tier}] ${e.claim}`).join('\n');
      }
      payload.prompt += handoffInfo;
    }
  } catch {}

  return payload;
};

function updateTaskQualityMetadata(
  db: ReturnType<typeof getDb>,
  taskId: string,
  heuristics: string[],
): void {
  const row = db.prepare('SELECT metadata_json FROM tasks WHERE id=?').get(taskId) as { metadata_json: string | null } | undefined;
  let metadata: Record<string, unknown> = {};
  if (row?.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch {}
  }
  metadata.qualityRejected = true;
  metadata.qualityHeuristics = heuristics;
  db.prepare(`
    UPDATE tasks
    SET metadata_json=?, updated_at=datetime('now')
    WHERE id=?
  `).run(JSON.stringify(metadata), taskId);
}

function getMeshCommGraphMode(): MeshCommGraphMode {
  const raw = (process.env.NCO_MESH_COMM_GRAPH_MODE ?? 'shadow').toLowerCase();
  if (raw === 'off' || raw === 'shadow' || raw === 'enforce') return raw;
  return 'shadow';
}

function loadCommGraphConfig(): CommGraphConfig | null {
  if (cachedCommGraph) return cachedCommGraph;
  try {
    if (!existsSync(MESH_COMM_GRAPH_PATH)) {
      if (cachedCommGraphWarning !== 'missing') {
        cachedCommGraphWarning = 'missing';
        log.warn({ path: MESH_COMM_GRAPH_PATH }, 'comm-graph config missing — mesh routing gate disabled');
      }
      return null;
    }

    const parsed = CommGraphConfigSchema.parse(JSON.parse(readFileSync(MESH_COMM_GRAPH_PATH, 'utf-8')));
    cachedCommGraph = parsed;
    cachedCommGraphWarning = null;
    return cachedCommGraph;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cachedCommGraphWarning !== message) {
      cachedCommGraphWarning = message;
      log.warn({ err: message, path: MESH_COMM_GRAPH_PATH }, 'comm-graph config invalid — mesh routing gate disabled');
    }
    return null;
  }
}

function matchCommGraphPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}

function evaluateCommGraph({ from, to, type }: { from: string; to: string; type: MeshRouteType }) {
  const config = loadCommGraphConfig();
  if (!config) {
    return {
      allowed: true,
      reason: 'config_unavailable',
      matchedEdge: null,
      defaultPolicy: 'allow' as const,
    };
  }

  for (const edge of config.edges) {
    if (!matchCommGraphPattern(edge.from, from)) continue;
    if (!matchCommGraphPattern(edge.to, to)) continue;
    if (!edge.types.includes(type)) continue;
    return {
      allowed: true,
      reason: 'matched_allow_edge',
      matchedEdge: edge,
      defaultPolicy: config.defaultPolicy,
    };
  }

  return {
    allowed: config.defaultPolicy === 'allow',
    reason: config.defaultPolicy === 'allow' ? 'default_allow' : 'default_deny',
    matchedEdge: null,
    defaultPolicy: config.defaultPolicy,
  };
}

function rejectWhileDraining(reply: FastifyReply) {
  reply.code(503);
  return { error: 'draining: new tasks rejected' };
}

async function resolveAcquisitionVersion(packageName: string, requestedVersion?: string): Promise<string> {
  // dist-tags ("latest", "next", etc.) are not semver — resolve via npm registry
  // semver starts with a digit or range prefix (^, ~, >=, <=, >, <, =, *)
  const isDistTag = requestedVersion && !/^[\d^~>=<!*]/.test(requestedVersion);
  if (requestedVersion && !isDistTag) return requestedVersion;

  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`npm registry ${response.status} for ${packageName}`);
  }

  const packument = await response.json() as {
    'dist-tags'?: Record<string, unknown>;
  };
  const distTags = packument?.['dist-tags'] ?? {};
  const tag = requestedVersion && isDistTag ? requestedVersion : 'latest';
  const resolved = distTags[tag];
  if (typeof resolved !== 'string' || resolved.length === 0) {
    throw new Error(`dist-tag "${tag}" missing for ${packageName}`);
  }
  return resolved;
}

function serializeAcquisitionRecord(record: AcquisitionRecord) {
  return {
    ...record,
    discovered_from: safeJsonParse(record.discovered_from_json),
    vet_results: safeJsonParse(record.vet_results_json),
  };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function processAcquisitionCandidate(input: {
  packageName: string;
  version?: string | null;
  sourceType: string;
  sourceRef: string | null;
  evidence: Record<string, unknown>;
  discoveredFrom: Record<string, unknown>;
}) {
  const version = await resolveAcquisitionVersion(input.packageName, input.version ?? undefined);
  const record = acquisitionRegistry.createDiscovery({
    packageName: input.packageName,
    version,
    sourceType: input.sourceType,
    sourceRef: input.sourceRef,
  }, {
    ...input.discoveredFrom,
    evidence: input.evidence,
  });

  const vetting = await vetAcquisitionCandidate(
    {
      packageName: input.packageName,
      version,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
    },
    {
      getTrustedPackageNames: () => acquisitionRegistry.listTrustedPackageNames(),
      getPreviousMaintainers: (packageName) => acquisitionRegistry.getLatestMaintainers(packageName),
    },
  );

  let currentRecord = acquisitionRegistry.saveVetting(record.id, vetting);
  let install: { installDir: string; packageDir: string; packageSha256: string } | null = null;
  let dynamicSkill: { id: string; name: string; description: string } | null = null;

  if (vetting.decision === 'auto_pass') {
    try {
      install = await installAcquiredPackage({ packageName: input.packageName, version });
      currentRecord = acquisitionRegistry.markInstalled(record.id, install.packageDir, install.packageSha256);
    } catch (error) {
      currentRecord = acquisitionRegistry.markInstallFailed(record.id, error instanceof Error ? error.message : String(error));
      return { record: serializeAcquisitionRecord(currentRecord), vetting, install, skill: dynamicSkill };
    }

    try {
      const registration = await acquisitionRegistry.registerDynamicSkill(record.id);
      currentRecord = registration.record;
      dynamicSkill = {
        id: registration.skill.id,
        name: registration.skill.name,
        description: registration.skill.description,
      };
    } catch (error) {
      currentRecord = acquisitionRegistry.markRegistrationFailed(record.id, error instanceof Error ? error.message : String(error));
    }
  }

  return {
    record: serializeAcquisitionRecord(currentRecord),
    vetting,
    install,
    skill: dynamicSkill,
  };
}

// ─── Lazy-cached dynamic imports (avoid repeated await import() per request) ─
let _cliMeshMod: Awaited<typeof import('../core/cli-mesh.js')> | null = null;
async function getCliMesh() {
  if (!_cliMeshMod) _cliMeshMod = await import('../core/cli-mesh.js');
  return _cliMeshMod.cliMesh;
}
let _smartRouterMod: Awaited<typeof import('../core/smart-router.js')> | null = null;
async function getSmartRouter() {
  if (!_smartRouterMod) _smartRouterMod = await import('../core/smart-router.js');
  return _smartRouterMod.smartRouter;
}
let _commanderMod: Awaited<typeof import('../core/commander.js')> | null = null;
async function getCommander() {
  if (!_commanderMod) _commanderMod = await import('../core/commander.js');
  return _commanderMod.commander;
}
let _sessionManagerMod: Awaited<typeof import('../agent/session-manager.js')> | null = null;
async function getSessionManager() {
  if (!_sessionManagerMod) _sessionManagerMod = await import('../agent/session-manager.js');
  return _sessionManagerMod.sessionManager;
}

export async function createGateway() {
  const app = Fastify({ logger: false });
  const getInFlightCount = (): number => {
    const db = getDb();
    const row = db.prepare(`
      SELECT COUNT(*) as count
      FROM tasks
      WHERE status IN ('queued', 'assigned', 'running', 'streaming')
    `).get() as { count: number };
    return row.count;
  };

  const cancelTaskById = async (taskId: string, reply?: { code: (statusCode: number) => unknown }) => {
    const db = getDb();
    const task = db.prepare('SELECT id, status FROM tasks WHERE id=?').get(taskId) as { id: string; status: string } | undefined;
    if (!task) {
      reply?.code(404);
      return { ok: false, killed: false, error: 'Task not found' };
    }

    if (TERMINAL_STATES.has(task.status)) {
      return { ok: true, killed: false, alreadyTerminal: true, status: task.status };
    }

    const killed = await taskQueue.abort(taskId);
    const moved = transitionTask(db, taskId, 'cancelled');

    if (!moved.ok) {
      if (moved.prev && TERMINAL_STATES.has(moved.prev)) {
        return { ok: true, killed, alreadyTerminal: true, status: moved.prev };
      }
      log.info({ taskId, prev: moved.prev }, 'Cancel skipped because task transition was rejected');
      return { ok: false, killed, status: moved.prev };
    }

    await eventBus.publish({ type: 'task:cancelled', taskId });
    return { ok: true, killed, status: 'cancelled' };
  };

  const validateRetryOverrideAgent = (ai: string | undefined): { ok: true } | { ok: false; body: Record<string, unknown> } => {
    if (!ai) return { ok: true };
    if (!agentManager.getProvider(ai) || !agentManager.listEnabledIds().includes(ai)) {
      return { ok: false, body: { error: 'invalid ai override' } };
    }
    return { ok: true };
  };

  const createRetryTask = async (
    taskId: string,
    options?: RetryTaskOptions,
  ): Promise<RetryTaskResult> => {
    const db = getDb();
    const sourceTaskId = resolveRetrySourceTaskId(db, taskId);
    const payload = loadRetryPayload(db, taskId, { allowCompletedSource: options?.allowCompletedSource });
    if (!payload) {
      return { ok: false, statusCode: 404, body: { error: 'Retry source not found' } };
    }

    const overrideValidation = validateRetryOverrideAgent(options?.overrideAi);
    if (!overrideValidation.ok) {
      return { ok: false, statusCode: 400, body: overrideValidation.body };
    }

    const finalPayload: RetryTaskPayload = {
      ...payload,
      ai: options?.overrideAi ?? payload.ai,
      // lineage를 생성 시점에 세팅 — 사후 UPDATE 비원자성으로 인한 retry cap 우회 방지
      parentTaskId: sourceTaskId,
      prompt: options?.reason
        ? `[Quality-gate reject: ${options.reason}]\n\n${payload.prompt}`
        : payload.prompt,
    };
    const retryReservation = reserveRetry(db, sourceTaskId)(sourceTaskId);
    if (!retryReservation.allowed) {
      return { ok: false, statusCode: 429, body: { error: 'retry limit exceeded', count: retryReservation.count } };
    }

    const created = await app.inject({ method: 'POST', url: '/api/task', payload: finalPayload });
    const body = created.json() as { taskId?: string; error?: string };
    if (created.statusCode >= 400 || !body.taskId) {
      rollbackRetryReservation(db, sourceTaskId);
      return { ok: false, statusCode: created.statusCode, body: body as Record<string, unknown> };
    }

    // parent_task_id는 finalPayload.parentTaskId로 생성 시점에 세팅됨 (원자성 — 사후 UPDATE 제거)
    return { ok: true, newTaskId: body.taskId, sourceTaskId, retryCount: retryReservation.count };
  };

  import('../core/kanban-engine.js').then(({ kanbanEngine }) => {
    kanbanEngine.createRetryTaskRef = createRetryTask;
  }).catch(err => {
    log.error({ err }, 'Failed to bind createRetryTaskRef to kanbanEngine');
  });

  const scheduleTaskFailover = async (
    taskId: string,
    failure: { status?: string | null; error?: string | null; response?: string | null },
  ): Promise<void> => {
    if ((process.env.NCO_AUTO_FAILOVER ?? 'on').toLowerCase() === 'off') return;
    if (!isRetryableFailoverFailure(failure)) return;

    const chains = loadFailoverChainsConfig();
    if (!chains) return;

    const db = getDb();
    const taskRow = db.prepare(`
      SELECT id, status, parent_task_id, assigned_to
      FROM tasks
      WHERE id=?
    `).get(taskId) as {
      id: string;
      status: string;
      parent_task_id: string | null;
      assigned_to: string | null;
    } | undefined;
    if (!taskRow || !taskRow.assigned_to || taskRow.status === 'cancelled') {
      return;
    }
    if (TERMINAL_STATES.has(taskRow.status) && taskRow.status !== 'failed' && taskRow.status !== 'timed_out') return;

    const sourceTaskId = taskRow.parent_task_id ?? taskRow.id;
    const attemptedAgents = (db.prepare(`
      SELECT assigned_to
      FROM tasks
      WHERE id=? OR parent_task_id=?
      ORDER BY created_at ASC
    `).all(sourceTaskId, sourceTaskId) as Array<{ assigned_to: string | null }>)
      .map(row => row.assigned_to)
      .filter((value): value is string => Boolean(value));
    const toAgent = selectFailoverCandidate({
      chain: chains[taskRow.assigned_to],
      attemptedAgents,
      isAvailable: (candidate) => {
        if (!agentManager.getProvider(candidate) || !agentManager.listEnabledIds().includes(candidate)) return false;
        return circuitBreakerRegistry.getAvailability(candidate).available;
      },
    });
    if (!toAgent) return;

    const created = await createRetryTask(taskId, { overrideAi: toAgent });
    if (!created.ok) {
      log.info({ taskId, toAgent, statusCode: created.statusCode, body: created.body }, 'Automatic task failover skipped');
      return;
    }

    await eventBus.publish({
      type: 'task:failover',
      taskId: created.newTaskId,
      sourceTaskId,
      fromAgent: taskRow.assigned_to,
      toAgent,
      reason: failure.error ?? failure.status ?? 'retryable_failure',
      retryCount: created.retryCount,
    });
  };

  const handleCompletedTaskQualityGate = async (taskId: string, response: string): Promise<void> => {
    const db = getDb();
    const taskRow = db.prepare(`
      SELECT assigned_to, verifier_json, parent_task_id
      FROM tasks
      WHERE id=?
    `).get(taskId) as { assigned_to: string | null; verifier_json: string | null; parent_task_id: string | null } | undefined;
    if (!taskRow) return;

    const quality = checkResponseQuality(response, {
      requireProtocolPrefix: Boolean(taskRow.verifier_json),
    });
    if (quality.pass) return;

    updateTaskQualityMetadata(db, taskId, quality.heuristics);

    // 같은 프로바이더 재시도는 quota/고장 상태에서 cap 3을 전소시킴 (E2E 실측 2026-07-03:
    // codex quota 중 ERROR_MARKER reject가 codex로 3연속 재배정) — 실패 failover와 동일한
    // 체인 선택기를 재사용해 미시도·가용 에이전트로 라우팅. 후보 없으면 기존대로 같은 ai 재시도.
    let toAgent: string | undefined;
    if (taskRow.assigned_to) {
      const chains = loadFailoverChainsConfig();
      if (chains) {
        const sourceTaskId = taskRow.parent_task_id ?? taskId;
        const attemptedAgents = (db.prepare(`
          SELECT assigned_to
          FROM tasks
          WHERE id=? OR parent_task_id=?
          ORDER BY created_at ASC
        `).all(sourceTaskId, sourceTaskId) as Array<{ assigned_to: string | null }>)
          .map(row => row.assigned_to)
          .filter((value): value is string => Boolean(value));
        toAgent = selectFailoverCandidate({
          chain: chains[taskRow.assigned_to],
          attemptedAgents,
          isAvailable: (candidate) => {
            if (!agentManager.getProvider(candidate) || !agentManager.listEnabledIds().includes(candidate)) return false;
            return circuitBreakerRegistry.getAvailability(candidate).available;
          },
        }) ?? undefined;
      }
    }

    const created = await createRetryTask(taskId, {
      allowCompletedSource: true,
      overrideAi: toAgent,
      reason: `quality_rejected: ${quality.heuristics.join(',')}`,
    });
    if (!created.ok) {
      log.warn({ taskId, heuristics: quality.heuristics, statusCode: created.statusCode, body: created.body }, 'Quality gate rejected completed task but retry creation failed');
      return;
    }

    await eventBus.publish({
      type: 'task:failover',
      taskId: created.newTaskId,
      sourceTaskId: created.sourceTaskId,
      fromAgent: taskRow.assigned_to ?? undefined,
      toAgent,
      reason: 'quality_rejected',
      retryCount: created.retryCount,
    });
  };

  await app.register(cors, {
    origin: [
      'http://localhost:6200', 'http://127.0.0.1:6200',
      'http://localhost:3000', 'http://127.0.0.1:3000',
      /^http:\/\/localhost:\d+$/,
    ],
  });

  // ═══ Rate Limiting ═══════════════════════════════════
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', '::1'],
  });

  // ═══ Global Error Handler ═══════════════════════════
  app.setErrorHandler((error, _request, reply) => {
    const err = error as any;
    log.error({ err: err.message, stack: err.stack }, 'Unhandled route error');
    const statusCode = err.statusCode || 500;
    reply.code(statusCode).send({
      error: statusCode >= 500 ? 'Internal Server Error' : err.message,
      statusCode,
    });
  });

  // Serve agent card JSON
  app.get('/.well-known/agent-card.json', async (req, reply) => {
    const { buildAgentCards } = await import('../core/agent-card.js');
    const cards = await buildAgentCards();
    reply.type('application/json').code(200);
    return { agents: cards };
  });

  // Root greeting route
  app.get('/', async () => {
    return { message: 'NCO Backend is running', status: 'ok' };
  });

  // ═══ Health ═══════════════════════════════════════
  app.get('/health', async () => {
    const agents = await sharedState.getAllAgentStates();
    const redisOk = await redisHealthCheck();
    return {
      status: 'healthy',
      service: 'nco-backend',
      version: '1.0.0',
      ports: { api: env.PORT, ws: env.WS_PORT },
      providerCount: agentManager.listEnabledIds().length,
      runtime: {
        redis: redisOk,
        agentsOnline: Object.values(agents).filter(a => a.status !== 'offline').length,
        uptime: process.uptime(),
      },
      timestamp: new Date().toISOString(),
    };
  });

  app.get('/api/health', async () => {
    const redisOk = await redisHealthCheck();
    return {
      healthy: true,
      api: { port: env.PORT },
      websocket: { port: env.WS_PORT },
      redis: { connected: redisOk },
      storage: { kind: 'sqlite', path: env.DATABASE_PATH },
      timestamp: new Date().toISOString(),
    };
  });

  // ═══ 이식 6종 라이브 라우트 (fleet-gateway/hive-relay/pa-inbox/recursive-decomposer/evidence-gate) ═══
  // 협업16 — fleet 노드 게이트웨이
  app.get('/api/fleet/nodes', async () => ({
    routable: fleetGateway.selectRoutableNodes(),
    snapshot: fleetGateway.snapshot(Date.now()),
  }));
  app.post('/api/fleet/:name/:action', async (req, reply) => {
    const { name, action } = req.params as { name: string; action: string };
    try {
      if (action === 'register') fleetGateway.registerNode(name, ((req.body as any) ?? { host: 'unknown' }));
      else if (action === 'activate') fleetGateway.activate(name);
      else if (action === 'drain') fleetGateway.drain(name);
      else if (action === 'cordon') fleetGateway.cordon(name);
      else if (action === 'restart') fleetGateway.restart(name);
      else { reply.code(400); return { error: `unknown action '${action}'` }; }
      return { ok: true, node: fleetGateway.getNode(name) };
    } catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });
  // 협업17 — Hive Relay
  app.get('/api/hive/sessions', async () => ({
    sessions: hiveRelay.listSessions(),
    sharedKnowledge: hiveRelay.getSharedKnowledge(),
  }));
  app.post('/api/hive/join', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const r = hiveRelay.joinSession(String(b.inviteCode ?? ''), {
      id: String(b.id ?? ''), name: String(b.name ?? ''), role: b.role, capabilities: b.capabilities,
    });
    if (!r.ok) { reply.code(400); return r; }
    return r;
  });
  // 협업15 — PA inbox
  app.post('/api/inbox/:slug', async (req) => ({
    enqueued: getPaInbox().enqueue((req.params as any).slug, String((req.body as any)?.body ?? '')),
  }));
  app.post('/api/inbox/:slug/drain', async (req) => ({
    messages: getPaInbox().drain((req.params as any).slug),
  }));
  // P2-11 — 재귀 분해
  app.post('/api/decompose', async (req) => {
    const b = (req.body ?? {}) as any;
    const tree = decompose(String(b.task ?? ''), { maxDepth: b.maxDepth, maxNodes: b.maxNodes });
    return { tree, leaves: getLeaves(tree).length, nodes: countNodes(tree) };
  });
  // P1-6 — 증거 게이트(체크 엔드포인트; 완료경로 하드차단은 opt-in으로 미적용)
  app.post('/api/evidence/check', async (req) => {
    const b = (req.body ?? {}) as any;
    return requireEvidence(b.evidence ?? {}, Array.isArray(b.requiredKinds) ? b.requiredKinds : []);
  });
  // P2-10 — PA 수명주기 비용 노브
  app.get('/api/lifecycle', async () => ({
    defaultMode: paLifecycle.defaultMode,
    stickyTtlMs: paLifecycle.stickyTtlMs,
    warm: paLifecycle.snapshot(),
    evictable: paLifecycle.evictable(Date.now()),
  }));
  app.post('/api/lifecycle/:agentId/:mode', async (req, reply) => {
    const { agentId, mode } = req.params as { agentId: string; mode: string };
    if (mode !== 'always-on' && mode !== 'sticky' && mode !== 'on-demand') {
      reply.code(400);
      return { error: `invalid mode '${mode}' (always-on|sticky|on-demand)` };
    }
    paLifecycle.setMode(agentId, mode as LifecycleMode);
    return { ok: true, agentId, mode: paLifecycle.modeOf(agentId) };
  });

  // ═══ SSE Event Stream ═════════════════════════════════
  app.get('/api/events/stream', async (request, reply) => {
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const handler = (event: NCOEvent) => {
      try { reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
    };
    eventBus.on('*', handler);
    // Keep-alive ping to detect dead connections
    const keepAlive = setInterval(() => {
      try { reply.raw.write(': keepalive\n\n'); } catch { clearInterval(keepAlive); eventBus.off('*', handler); }
    }, 30000);
    request.raw.on('close', () => { clearInterval(keepAlive); eventBus.off('*', handler); });
    await new Promise(() => {}); // keep alive until client disconnects
  });

  // ═══ AI Providers ═════════════════════════════════
  app.get('/api/ai-providers', async () => {
    const states = await sharedState.getAllAgentStates();
    const providers = agentManager.listProviders().map(p => ({
      ...p,
      status: states[p.id]?.status || 'offline',
      ai_status: states[p.id]?.status || 'offline',
      health: states[p.id]?.health || { consecutiveFailures: 0, circuitState: 'closed', lastError: null },
    }));
    return { providers };
  });

  app.get('/api/ai-providers/enabled', async () => {
    const states = await sharedState.getAllAgentStates();
    const providers = agentManager.listProviders().filter(p => p.enabled).map(p => ({
      ...p,
      status: states[p.id]?.status || 'offline',
    }));
    return { providers };
  });

  app.get('/api/ai-providers/status', async () => {
    const states = await sharedState.getAllAgentStates();
    const providers: Record<string, AgentState> = {};
    for (const p of agentManager.listProviders()) {
      const s = states[p.id];
      providers[p.id] = {
        id: p.id,
        status: s?.status || 'offline',
        currentTask: s?.currentTask || null,
        currentFiles: s?.currentFiles || [],
        lastAction: s?.lastAction || null,
        lastActionAt: s?.lastActionAt || null,
        messageCount: s?.messageCount || 0,
        health: s?.health || { consecutiveFailures: 0, circuitState: 'closed', lastError: null },
      };
    }
    return { providers };
  });

  await registerCircuitRoutes(app);

  // ═══ Daemons ══════════════════════════════════════
  app.get('/api/daemons', async () => {
    const states = await sharedState.getAllAgentStates();
    const daemons = agentManager.listProviders().map(p => {
      const s = states[p.id];
      const status = s?.status || 'offline';
      // Determine agent category for UI display
      const agentType: 'cli' | 'api' = (p as any).type || 'cli';
      return {
        id: p.id,
        name: p.id,
        status,
        running: status !== 'offline',
        available: s?.health?.circuitState !== 'open',
        ai_status: status,
        role: p.role,
        score: p.score,
        enabled: p.enabled,
        type: agentType,
        currentTask: s?.currentTask || null,
        tasks: { active: s?.currentTask ? 1 : 0 },
        health: s?.health || { consecutiveFailures: 0, circuitState: 'closed', lastError: null },
      };
    });
    return { daemons };
  });

  // ═══ Tasks ════════════════════════════════════════
  app.post('/api/task', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const parsed = CreateTaskInput.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid input', details: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
    }
    const input = parsed.data;
    // 협업19 이식(agency-swarm): 위임 payload ai를 동적 등록 에이전트로 접수차단 검증.
    // 정적 enum(CreateTaskInput)은 통과했으나 런타임 미등록인 ai를 intake에서 차단
    // (기존: queued 접수 후 실행 시점에 "Unknown agent" 지연 실패 — claude-1 T1 관측).
    if (input.ai) {
      const knownAgents = agentManager.listEnabledIds();
      const dp = validateDelegationPayload({ ai: input.ai, prompt: input.prompt }, knownAgents);
      if (!dp.ok) {
        reply.code(400);
        return { error: 'delegation_payload_rejected', detail: dp.error, knownAgents };
      }
    }
    // P2-13 이식(context-budget): 초대형 프롬프트(>100KB)는 결정론적 압축으로 컨텍스트 예산 보호.
    if (typeof input.prompt === 'string' && input.prompt.length > MAX_PLAN_CHARS) {
      input.prompt = compressPlan(input.prompt);
    }
    const taskId = createTaskId();
    const requestedProvider = input.ai ?? 'claude-code';
    const allowProviderFailover = input.metadata?.allowProviderFailover === true;
    const providerSelection = selectTaskProvider(requestedProvider, allowProviderFailover);
    if ('error' in providerSelection) {
      reply.code(409);
      return providerSelection.error;
    }
    const agentId = providerSelection.agentId;

    // Extract caller context for invocation tracking
    const body = req.body as any;
    const callerSessionId = body.callerSessionId
      || (req.headers['x-nco-session-id'] as string)
      || 'unknown';
    const callerAgentId = body.callerAgentId || 'unknown';
    // CLI session that spawned this task — used by topology to draw CLI→Agent edges
    const spawnedByCli = callerAgentId !== 'unknown' ? callerAgentId
      : callerSessionId !== 'unknown' ? callerSessionId
      : null;

    // Save to DB
    const db = getDb();
    try {
      const verifierJson = input.verifier ? JSON.stringify(input.verifier) : null;
      // P1-6 evidence-gate opt-in: requiredEvidence를 metadata_json에 지속(기존 verifier 흐름 무영향)
      // metadata 병합 지속: projectDir 등 실행 옵션이 input.metadata로 유입돼도 유실 방지
      // (2026-07-08 claude-1: enqueue에서 input.metadata 미전달 → projectDir 유실 T1 확인)
      const mergedMetadata = {
        ...(input.metadata ?? {}),
        ...(input.requiredEvidence && input.requiredEvidence.length > 0
          ? { requiredEvidence: input.requiredEvidence }
          : {}),
      };
      const metadataJson = Object.keys(mergedMetadata).length > 0
        ? JSON.stringify(mergedMetadata)
        : null;
      db.prepare(`
        INSERT INTO tasks (id, mode, prompt, system_prompt, assigned_to, status, workspace_id, priority, spawned_by_cli, verifier_json, metadata_json, parent_task_id, last_activity_at)
        VALUES (?, ?, ?, ?, ?, 'assigned', ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(taskId, input.mode, input.prompt, input.systemPrompt || null, agentId, input.workspaceId, input.priority, spawnedByCli, verifierJson, metadataJson, input.parentTaskId ?? null);
    } catch (dbErr) {
      log.error({ err: (dbErr as Error).message, taskId }, 'Failed to insert task');
      reply.code(500); return { error: 'Failed to create task' };
    }

    await eventBus.publish({ type: 'task:created', taskId, agentId, prompt: input.prompt });

    // Record invocation
    const invocationId = await invocationTracker.recordInvocation(
      callerSessionId,
      callerAgentId,
      agentId,
      input.prompt,
      input.mode || 'task',
      taskId,
    );

    // Inject workspace conversation history into systemPrompt so the agent
    // has context from previous turns in the same workspace session.
    // Only when the caller EXPLICITLY passed workspaceId — otherwise one-shot
    // tasks get polluted with unrelated 'default' workspace history and the
    // agent answers the old conversation instead of the current prompt.
    const explicitWorkspace = typeof (req.body as any)?.workspaceId === 'string';
    const systemPromptWithContext = explicitWorkspace
      ? injectContext(input.systemPrompt, input.workspaceId || 'default', taskId)
      : input.systemPrompt;

    // Enqueue via TaskQueueManager (BullMQ or semaphore) — respects per-agent concurrency
    taskQueue.enqueue({ taskId, agentId, prompt: input.prompt, systemPrompt: systemPromptWithContext, timeoutMs: input.timeout, verifier: input.verifier, metadata: { ...(input.metadata ?? {}), invocationId } })
      .then(result => {
        const response = (result.output != null && result.output !== '') ? result.output : '';
        const classifiedFailure = detectFailedCompletion(response);
        const nextStatus = result.status === 'cancelled'
          ? 'cancelled'
          : result.status === 'timed_out' || result.error === 'timeout(idle)' || result.error === 'timeout(hardcap)'
            ? 'timed_out'
            : result.success && !classifiedFailure
              ? 'completed'
              : 'failed';
        const error = nextStatus === 'completed' ? undefined : buildFailureError(result);
        try {
          const moved = transitionTask(db, taskId, nextStatus, {
            response: response || undefined,
            error,
            completedAt: nextStatus !== 'cancelled',
            evidenceJson: nextStatus === 'completed' ? result.evidenceJson : undefined,
          });
          if (!moved.ok) {
            log.info({ taskId, prev: moved.prev, next: nextStatus }, 'Skipped terminal completion update');
          } else if (nextStatus === 'completed') {
            void handleCompletedTaskQualityGate(taskId, response)
              .catch(err => log.warn({ err: err instanceof Error ? err.message : String(err), taskId }, 'Completed task quality gate failed'));
          }
        } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update after task completion failed'); }
        if (nextStatus !== 'completed' && nextStatus !== 'cancelled') {
          void scheduleTaskFailover(taskId, { status: nextStatus, error: error ?? null, response })
            .catch(err => log.warn({ err: err instanceof Error ? err.message : String(err), taskId }, 'Auto failover scheduling failed'));
        }
      })
      .catch(err => {
        const failureError = err.message || 'unknown: enqueue failure';
        try {
          const moved = transitionTask(db, taskId, 'failed', { error: failureError });
          if (!moved.ok) {
            log.info({ taskId, prev: moved.prev, next: 'failed' }, 'Skipped terminal failure update');
          }
        } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update after task failure failed'); }
        void scheduleTaskFailover(taskId, { status: 'failed', error: failureError, response: null })
          .catch(scheduleErr => log.warn({ err: scheduleErr instanceof Error ? scheduleErr.message : String(scheduleErr), taskId }, 'Auto failover scheduling failed'));
      });

    reply.code(202);
    return {
      taskId,
      status: 'queued',
      agentId,
      invocationId,
      requestedProvider: providerSelection.failover ? requestedProvider : undefined,
      failover: providerSelection.failover,
    };
  });

  app.post('/api/tasks', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    // Alias for /api/task — inject 응답 객체를 그대로 반환하면 내부 res가 직렬화되어 깨진 JSON이 나감
    const res = await app.inject({ method: 'POST', url: '/api/task', payload: req.body as any });
    reply.code(res.statusCode);
    return res.json();
  });

  app.get('/api/tasks', async (req) => {
    const query = req.query as any;
    const rawLimit = Number(query.limit || 100);
    const limit = Math.min(Number.isFinite(rawLimit) ? rawLimit : 100, 500);
    const db = getDb();
    const where: string[] = [];
    const params: any[] = [];

    if (query.workspaceId) {
      where.push('workspace_id=?');
      params.push(query.workspaceId);
    }

    if (query.provider) {
      where.push('assigned_to=?');
      params.push(query.provider);
    }

    const whereClause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT * FROM tasks${whereClause} ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const tasks = (db.prepare(sql).all(...params) as Array<{ id: string; last_activity_at?: string | null }>)
      .map(task => withTaskRuntime(task));
    return { tasks };
  });

  app.get('/api/task/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const task = db.prepare(`
      SELECT id, status, assigned_to, progress, prompt, response, error, created_at, completed_at
      FROM tasks
      WHERE id=?
    `).get(id) as {
      id: string;
      status: string | null;
      assigned_to: string | null;
      progress: string | null;
      prompt: string | null;
      response: string | null;
      error: string | null;
      created_at: string | null;
      completed_at: string | null;
    } | undefined;

    if (!task) {
      reply.code(404);
      return { error: 'not found' };
    }

    return {
      task: {
        id: task.id,
        status: task.status,
        assigned_to: task.assigned_to,
        progress: task.progress,
        prompt: task.prompt?.slice(0, 200) ?? null,
        response: task.response?.slice(0, 20_000) ?? null,
        error: task.error,
        created_at: task.created_at,
        completed_at: task.completed_at,
      },
    };
  });

  app.get('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as any;
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as { id: string; last_activity_at?: string | null } | undefined;
    if (!task) { reply.code(404); return { error: 'Task not found' }; }
    return { task: withTaskRuntime(task) };
  });

  app.get('/api/tasks/:id/status', async (req, reply) => {
    const { id } = req.params as any;
    const db = getDb();
    const task = db.prepare('SELECT id, status, progress, response, error, updated_at, last_activity_at FROM tasks WHERE id=?').get(id) as any;
    if (!task) { reply.code(404); return { error: 'Task not found' }; }
    const runtime = taskQueue.getTaskSnapshot(task.id);
    return {
      taskId: task.id,
      status: task.status,
      progress: task.progress,
      result: task.response,
      updatedAt: task.updated_at,
      lastActivityAt: runtime.lastActivityAt ?? task.last_activity_at ?? null,
      liveness: runtime.liveness,
    };
  });

  app.post('/api/acquisitions/discover', async (req, reply) => {
    const parsed = AcquisitionDiscoverBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid input', details: parsed.error.issues.map(issue => issue.message) };
    }

    const input = parsed.data;
    const discovered = await discoverAcquisitions(input);
    const results = [];
    for (const candidate of discovered) {
      try {
        results.push(await processAcquisitionCandidate({
          packageName: candidate.packageName,
          version: candidate.version,
          sourceType: candidate.sourceType,
          sourceRef: candidate.sourceRef,
          evidence: candidate.evidence,
          discoveredFrom: {
            request: input,
            sourceType: candidate.sourceType,
            sourceRef: candidate.sourceRef,
          },
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // dist-tag / version resolution errors → 400 (client error), not 500
        if (message.includes('dist-tag') || message.includes('npm registry')) {
          reply.code(400);
          return { error: 'Version resolution failed', details: message };
        }
        throw err;
      }
    }

    return {
      count: results.length,
      acquisitions: results,
    };
  });

  app.post('/api/acquisitions/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = acquisitionRegistry.getById(id);
    if (!record) {
      reply.code(404);
      return { error: 'Acquisition not found' };
    }
    if (record.decision !== 'approval_required' || record.approval_state !== 'required') {
      reply.code(409);
      return { error: 'Acquisition is not pending approval' };
    }

    let currentRecord = record;
    let install: { installDir: string; packageDir: string; packageSha256: string } | null = null;
    let skill: { id: string; name: string; description: string } | null = null;

    try {
      install = await installAcquiredPackage({
        packageName: record.package_name,
        version: record.version,
      });
      currentRecord = acquisitionRegistry.markInstalled(id, install.packageDir, install.packageSha256);
    } catch (error) {
      currentRecord = acquisitionRegistry.markInstallFailed(id, error instanceof Error ? error.message : String(error));
      reply.code(502);
      return { record: serializeAcquisitionRecord(currentRecord), install, skill };
    }

    try {
      const registration = await acquisitionRegistry.registerDynamicSkill(id);
      currentRecord = registration.record;
      skill = {
        id: registration.skill.id,
        name: registration.skill.name,
        description: registration.skill.description,
      };
    } catch (error) {
      currentRecord = acquisitionRegistry.markRegistrationFailed(id, error instanceof Error ? error.message : String(error));
      reply.code(502);
    }

    return {
      record: serializeAcquisitionRecord(currentRecord),
      install,
      skill,
    };
  });

  app.get('/api/acquisitions', async (req, reply) => {
    const query = req.query as { decision?: string; limit?: string | number };
    const decision = query.decision
      ? AcquisitionDecisionFilterSchema.safeParse(query.decision)
      : null;
    if (decision && !decision.success) {
      reply.code(400);
      return { error: 'Invalid decision filter' };
    }

    const limitRaw = typeof query.limit === 'number' ? query.limit : Number(query.limit ?? 100);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
    const records = acquisitionRegistry.list(limit)
      .filter(record => !decision || record.decision === decision.data)
      .map(serializeAcquisitionRecord);

    return { acquisitions: records };
  });

  app.post('/api/tasks/:id/cancel', async (req, reply) => {
    const { id } = req.params as any;
    return cancelTaskById(id, reply);
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as any;
    return cancelTaskById(id, reply);
  });

  app.post('/api/tasks/:id/retry', async (req, reply) => {
    const { id } = req.params as any;
    const parsedBody = RetryTaskBodySchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      reply.code(400);
      return { error: 'Invalid input', details: parsedBody.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
    }
    const created = await createRetryTask(id, { overrideAi: parsedBody.data.ai });
    if (!created.ok) {
      reply.code(created.statusCode);
      return created.body;
    }
    reply.code(202);
    return { newTaskId: created.newTaskId, retryOf: id };
  });

  app.get('/api/admin/drain', async () => {
    return { draining, inFlight: getInFlightCount() };
  });

  app.post('/api/admin/drain', async (req, reply) => {
    const body = req.body as { enabled?: unknown } | undefined;
    if (typeof body?.enabled !== 'boolean') {
      reply.code(400);
      return { error: 'enabled must be boolean' };
    }

    draining = body.enabled;
    return { draining, inFlight: getInFlightCount() };
  });

  // ═══ Chat ═════════════════════════════════════════
  app.post('/api/chat/messages', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const body = req.body as any;
    const prompt = (body.message || body.prompt || '').trim();
    if (!prompt) { reply.code(400); return { error: 'prompt is required' }; }
    const agentId = body.ai ?? 'claude-code';

    const taskId = createTaskId();
    reply.code(202);

    // Async execution
    agentManager.executeTask(agentId, prompt, { taskId })
      .catch(err => log.error({ err: err.message }, 'Chat execution failed'));

    return { taskId, status: 'accepted', agentId };
  });

  app.get('/api/chat/ais', async () => {
    const providers = agentManager.listProviders().filter(p => p.enabled);
    return { ais: providers.map(p => ({ id: p.id, name: p.name, role: p.role, score: p.score })) };
  });

  // ═══ Natural Language Intent Parser ═════════════════════
  app.post('/api/nlp/intent', async (req, reply) => {
    const { parseIntent } = await import('../utils/intent-parser.js');
    const body = req.body as any;
    if (!body.query || typeof body.query !== 'string') {
      reply.code(400); return { error: 'query is required' };
    }
    const result = parseIntent(body.query);
    return { intent: result };
  });

  app.post('/api/discussion', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const parsed = DiscussionRouteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid input', details: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
    }

    const body = parsed.data;
    const sessionId = body.sessionId ?? createSessionId();
    const providers = body.participants ?? body.providers;

    discussionEngine.startDiscussion({
      topic: body.topic,
      mode: body.mode,
      providers,
      maxRounds: body.rounds ?? body.maxRounds,
      consensusThreshold: body.consensusThreshold,
      initiator: body.initiator,
      sessionId,
    }).catch(err => log.error({ err: err.message, sessionId }, 'Discussion failed'));

    reply.code(202);
    return { sessionId, status: 'started', mode: body.mode, participants: providers ?? null };
  });

  app.get('/api/consensus', async (req, reply) => {
    const parsed = ListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid query', details: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
    }

    const db = getDb();
    const rows = db.prepare(`
      SELECT id, topic, mode, status, participants_json, consensus_rate, created_at, ended_at
      FROM discussions
      ORDER BY created_at DESC
      LIMIT ?
    `).all(parsed.data.limit) as Array<{
      id: string;
      topic: string;
      mode: string | null;
      status: string | null;
      participants_json: string;
      consensus_rate: number | null;
      created_at: string | null;
      ended_at: string | null;
    }>;

    const discussions = rows.map((row) => {
      let participants: string[] = [];
      try {
        const parsedParticipants = JSON.parse(row.participants_json) as unknown;
        participants = Array.isArray(parsedParticipants)
          ? parsedParticipants.filter((value): value is string => typeof value === 'string')
          : [];
      } catch {
        participants = [];
      }

      return {
        id: row.id,
        topic: row.topic,
        mode: row.mode,
        status: row.status,
        consensusRate: row.consensus_rate,
        participantCount: participants.length,
        participants,
        createdAt: row.created_at,
        endedAt: row.ended_at,
      };
    });

    return { discussions };
  });

  app.post('/api/parallel', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const parsed = ParallelRouteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid input', details: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
    }

    const body = parsed.data;
    discussionEngine.executeParallel(body.prompt, body.providers)
      .catch(err => log.error({ err: err.message }, 'Parallel failed'));

    reply.code(202);
    return { status: 'started', providers: body.providers };
  });

  // ═══ Discussions / Realtime ═══════════════════════
  app.post('/api/realtime/discussion', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const input = CreateDiscussionInput.parse(req.body);
    const gated = resolveRealtimeProviders('discussion', input.providers);
    if (!gated.ok) {
      reply.code(409);
      return gated.body;
    }
    reply.code(202);

    // Pre-create sessionId and inject it — both client and DB use the same ID
    const sessionId = createSessionId();
    const db = getDb();

    discussionEngine.startDiscussion({
      topic: input.prompt,
      mode: input.mode as any,
      providers: gated.providers,
      maxRounds: input.maxRounds,
      consensusThreshold: input.consensusThreshold,
      sessionId,
    })
      .then(report => {
        // Save summary to tasks table so nco_list_tasks / nco_get_task can find it
        const taskId = createTaskId();
        try {
          db.prepare(`
            INSERT OR IGNORE INTO tasks (id, mode, prompt, assigned_to, status, response, completed_at, updated_at)
            VALUES (?, ?, ?, 'discussion-engine', 'completed', ?, datetime('now'), datetime('now'))
          `).run(taskId, input.mode, input.prompt, report.adoptedProposal);
          log.info({ sessionId, taskId, consensusRate: report.finalConsensusRate }, 'Discussion saved');
        } catch (dbErr) {
          log.error({ err: (dbErr as Error).message, sessionId, taskId }, 'Failed to save discussion result');
        }
      })
      .catch(err => log.error({ err: err.message, sessionId }, 'Discussion failed'));

    return { sessionId, status: 'started', mode: input.mode, providers: gated.providers };
  });

  app.post('/api/realtime/parallel', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const body = req.body as any;
    const gated = resolveRealtimeProviders('parallel', body.providers);
    if (!gated.ok) {
      reply.code(409);
      return gated.body;
    }
    const providers = gated.providers;
    reply.code(202);

    const db = getDb();
    discussionEngine.executeParallel(body.prompt, providers)
      .then(responses => {
        // Save each parallel result as a completed task
        for (const [agentId, output] of Object.entries(responses)) {
          const taskId = createTaskId();
          try {
            db.prepare(`
              INSERT OR IGNORE INTO tasks (id, mode, prompt, assigned_to, status, response, completed_at, updated_at)
              VALUES (?, 'parallel', ?, ?, 'completed', ?, datetime('now'), datetime('now'))
            `).run(taskId, body.prompt, agentId, output as string);
          } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'Failed to save parallel result'); }
        }
      })
      .catch(err => log.error({ err: err.message }, 'Parallel failed'));

    return { status: 'started', providers };
  });

  app.post('/api/realtime/consensus', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const input = CreateDiscussionInput.parse(req.body);
    const gated = resolveRealtimeProviders('consensus', input.providers);
    if (!gated.ok) {
      reply.code(409);
      return gated.body;
    }
    reply.code(202);

    const sessionId = createSessionId();
    const db = getDb();

    discussionEngine.startDiscussion({
      topic: input.prompt,
      mode: 'consensus',
      providers: gated.providers,
      consensusThreshold: input.consensusThreshold,
      sessionId,
    })
      .then(report => {
        const taskId = createTaskId();
        try {
          db.prepare(`
            INSERT OR IGNORE INTO tasks (id, mode, prompt, assigned_to, status, response, completed_at, updated_at)
            VALUES (?, 'consensus', ?, 'discussion-engine', 'completed', ?, datetime('now'), datetime('now'))
          `).run(taskId, input.prompt, report.adoptedProposal);
        } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'Failed to save consensus result'); }
      })
      .catch(err => log.error({ err: err.message, sessionId }, 'Consensus failed'));

    return { sessionId, status: 'started', mode: 'consensus', providers: gated.providers };
  });

  app.post('/api/discussion/create', async (req, reply) => {
    const body = req.body as any;
    const sessionId = createSessionId();
    reply.code(202);
    return {
      session: {
        id: sessionId,
        sessionId,
        mode: body.mode || 'discussion',
        providers: body.providers || [],
        status: 'created',
        wsUrl: `ws://localhost:${env.WS_PORT}/discussion/${sessionId}`,
        createdAt: new Date().toISOString(),
      },
    };
  });

  // Start a discussion tied to the real engine (replaces legacy /discussion/start stub)
  app.post('/api/discussion/start', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const body = req.body as any;
    const topic = body.topic || body.prompt;
    if (!topic) { reply.code(400); return { error: 'topic or prompt required' }; }
    const sessionId = body.sessionId || createSessionId();
    const mode: any = body.mode || 'discussion';
    reply.code(202);
    discussionEngine.startDiscussion({
      topic,
      mode,
      providers: body.providers,
      maxRounds: body.maxRounds ?? body.rounds,
      consensusThreshold: body.consensusThreshold,
      sessionId,
    }).catch(err => log.error({ err: err.message, sessionId }, 'Discussion failed'));
    return { sessionId, status: 'started', mode, wsUrl: `ws://localhost:${env.WS_PORT}/discussion/${sessionId}` };
  });

  // ═══ Discussions DB ═══════════════════════════════
  app.get('/api/discussions', async () => {
    const db = getDb();
    return { discussions: db.prepare('SELECT * FROM discussions ORDER BY created_at DESC LIMIT 50').all() };
  });

  const getDiscussionById = async (req: any, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const discussion = db.prepare(`
      SELECT
        id,
        topic,
        mode,
        status,
        current_round,
        max_rounds,
        consensus_threshold,
        consensus_rate,
        participants_json,
        initiator,
        result_json,
        report,
        task_id,
        created_at,
        ended_at
      FROM discussions
      WHERE id=?
    `).get(id) as {
      id: string;
      topic: string;
      mode: string | null;
      status: string | null;
      current_round: number | null;
      max_rounds: number | null;
      consensus_threshold: number | null;
      consensus_rate: number | null;
      participants_json: string | null;
      initiator: string | null;
      result_json: string | null;
      report: string | null;
      task_id: string | null;
      created_at: string | null;
      ended_at: string | null;
    } | undefined;

    if (!discussion) {
      reply.code(404);
      return { error: 'not found' };
    }

    const messages = db.prepare(`
      SELECT id, discussion_id, agent_id, round, message_type, content, scores_json, vote_choice, vote_reason, created_at
      FROM (
        SELECT *
        FROM discussion_messages
        WHERE discussion_id=?
        ORDER BY created_at DESC
        LIMIT 50
      )
      ORDER BY created_at ASC
    `).all(id) as Array<{
      id: string;
      discussion_id: string;
      agent_id: string | null;
      round: number | null;
      message_type: string | null;
      content: string;
      scores_json: string | null;
      vote_choice: string | null;
      vote_reason: string | null;
      created_at: string | null;
    }>;

    return {
      discussion: {
        id: discussion.id,
        topic: discussion.topic,
        mode: discussion.mode,
        status: discussion.status,
        current_round: discussion.current_round,
        max_rounds: discussion.max_rounds,
        consensus_threshold: discussion.consensus_threshold,
        consensus_rate: discussion.consensus_rate,
        participants: parseStringArray(discussion.participants_json),
        initiator: discussion.initiator,
        result_json: discussion.result_json,
        report: discussion.report,
        task_id: discussion.task_id,
        created_at: discussion.created_at,
        ended_at: discussion.ended_at,
      },
      messages,
    };
  };

  app.get('/api/discussion/:id', getDiscussionById);
  app.get('/api/discussions/:id', async (req, reply) => {
    return getDiscussionById(req, reply);
  });

  app.get('/api/discussions/:id/messages', async (req) => {
    const { id } = req.params as any;
    const db = getDb();
    return { messages: db.prepare('SELECT * FROM discussion_messages WHERE discussion_id=? ORDER BY created_at').all(id) };
  });

  app.get('/api/discussions/:id/export', async (req, reply) => {
    const { id } = req.params as any;
    const { format = 'json' } = req.query as any;
    const db = getDb();
    const disc = db.prepare('SELECT * FROM discussions WHERE id=?').get(id) as any;
    if (!disc) { reply.code(404); return { error: 'Not found' }; }

    const messages = db.prepare(
      'SELECT * FROM discussion_messages WHERE discussion_id=? ORDER BY created_at'
    ).all(id) as any[];

    if (format === 'markdown') {
      let participants: string[] = [];
      try { participants = JSON.parse(disc.participants_json || '[]'); } catch { /* corrupted JSON */ }
      const lines: string[] = [
        `# Discussion Export: ${disc.topic}`,
        ``,
        `- **ID**: ${disc.id}`,
        `- **Mode**: ${disc.mode}`,
        `- **Status**: ${disc.status}`,
        `- **Participants**: ${participants.join(', ')}`,
        `- **Consensus Rate**: ${((disc.consensus_rate || 0) * 100).toFixed(1)}%`,
        `- **Created**: ${disc.created_at}`,
        ``,
        `## Messages`,
        ``,
      ];
      for (const msg of messages) {
        lines.push(`### Round ${msg.round ?? 'N/A'} — ${msg.agent_id} (${msg.message_type})`);
        lines.push(``);
        lines.push(msg.content || '');
        lines.push(``);
        lines.push(`---`);
        lines.push(``);
      }
      if (disc.report) {
        lines.push(`## Final Report`);
        lines.push(``);
        lines.push(disc.report);
      }
      reply.header('Content-Type', 'text/markdown; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="discussion-${id}.md"`);
      return reply.send(lines.join('\n'));
    }

    return { discussion: disc, messages };
  });

  // ═══ Rate Limits ══════════════════════════════════
  app.get('/api/rate-limits', async () => {
    const db = getDb();
    return { providers: db.prepare('SELECT * FROM rate_limit_state').all() };
  });

  // ═══ Queue Metrics ════════════════════════════════
  app.get('/api/queue/metrics', async (req) => {
    const { agentId } = req.query as any;
    const metrics = await taskQueue.getMetrics(agentId);
    return { metrics };
  });

  // ═══ Metrics ══════════════════════════════════════
  app.get('/api/stats', async () => {
    const db = getDb();
    const totalTasks = (db.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as any).cnt;
    const completedTasks = (db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status='completed'").get() as any).cnt;
    const totalDiscussions = (db.prepare('SELECT COUNT(*) as cnt FROM discussions').get() as any).cnt;
    return { totalTasks, completedTasks, totalDiscussions };
  });

  // ═══ Agent Actions (recent activity) ══════════════
  app.get('/api/agent-actions', async (req) => {
    const query = req.query as any;
    const limit = Math.min(Number(query.limit || 20), 100);
    const db = getDb();
    return { actions: db.prepare('SELECT * FROM agent_actions ORDER BY created_at DESC LIMIT ?').all(limit) };
  });

  // ═══ Agent Messages ═══════════════════════════════
  app.get('/api/messages', async (req) => {
    const query = req.query as any;
    const limit = Math.min(Number(query.limit || 20), 100);
    const db = getDb();
    return { messages: db.prepare('SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT ?').all(limit) };
  });

  // ═══ CLI Mesh — Inter-agent awareness ══════════════
  app.post('/api/mesh/heartbeat', async (req) => {
    const cliMesh = await getCliMesh();
    const body = req.body as any;
    if (!body.sessionId || !body.agentId) return { error: 'sessionId and agentId required' };
    const result = await cliMesh.heartbeat(body);
    // Broadcast full session update (including conflicts) to dashboard
    await eventBus.publish({
      type: 'mesh:session_update',
      session: {
        sessionId: body.sessionId,
        agentId: body.agentId,
        pid: body.pid,
        status: body.status,
        workMode: body.workMode,
        currentWork: body.currentWork,
        currentFiles: body.currentFiles || [],
        branch: body.branch,
        taskId: body.taskId,
        collaborators: body.collaborators || [],
        lastHeartbeat: new Date().toISOString(),
        activeConflicts: result.conflictReports,
      },
    } as any);
    return result;
  });

  // Pre-work conflict check — call before starting a task
  app.post('/api/mesh/check', async (req) => {
    const cliMesh = await getCliMesh();
    const { sessionId, agentId, plannedWork, plannedFiles, branch } = req.body as any;
    if (!sessionId || !agentId) return { error: 'sessionId and agentId required' };
    const result = await cliMesh.checkWorkConflicts(
      sessionId, agentId,
      plannedWork || '',
      plannedFiles || [],
      branch || 'unknown',
    );
    return result;
  });

  app.get('/api/mesh/sessions', async () => {
    const cliMesh = await getCliMesh();
    const sessions = await cliMesh.getActiveSessions();
    return { sessions, count: sessions.length };
  });

  app.get('/api/mesh/summary', async () => {
    const cliMesh = await getCliMesh();
    const summary = await cliMesh.getWorkSummary();
    return { summary };
  });

  app.post('/api/mesh/send', async (req, reply) => {
    const cliMesh = await getCliMesh();
    const parsed = MeshSendBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_mesh_message', issues: parsed.error.issues };
    }
    const { fromSessionId, fromAgent, toSessionId, content, type } = parsed.data;
    const destination = toSessionId || '*';
    const mode = getMeshCommGraphMode();
    if (mode !== 'off') {
      const route = evaluateCommGraph({
        from: fromAgent || 'unknown',
        to: destination,
        type,
      });
      if (!route.allowed) {
        const denial = {
          reason: route.reason,
          from: fromAgent || 'unknown',
          to: destination,
          type,
          mode,
        };
        if (mode === 'shadow') {
          log.warn(denial, 'mesh:route_denied_shadow');
        } else {
          reply.code(403);
          return {
            error: 'mesh_route_denied',
            ...denial,
          };
        }
      }
    }
    const delivered = await cliMesh.sendMessage(
      fromSessionId, fromAgent || 'unknown', destination, content, type,
    );
    // cli-mesh.sendMessage already publishes mesh:message event
    return { delivered };
  });

  app.get('/api/mesh/messages/:sessionId', async (req) => {
    const cliMesh = await getCliMesh();
    const { sessionId } = req.params as any;
    const { drain } = (req.query as any) || {};
    // Combined view: persisted history + pending queue (real-time inbox)
    const history = cliMesh.getMessageHistory(sessionId);
    const pending = await cliMesh.peekPendingMessages(sessionId, drain === '1');
    return { messages: history, pending };
  });

  app.post('/api/mesh/complete', async (req) => {
    const cliMesh = await getCliMesh();
    const { sessionId, completedWork } = req.body as any;
    if (!sessionId) return { error: 'sessionId required' };
    await cliMesh.complete(sessionId, completedWork);
    return { completed: true };
  });

  // Recent messages across all sessions (for monitor initial load)
  app.get('/api/mesh/messages', async (req) => {
    const cliMesh = await getCliMesh();
    const limit = Math.min(Number((req.query as any)?.limit) || 50, 200);
    return { messages: cliMesh.getRecentMessages(limit) };
  });

  app.post('/api/mesh/disconnect', async (req) => {
    const cliMesh = await getCliMesh();
    const { sessionId } = req.body as any;
    if (!sessionId) return { error: 'sessionId required' };
    await cliMesh.disconnect(sessionId);
    // Broadcast disconnect event to dashboard
    await eventBus.publish({
      type: 'mesh:session_disconnected',
      sessionId,
    } as any);
    return { disconnected: true };
  });

  // Broadcast a message from one CLI session to all active sessions
  app.post('/api/mesh/broadcast', async (req, reply) => {
    const cliMesh = await getCliMesh();
    const parsed = MeshSendBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_mesh_message', issues: parsed.error.issues };
    }
    const { fromSessionId, fromAgent, content, type } = parsed.data;
    const mode = getMeshCommGraphMode();
    if (mode !== 'off') {
      const route = evaluateCommGraph({
        from: fromAgent || 'unknown',
        to: '*',
        type,
      });
      if (!route.allowed) {
        const denial = {
          reason: route.reason,
          from: fromAgent || 'unknown',
          to: '*',
          type,
          mode,
        };
        if (mode === 'shadow') {
          log.warn(denial, 'mesh:route_denied_shadow');
        } else {
          reply.code(403);
          return {
            error: 'mesh_route_denied',
            ...denial,
          };
        }
      }
    }
    const delivered = await cliMesh.sendMessage(
      fromSessionId, fromAgent || 'unknown', '*', content, type,
    );
    // cli-mesh.sendMessage already publishes mesh:message event
    return { delivered };
  });

  // ═══ Mesh Delegations ═════════════════════════════════
  app.post('/api/mesh/delegate', async (req, reply) => {
    const { fromSessionId, fromAgentId, toSessionId, title, description, expiresInMs } = req.body as any;
    if (!fromSessionId || !toSessionId || !title) {
      reply.code(400);
      return { error: 'fromSessionId, toSessionId, and title are required' };
    }
    const delegationId = await delegationManager.delegate(
      fromSessionId, fromAgentId || 'unknown', toSessionId, title, description, expiresInMs,
    );
    return { delegationId, status: 'sent' };
  });

  app.post('/api/mesh/delegations/:id/respond', async (req, reply) => {
    const { id } = req.params as any;
    const { accept, reason } = req.body as any;
    if (accept === undefined) { reply.code(400); return { error: 'accept is required' }; }
    await delegationManager.respond(id, Boolean(accept), reason);
    return { ok: true };
  });

  app.post('/api/mesh/delegations/:id/progress', async (req, reply) => {
    const { id } = req.params as any;
    const { pct, note } = req.body as any;
    if (pct === undefined) { reply.code(400); return { error: 'pct is required' }; }
    await delegationManager.updateProgress(id, Number(pct), note);
    return { ok: true };
  });

  app.post('/api/mesh/delegations/:id/complete', async (req) => {
    const { id } = req.params as any;
    const { result } = req.body as any;
    await delegationManager.complete(id, result);
    return { ok: true };
  });

  app.post('/api/mesh/delegations/:id/cancel', async (req) => {
    const { id } = req.params as any;
    const { reason } = req.body as any;
    await delegationManager.cancel(id, reason);
    return { ok: true };
  });

  app.get('/api/mesh/delegations', async (req) => {
    const query = req.query as any;
    const limit = Math.min(Number(query.limit || 50), 200);
    return { delegations: delegationManager.getAll(limit) };
  });

  app.get('/api/mesh/delegations/session/:sessionId', async (req) => {
    const { sessionId } = req.params as any;
    return {
      incoming: delegationManager.getIncoming(sessionId),
      outgoing: delegationManager.getOutgoing(sessionId),
    };
  });

  // ═══ Monitor Overview ══════════════════════════════════
  app.get('/api/monitor/overview', async () => {
    const cliMesh = await getCliMesh();
    const meshSessions = await cliMesh.getActiveSessions();
    const invocations = invocationTracker.getOverview();
    const allDelegations = delegationManager.getAll(200);
    const pendingDelegations = allDelegations.filter(d => d.acceptanceStatus === 'pending');
    const inProgressDelegations = allDelegations.filter(d => d.workStatus === 'in_progress');

    // Per-agent invocation stats from DB
    const db = getDb();
    const agentStats = db.prepare(`
      SELECT target_agent_id AS agentId,
             COUNT(*) AS total,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END) AS active,
             ROUND(AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END), 0) AS avgDurationMs
      FROM agent_invocations
      GROUP BY target_agent_id
      ORDER BY total DESC
    `).all();

    return {
      meshSessions,
      invocations,
      delegations: { pending: pendingDelegations, inProgress: inProgressDelegations },
      collaborations: { open: collaborationEngine.getOpen(), count: collaborationEngine.getOpen().length },
      agentStats,
    };
  });

  // ═══ Group Intelligence: Collaboration (Phase 3) ════════════════════
  app.post('/api/collab', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const parsed = CreateCollabBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid input', details: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
    }

    const body = parsed.data;
    const creatorId = body.createdBy ?? 'unknown';
    const creatorSessionId = body.createdBy ?? createSessionId();
    const id = await collaborationEngine.create({
      creatorSessionId,
      creatorAgentId: creatorId,
      title: body.title,
      description: body.description,
      type: body.type,
    });

    reply.code(201);
    return { id, status: 'created' };
  });

  app.post('/api/collab/:id/join', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const parsed = JoinCollabBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid input', details: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
    }

    const { id } = req.params as any;
    const { agentId } = parsed.data;
    const result = await collaborationEngine.join(id, agentId, agentId);
    if (!result.joined) {
      reply.code(409);
      return { error: 'Join rejected', reason: result.reason };
    }
    return { id, agentId, joined: true };
  });

  app.post('/api/collab/:id/contribute', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const parsed = ContributeCollabBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid input', details: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
    }

    const { id } = req.params as any;
    const { agentId, content } = parsed.data;
    const result = await collaborationEngine.contribute({
      collaborationId: id,
      sessionId: agentId,
      agentId,
      content,
    });
    if (result.contributionId === null) {
      reply.code(409);
      return { error: 'Contribution rejected', reason: result.reason };
    }
    return { contributionId: result.contributionId };
  });

  app.post('/api/collab/:id/vote', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const parsed = VoteCollabBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid input', details: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
    }

    const { id } = req.params as any;
    const { agentId, choice, vote = 1 } = parsed.data;
    const collab = collaborationEngine.get(id);
    if (collab?.status === 'open') {
      await collaborationEngine.startVoting(id);
    }
    await collaborationEngine.vote(choice, agentId, vote);
    return { id, choice, agentId, vote, ok: true };
  });

  app.post('/api/collab/:id/close', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const { id } = req.params as any;
    const collab = await collaborationEngine.close(id);
    return { id, status: 'closed', result: collab.result };
  });

  app.get('/api/collab', async (req) => {
    const limit = Number((req.query as any).limit) || 50;
    return { collaborations: collaborationEngine.getAll(limit) };
  });

  app.get('/api/collab/open', async () => {
    return { collaborations: collaborationEngine.getOpen() };
  });

  app.get('/api/collab/:id', async (req) => {
    const { id } = req.params as any;
    const collab = collaborationEngine.get(id);
    if (!collab) return { error: 'not found' };
    return { collab, contributions: collaborationEngine.getContributions(id) };
  });

  app.get('/api/collaborations', async (req, reply) => {
    const parsed = ListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid query', details: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
    }

    const limit = parsed.data.limit;
    const collaborations = collaborationEngine.getAll(limit);
    if (collaborations.length === 0) {
      return { collaborations: [] };
    }

    const db = getDb();
    const placeholders = collaborations.map(() => '?').join(', ');
    const countRows = db.prepare(`
      SELECT
        c.id AS collaboration_id,
        COUNT(DISTINCT ct.id) AS contribution_count,
        COUNT(DISTINCT cv.id) AS vote_count
      FROM collaborations c
      LEFT JOIN collab_contributions ct ON ct.collaboration_id = c.id
      LEFT JOIN collab_votes cv ON cv.collaboration_id = c.id
      WHERE c.id IN (${placeholders})
      GROUP BY c.id
    `).all(...collaborations.map(collab => collab.id)) as Array<{
      collaboration_id: string;
      contribution_count: number;
      vote_count: number;
    }>;

    const counts = new Map(countRows.map(row => [
      row.collaboration_id,
      { contributionCount: row.contribution_count, voteCount: row.vote_count },
    ]));

    return {
      collaborations: collaborations.map(collab => ({
        ...collab,
        participantCount: collab.participantSessionIds.length,
        contributionCount: counts.get(collab.id)?.contributionCount ?? 0,
        voteCount: counts.get(collab.id)?.voteCount ?? 0,
      })),
    };
  });

  app.get('/api/locks', async () => {
    return {
      locks: await listActiveLocks(),
      redisConnected: isRedisConnected(),
    };
  });

  // ═══ Mesh Flow Timeline (monitoring) ════════════════════════════════
  app.get('/api/mesh/flow', async (req) => {
    const limit = Math.min(Number((req.query as any).limit) || 40, 100);
    const db = getDb();

    // 1. Raw mesh messages (session↔session 직접 메시지)
    let meshMessages: any[] = [];
    try {
      // 프로토콜 내부 메시지(DELEGATION_*/COLLAB_*/INVOCATION_* prefix)는 제외
      // — 이미 typed 이벤트로 별도 표시되므로 중복 방지
      meshMessages = db.prepare(`
        SELECT
          created_at as ts,
          'mesh_msg'  as event_type,
          from_session,
          from_agent,
          to_session,
          NULL        as to_agent,
          type        as msg_type,
          content,
          id
        FROM mesh_messages
        WHERE content NOT LIKE 'DELEGATION_%'
          AND content NOT LIKE 'COLLAB_%'
          AND content NOT LIKE 'INVOCATION_%'
        ORDER BY created_at DESC LIMIT ?
      `).all(limit);
    } catch { /* mesh_messages may not exist yet */ }

    // 2. Delegation events (각 상태 변경을 이벤트로)
    let delegationEvents: any[] = [];
    try {
      // created → DELEGATION_REQUEST  /  accepted/rejected → DELEGATION_RESPONSE  /  completed → DELEGATION_COMPLETE
      const delegRows = db.prepare(`
        SELECT
          created_at, accepted_at, completed_at,
          id, from_session_id, from_agent_id, to_session_id, to_agent_id,
          title, acceptance_status, work_status, progress_pct, result
        FROM delegations
        ORDER BY created_at DESC LIMIT ?
      `).all(limit) as any[];

      for (const d of delegRows) {
        delegationEvents.push({
          ts: d.created_at,
          event_type: 'delegation_request',
          from_session: d.from_session_id,
          from_agent: d.from_agent_id,
          to_session: d.to_session_id,
          to_agent: d.to_agent_id,
          msg_type: 'DELEGATION_REQUEST',
          content: d.title,
          id: d.id + '_req',
        });
        if (d.accepted_at) {
          delegationEvents.push({
            ts: d.accepted_at,
            event_type: 'delegation_response',
            from_session: d.to_session_id,
            from_agent: d.to_agent_id,
            to_session: d.from_session_id,
            to_agent: d.from_agent_id,
            msg_type: d.acceptance_status === 'accepted' ? 'DELEGATION_ACCEPTED' : 'DELEGATION_REJECTED',
            content: d.title,
            id: d.id + '_resp',
          });
        }
        if (d.completed_at) {
          delegationEvents.push({
            ts: d.completed_at,
            event_type: 'delegation_complete',
            from_session: d.to_session_id,
            from_agent: d.to_agent_id,
            to_session: d.from_session_id,
            to_agent: d.from_agent_id,
            msg_type: 'DELEGATION_COMPLETE',
            content: d.result || d.title,
            id: d.id + '_done',
          });
        }
      }
    } catch { /* delegations may not exist yet */ }

    // 3. Invocation events
    let invocationEvents: any[] = [];
    try {
      const invRows = db.prepare(`
        SELECT
          created_at, completed_at,
          id, caller_session_id, caller_agent_id, target_agent_id,
          status, prompt
        FROM agent_invocations
        ORDER BY created_at DESC LIMIT ?
      `).all(limit) as any[];

      for (const inv of invRows) {
        invocationEvents.push({
          ts: inv.created_at,
          event_type: 'invocation_start',
          from_session: inv.caller_session_id || 'system',
          from_agent: inv.caller_agent_id || 'system',
          to_session: inv.target_agent_id,
          to_agent: inv.target_agent_id,
          msg_type: 'INVOCATION_START',
          content: (inv.prompt || '').substring(0, 120),
          id: inv.id + '_start',
        });
        if (inv.completed_at) {
          invocationEvents.push({
            ts: inv.completed_at,
            event_type: 'invocation_complete',
            from_session: inv.target_agent_id,
            from_agent: inv.target_agent_id,
            to_session: inv.caller_session_id || 'system',
            to_agent: inv.caller_agent_id || 'system',
            msg_type: inv.status === 'completed' ? 'INVOCATION_COMPLETE' : 'INVOCATION_FAILED',
            content: inv.status,
            id: inv.id + '_done',
          });
        }
      }
    } catch { /* agent_invocations may not exist yet */ }

    // 4. Collaboration events
    let collabEvents: any[] = [];
    try {
      const collabRows = db.prepare(`
        SELECT
          c.created_at, c.closed_at,
          c.id, c.creator_session_id, c.creator_agent_id,
          c.title, c.type, c.status, c.result,
          ct.created_at as contrib_ts,
          ct.session_id as contrib_session,
          ct.agent_id   as contrib_agent,
          ct.content    as contrib_content,
          ct.score      as contrib_score,
          ct.id         as contrib_id
        FROM collaborations c
        LEFT JOIN collab_contributions ct ON ct.collaboration_id = c.id
        ORDER BY c.created_at DESC LIMIT ?
      `).all(limit) as any[];

      const seenCollabs = new Set<string>();
      for (const row of collabRows) {
        if (!seenCollabs.has(row.id)) {
          seenCollabs.add(row.id);
          collabEvents.push({
            ts: row.created_at,
            event_type: 'collab_created',
            from_session: row.creator_session_id,
            from_agent: row.creator_agent_id,
            to_session: '*',
            to_agent: null,
            msg_type: 'COLLAB_CREATE',
            content: `[${row.type}] ${row.title}`,
            id: row.id + '_create',
          });
          if (row.closed_at) {
            collabEvents.push({
              ts: row.closed_at,
              event_type: 'collab_closed',
              from_session: row.creator_session_id,
              from_agent: row.creator_agent_id,
              to_session: '*',
              to_agent: null,
              msg_type: 'COLLAB_CLOSED',
              content: row.result || row.title,
              id: row.id + '_close',
            });
          }
        }
        if (row.contrib_id) {
          collabEvents.push({
            ts: row.contrib_ts,
            event_type: 'collab_contribution',
            from_session: row.contrib_session,
            from_agent: row.contrib_agent,
            to_session: row.id,
            to_agent: null,
            msg_type: 'COLLAB_CONTRIBUTION',
            content: (row.contrib_content || '').substring(0, 80),
            id: row.contrib_id,
          });
        }
      }
    } catch { /* collaborations may not exist yet */ }

    // sessionMap: sessionId → agentId
    // 1) 활성 세션 (in-memory)
    // 2) mesh_messages 이력에서 from_session→from_agent 역추적 (오래된 세션 포함)
    let sessionMap: Record<string, string> = {};
    try {
      const cliMesh = await getCliMesh();
      const sessions = await cliMesh.getActiveSessions();
      for (const s of sessions) {
        if (s.sessionId && s.agentId) sessionMap[s.sessionId] = s.agentId;
      }
    } catch { /* non-fatal */ }
    try {
      // mesh_messages에서 (from_session, from_agent) 쌍으로 보완
      const histRows = db.prepare(`
        SELECT DISTINCT from_session, from_agent
        FROM mesh_messages
        WHERE from_agent IS NOT NULL AND from_agent != ''
          AND from_session IS NOT NULL AND from_session != ''
        LIMIT 200
      `).all() as any[];
      for (const r of histRows) {
        if (!sessionMap[r.from_session]) {
          sessionMap[r.from_session] = r.from_agent;
        }
      }
    } catch { /* non-fatal */ }

    // Merge all events, sort by ts DESC, take top limit
    const all = [...meshMessages, ...delegationEvents, ...invocationEvents, ...collabEvents];
    all.sort((a, b) => {
      const ta = a.ts ? new Date(a.ts).getTime() : 0;
      const tb = b.ts ? new Date(b.ts).getTime() : 0;
      return tb - ta;
    });

    return {
      events: all.slice(0, limit),
      sessionMap,
      counts: {
        meshMessages: meshMessages.length,
        delegationEvents: delegationEvents.length,
        invocationEvents: invocationEvents.length,
        collabEvents: collabEvents.length,
      },
    };
  });

  // ═══ Hive Mode (9 AI → 1 Super AI) ══════════════════
  app.post('/api/hive', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const { prompt, providers } = req.body as any;
    if (!prompt) { reply.code(400); return { error: 'prompt is required' }; }
    const gated = resolveRealtimeProviders('hive', providers);
    if (!gated.ok) {
      reply.code(409);
      return gated.body;
    }
    const allProviders = gated.providers;
    reply.code(202);

    const sessionId = createSessionId();
    const db = getDb();

    discussionEngine.startDiscussion({
      topic: prompt,
      mode: 'hive',
      providers: allProviders,
      sessionId,
    })
      .then(report => {
        const taskId = createTaskId();
        db.prepare(`
          INSERT OR IGNORE INTO tasks (id, mode, prompt, assigned_to, status, response, completed_at, updated_at)
          VALUES (?, 'hive', ?, 'discussion-engine', 'completed', ?, datetime('now'), datetime('now'))
        `).run(taskId, prompt, report.adoptedProposal);
      })
      .catch(err => log.error({ err: err.message, sessionId }, 'Hive failed'));

    return { sessionId, status: 'started', mode: 'hive', providers: allProviders };
  });

  // ═══ Broadcast (All Agents) ════════════════════════
  app.post('/api/broadcast', async (req, reply) => {
    const { message, providers } = req.body as any;
    if (!message) { reply.code(400); return { error: 'message is required' }; }
    const allProviders = providers || agentManager.listEnabledIds();
    reply.code(202);
    discussionEngine.executeBroadcast(message, allProviders)
      .catch(err => log.error({ err: err.message }, 'Broadcast failed'));
    return { status: 'started', mode: 'broadcast', providers: allProviders };
  });

  // ═══ Commander 4-Layer ═════════════════════════════
  app.post('/api/commander', async (req) => {
    const commander = await getCommander();
    const { prompt } = req.body as any;
    if (!prompt) return { error: 'prompt is required' };
    const result = await commander.executeCommand(prompt);
    return result;
  });

  app.get('/api/commander/layers', async () => {
    const commander = await getCommander();
    return { layers: commander.getLayers() };
  });

  // ═══ Observability + Learn ════════════════════════
  app.get('/api/observability/leaderboard', async () => {
    const { observability } = await import('../core/observability.js');
    return { leaderboard: observability.getLeaderboard() };
  });

  app.get('/api/observability/agent/:id', async (req) => {
    const { observability } = await import('../core/observability.js');
    const { id } = req.params as any;
    return observability.getAgentHistory(id);
  });

  app.get('/api/observability/metrics', async () => {
    const { observability } = await import('../core/observability.js');
    return observability.getMetrics();
  });

  app.post('/api/learn/save', async (req) => {
    const { knowledgeBase } = await import('../core/knowledge-base.js');
    const body = req.body as any;
    if (!body.projectPath || !body.category || !body.content) {
      return { error: 'projectPath, category, and content are required' };
    }
    const id = knowledgeBase.save(body);
    return { id };
  });

  app.get('/api/learn/query', async (req) => {
    const { knowledgeBase } = await import('../core/knowledge-base.js');
    const { keywords, project } = req.query as any;
    if (!keywords) return { error: 'keywords parameter required' };
    return { results: knowledgeBase.query(keywords, project) };
  });

  // /api/learn/search is registered in dashboard-compat.ts (inside catch-all handler)

  app.get('/api/learn/context', async (req) => {
    const { knowledgeBase } = await import('../core/knowledge-base.js');
    const { project } = req.query as any;
    if (!project) return { error: 'project parameter required' };
    return { context: knowledgeBase.getContext(project) };
  });

  // ═══ Plan + Kanban ════════════════════════════════
  app.post('/api/plan/create', async (req) => {
    const { planManager } = await import('../core/plan-manager.js');
    const { title, tasks, sourceDiscussionId } = req.body as any;
    if (!title) return { error: 'title is required' };
    const plan = await planManager.createPlan(title, tasks, sourceDiscussionId);
    return plan;
  });

  app.get('/api/plan/:id', async (req) => {
    const { planManager } = await import('../core/plan-manager.js');
    const { id } = req.params as any;
    const plan = planManager.getPlan(id);
    if (!plan) return { error: 'Plan not found' };
    return plan;
  });

  app.post('/api/plan/:id/sync', async (req) => {
    const { planManager } = await import('../core/plan-manager.js');
    const { id } = req.params as any;
    const synced = await planManager.syncFromMarkdown(id);
    await planManager.syncToMarkdown(id);
    return { synced };
  });

  app.get('/api/kanban', async (req) => {
    const { kanbanEngine } = await import('../core/kanban-engine.js');
    const { planId } = req.query as any;
    return kanbanEngine.getBoard(planId);
  });

  app.post('/api/kanban/move', async (req) => {
    const { kanbanEngine } = await import('../core/kanban-engine.js');
    const { taskId, to } = req.body as any;
    if (!taskId || !to) return { error: 'taskId and to are required' };
    const moved = kanbanEngine.moveTask(taskId, to);
    return { moved };
  });

  app.post('/api/plan/execute', async (req) => {
    const { kanbanEngine } = await import('../core/kanban-engine.js');
    const { planId, strategy } = req.body as any;
    if (!planId) return { error: 'planId is required' };
    const result = await kanbanEngine.executePlan(planId, strategy || 'auto');
    return result;
  });

  // ═══ Conductor (Smart Router Auto-Dispatch) ════════
  app.post('/api/conductor', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const smartRouter = await getSmartRouter();
    const { prompt } = req.body as any;
    if (!prompt) return { error: 'prompt is required' };

    let decision;
    try {
      decision = await smartRouter.dispatch(prompt);
    } catch (err) {
      if (err instanceof ProviderSelectionError) {
        reply.code(409);
        return {
          error: 'insufficient_available_providers',
          mode: err.mode,
          requestedProviders: err.availableProviders,
          eligibleProviders: err.eligibleProviders,
          gatedProviders: agentManager.listEnabledIds()
            .filter(id => !err.availableProviders.includes(id))
            .map(id => ({ id, gate: circuitBreakerRegistry.getAvailability(id).status }))
            .filter(entry => entry.gate !== 'available'),
          requiredMinimum: err.requiredMinimum,
        };
      }
      throw err;
    }

    // Delegate to the appropriate mode endpoint handler
    const db = getDb();
    const taskId = (await import('../utils/id.js')).createTaskId();

    // Record task
    try {
      db.prepare(`
        INSERT INTO tasks (id, mode, prompt, assigned_to, status, priority)
        VALUES (?, ?, ?, ?, 'assigned', 5)
      `).run(taskId, decision.mode, prompt, decision.providers[0] || null);
    } catch (dbErr) {
      log.error({ err: (dbErr as Error).message, taskId }, 'Failed to insert conductor task');
      return { error: 'Failed to create task' };
    }

    // Execute via discussion engine for multi-agent modes, or taskQueue for single
    const sessionId = createSessionId();
    if (decision.mode === 'task' && decision.providers.length === 1) {
      taskQueue.enqueue({ taskId, agentId: decision.providers[0], prompt })
        .then(result => {
          try {
            const cResp = result.output || result.error;
            let cStatus = result.success && !detectFailedCompletion(cResp) ? 'completed' : 'failed';
            let cError: string | null = null;
            // P1-6 evidence-gate opt-in 하드차단: requiredEvidence 선언 태스크는 증거 충족 시에만 완료.
            if (cStatus === 'completed') {
              try {
                const metaRow = db.prepare('SELECT metadata_json FROM tasks WHERE id=?').get(taskId) as { metadata_json: string | null } | undefined;
                const requiredKinds = metaRow?.metadata_json ? (JSON.parse(metaRow.metadata_json)?.requiredEvidence ?? []) : [];
                if (Array.isArray(requiredKinds) && requiredKinds.length > 0) {
                  const gate = requireEvidence(result.evidenceJson ?? {}, requiredKinds);
                  if (!gate.allowed) {
                    cStatus = 'failed';
                    cError = `evidence_gate_blocked: missing ${gate.missing.join(', ')}`;
                  }
                }
              } catch (gateErr) { log.warn({ err: (gateErr as Error).message, taskId }, 'evidence gate check failed (non-fatal)'); }
            }
            db.prepare(`
              UPDATE tasks
              SET status=?,
                  response=?,
                  error=COALESCE(?, error),
                  completed_at=datetime('now'),
                  updated_at=datetime('now'),
                  evidence_json=COALESCE(?, evidence_json)
              WHERE id=?
            `).run(cStatus, cResp, cError, cStatus === 'completed' ? (result.evidenceJson ?? null) : null, taskId);
            if (cStatus === 'completed') {
              void handleCompletedTaskQualityGate(taskId, cResp ?? '')
                .catch(err => log.warn({ err: err instanceof Error ? err.message : String(err), taskId }, 'Completed conductor task quality gate failed'));
            }
          } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update failed'); }
        })
        .catch(err => {
          try {
            db.prepare(`UPDATE tasks SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`)
              .run(err.message, taskId);
          } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update failed'); }
        });
    } else {
      const { discussionEngine: de } = await import('../core/discussion-engine.js');
      de.startDiscussion({
        topic: prompt,
        mode: decision.mode as any,
        providers: decision.providers,
        maxRounds: decision.mode === 'consensus' ? 5 : 3,
        sessionId,
      })
        .then(report => {
          try {
            db.prepare(`UPDATE tasks SET status='completed', response=?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
              .run(report.adoptedProposal, taskId);
          } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update failed'); }
        })
        .catch(err => {
          try {
            db.prepare(`UPDATE tasks SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`)
              .run(err.message, taskId);
          } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update failed'); }
        });
    }

    return {
      taskId,
      mode: decision.mode,
      providers: decision.providers,
      complexity: decision.complexity,
      reasoning: decision.reasoning,
      status: 'dispatched',
    };
  });

  // ═══ Agent Sessions ════════════════════════════════
  app.post('/api/agent/start', async (req) => {
    const sessionManager = await getSessionManager();
    const { prompt, provider, systemPrompt, autoApprove } = req.body as any;
    if (!prompt) return { error: 'prompt is required' };
    const agentId = provider || 'codex';
    const sessionId = await sessionManager.startSession(prompt, agentId, { systemPrompt, autoApprove });
    return { sessionId, status: 'running', agentId };
  });

  app.get('/api/agent/sessions', async () => {
    const sessionManager = await getSessionManager();
    const active = sessionManager.listSessions();
    const history = sessionManager.getSessionsFromDb(20);
    return { sessions: [...active, ...history.filter(h => !active.find(a => a.id === h.id))] };
  });

  app.get('/api/agent/:sessionId/status', async (req) => {
    const sessionManager = await getSessionManager();
    const { sessionId } = req.params as any;
    const session = sessionManager.getSession(sessionId);
    if (!session) return { error: 'Session not found' };
    return {
      id: session.id, agentId: session.agentId, status: session.status,
      iterations: session.iterations, toolCalls: session.toolCalls,
      createdAt: session.createdAt, completedAt: session.completedAt,
      error: session.error,
    };
  });

  app.post('/api/agent/:sessionId/abort', async (req) => {
    const sessionManager = await getSessionManager();
    const { sessionId } = req.params as any;
    const aborted = await sessionManager.abortSession(sessionId);
    return { aborted };
  });

  app.post('/api/agent/:sessionId/approve', async (req) => {
    const sessionManager = await getSessionManager();
    const { sessionId } = req.params as any;
    const approved = sessionManager.approveAction(sessionId);
    return { approved };
  });

  app.post('/api/agent/:sessionId/reject', async (req) => {
    const sessionManager = await getSessionManager();
    const { sessionId } = req.params as any;
    const { reason } = req.body as any;
    const rejected = sessionManager.rejectAction(sessionId, reason);
    return { rejected };
  });

  // ═══ Safety — FileChangeGuard + VerificationGate ═══
  app.get('/api/safety/backups', async (req) => {
    const { fileChangeGuard } = await import('../security/file-change-guard.js');
    const query = req.query as any;
    const limit = Math.min(Number(query.limit || 20), 100);
    return { backups: fileChangeGuard.listBackups(limit) };
  });

  app.get('/api/safety/verifications/:taskId', async (req) => {
    const { verificationGate } = await import('../security/verification-gate.js');
    const { taskId } = req.params as any;
    return { results: verificationGate.getResults(taskId) };
  });

  // ═══ Invocations ══════════════════════════════════
  app.get('/api/invocations', async (req) => {
    const query = req.query as any;
    const limit = Math.min(Number(query.limit || 20), 200);
    const offset = Number(query.offset || 0);
    return { invocations: invocationTracker.listInvocations(limit, offset) };
  });

  app.get('/api/invocations/:id', async (req, reply) => {
    const { id } = req.params as any;
    const db = getDb();
    const invocation = db.prepare(`
      SELECT * FROM agent_invocations
      WHERE id = ?
    `).get(id);

    if (!invocation) {
      reply.code(404);
      return { error: 'Invocation not found' };
    }

    return { invocation };
  });

  app.get('/api/invocations/overview', async () => {
    return invocationTracker.getOverview();
  });

  app.get('/api/invocations/session/:sessionId', async (req) => {
    const { sessionId } = req.params as any;
    return { invocations: invocationTracker.getActiveInvocations(sessionId) };
  });

  app.get('/api/invocations/agent/:agentId', async (req) => {
    const { agentId } = req.params as any;
    const query = req.query as any;
    const limit = Math.min(Number(query.limit || 20), 200);
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM agent_invocations
      WHERE target_agent_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(agentId, limit);
    return { invocations: rows };
  });

  // mem0 라우트는 아래 "NCO 메가태스크 이식" 블록에 inline 구현되어 있다 (중복 등록 금지)

  // ═══ Inter-Session Routes (list/status/send/broadcast) ═══
  // dashboard-compat의 catch-all 스텁보다 먼저 등록해야 실제 핸들러가 응답한다
  await registerInterSessionRoutes(app);

  // ═══ Fleet Ops (push 텔레메트리 + edit-lease) ═══════════
  await registerFleetOpsRoutes(app);
  await registerHandoffRoutes(app);
  await registerTeamsRoutes(app);
  await registerWorkReportRoutes(app);
  await registerMathRoutes(app);
  // audit.ts는 구현만 있고 미마운트였음(emergency-stop이 compat 스텁으로 응답 — claude-1 T1 제보 2026-07-08)
  await registerAuditRoutes(app);

  // ═══ Dashboard Compatibility Routes ═══════════════
  await registerDashboardRoutes(app);

  // ── NCO 메가태스크 이식 2026-06-30: mem0/hallucination/reflexion/github ──
  // GitHub Agent — 레포 검색 및 이식 가능성 평가
  // POST /api/github/search  — 단일 목표 검색
  // POST /api/github/agent   — 전체 목표 병렬 검색 (hallucination/memory/self-improvement/collaboration)
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/api/github/search', async (req, reply) => {
    const { goal, limit } = req.body as { goal?: string; limit?: number };
    if (!goal) { reply.code(400); return { error: 'goal required (hallucination | memory | self-improvement | collaboration)' }; }
    try {
      const { searchGitHub } = await import('../core/github-agent.js');
      const repos = await searchGitHub(goal, limit ?? 5);
      return { goal, repos, count: repos.length, searchedAt: new Date().toISOString() };
    } catch (err: any) {
      reply.code(500);
      return { error: err?.message ?? 'GitHub search failed' };
    }
  });

  app.post('/api/github/agent', async (req, reply) => {
    const { goals, limitPerGoal } = (req.body ?? {}) as { goals?: string[]; limitPerGoal?: number };
    try {
      const { runGitHubAgent } = await import('../core/github-agent.js');
      const results = await runGitHubAgent({
        goals: goals as any,
        limitPerGoal: limitPerGoal ?? 5,
      });
      const totalRepos = results.reduce((s, r) => s + r.repos.length, 0);
      const topRepos = results.flatMap(r => r.repos).sort((a, b) => b.transplantScore - a.transplantScore).slice(0, 10);
      return { results, totalRepos, topRepos, ranAt: new Date().toISOString() };
    } catch (err: any) {
      reply.code(500);
      return { error: err?.message ?? 'GitHub agent failed' };
    }
  });

  log.info('GitHub Agent routes registered — /api/github/{search,agent}');

  // ─────────────────────────────────────────────────────────────────────────
  // mem0 — 에이전트별 장기 기억 CRUD
  // POST /api/mem0/:agentId/add        — 기억 저장
  // POST /api/mem0/:agentId/search     — 기억 검색 (시맨틱 / BM25)
  // GET  /api/mem0/:agentId            — 기억 목록
  // DELETE /api/mem0/:agentId/:memId   — 기억 삭제
  // DELETE /api/mem0/:agentId          — 에이전트 기억 전체 초기화
  // GET  /api/mem0/stats               — 전체 통계
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/api/mem0/:agentId/add', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const { content, userId, metadata } = req.body as { content: string; userId?: string; metadata?: Record<string, unknown> };
    if (!content) { reply.code(400); return { error: 'content required' }; }
    try {
      const { mem0Add } = await import('../core/mem0-bridge.js');
      return await mem0Add({ agentId, content, userId, metadata });
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  app.post('/api/mem0/:agentId/search', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const { query, limit, userId } = req.body as { query: string; limit?: number; userId?: string };
    if (!query) { reply.code(400); return { error: 'query required' }; }
    try {
      const { mem0Search } = await import('../core/mem0-bridge.js');
      return await mem0Search({ agentId, query, limit, userId });
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  app.get('/api/mem0/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const { limit, userId } = req.query as { limit?: string; userId?: string };
    try {
      const { mem0List } = await import('../core/mem0-bridge.js');
      const memories = mem0List({ agentId, limit: limit ? parseInt(limit) : 20, userId });
      return { agentId, memories, count: memories.length };
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  app.delete('/api/mem0/:agentId/:memId', async (req, reply) => {
    const { agentId, memId } = req.params as { agentId: string; memId: string };
    try {
      const { mem0Delete } = await import('../core/mem0-bridge.js');
      const deleted = mem0Delete(memId, agentId);
      if (!deleted) { reply.code(404); return { error: 'memory not found' }; }
      return { deleted: true, id: memId };
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  app.delete('/api/mem0/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    try {
      const { mem0Clear } = await import('../core/mem0-bridge.js');
      const cleared = mem0Clear(agentId);
      return { cleared, agentId };
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  app.get('/api/mem0/stats', async (_req, reply) => {
    try {
      const { mem0Stats } = await import('../core/mem0-bridge.js');
      return mem0Stats();
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  log.info('mem0 Bridge routes registered — /api/mem0/{agentId}/add|search, GET|DELETE /api/mem0/:agentId');

  // ─────────────────────────────────────────────────────────────────────────
  // Hallucination Guard — bastion-anchor 이식 (2026-06-30)
  // POST /api/hallucination/check  — 응답 환각 검증 (컨텍스트 기반 + 자가 검증)
  // POST /api/hallucination/quick  — 빠른 점수만 (동기, 실시간용)
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/api/hallucination/check', async (req, reply) => {
    const { response, context, prompt, runSelfReview } = req.body as {
      response: string; context?: string; prompt?: string; runSelfReview?: boolean;
    };
    if (!response) { reply.code(400); return { error: 'response required' }; }
    try {
      const { checkHallucination } = await import('../core/hallucination-guard.js');
      const report = await checkHallucination(response, { context, prompt, runSelfReview: runSelfReview ?? false });
      return report;
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  app.post('/api/hallucination/quick', async (req, reply) => {
    const { response, context } = req.body as { response: string; context?: string };
    if (!response) { reply.code(400); return { error: 'response required' }; }
    try {
      const { quickHallucinationScore } = await import('../core/hallucination-guard.js');
      const score = quickHallucinationScore(response, context);
      return { score, recommendation: score >= 0.7 ? 'accept' : score >= 0.4 ? 'review' : 'reject' };
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  log.info('Hallucination Guard routes registered — /api/hallucination/{check,quick}');

  // ─────────────────────────────────────────────────────────────────────────
  // Reflexion — 자가 개선 평가 API (opt-in, 에이전트 루프 비수정)
  // POST /api/reflexion/evaluate   — 기존 응답 자가 평가만 (critique+mem0 저장)
  // ─────────────────────────────────────────────────────────────────────────
  app.post('/api/reflexion/evaluate', async (req, reply) => {
    const { agentId, prompt, response, saveMemory, userId } = req.body as {
      agentId: string; prompt: string; response: string; saveMemory?: boolean; userId?: string;
    };
    if (!agentId || !prompt || !response) {
      reply.code(400);
      return { error: 'agentId, prompt, response required' };
    }
    try {
      const { evaluateWithReflexion } = await import('../core/reflexion.js');
      return await evaluateWithReflexion(agentId, prompt, response, { saveMemory, userId });
    } catch (err: any) { reply.code(500); return { error: err?.message }; }
  });

  log.info('Reflexion routes registered — /api/reflexion/evaluate');

  return app;
}
