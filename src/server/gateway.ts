import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod/v4';
import { env, loadEnabledProviders } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { getRedis, isRedisConnected, redisHealthCheck } from '../storage/redis.js';
import { getDb } from '../storage/database.js';
import { agentManager } from '../agent/agent-manager.js';
import { validateDelegationPayload } from '../utils/delegation-payload.js';
import {
  applyPromptGate,
  buildDefaultVerifier,
  findActiveWorkReportTask,
  getWorkReportId,
  shouldApplyPromptGateForProvider,
  type PromptGateInfo,
  validateProjectDirMetadata,
} from './task-intake.js';
import { hasResponseContract } from '../core/response-contract.js';
import {
  isProtocolReconversionGateEnabled,
  isProtocolReconversionPrompt,
} from '../core/collaboration.js';
import { parseBlockedStageOutcome } from '../core/stage-outcome.js';
import { fleetGateway, hiveRelay, getPaInbox, paLifecycle } from '../core/ported-integrations.js';
import type { LifecycleMode } from '../core/pa-lifecycle.js';
import { decompose, getLeaves, countNodes } from '../core/recursive-decomposer.js';
import { requireEvidence } from '../security/evidence-gate.js';
import { compressPlan, MAX_PLAN_CHARS } from '../core/context-budget.js';
import { logDecision } from '../core/decision-log.js';
import {
  invalidateLearnedCircuitPattern,
  recordLearningEvent,
} from '../core/failure-learning.js';
import { computeTrustScores } from '../core/trust-scorer.js';
import { discussionEngine } from '../core/discussion-engine.js';
import { sharedState, type AgentState } from '../core/shared-state.js';
import { eventBus, type NCOEvent } from '../core/event-bus.js';
import { discoverAcquisitions } from '../core/acquisition-discovery.js';
import { installAcquiredPackage } from '../core/acquisition-installer.js';
import { acquisitionRegistry, type AcquisitionRecord } from '../core/acquisition-registry.js';
import { dynamicSkillEngine } from '../core/dynamic-skill-engine.js';
import { createTaskId, createSessionId } from '../utils/id.js';
import { CreateTaskInput, CreateDiscussionInput } from '../utils/validation.js';
import { parseIntent } from '../utils/intent-parser.js';
import { resolveInternalProjectDir } from '../utils/project-dir.js';
import { taskQueue } from '../core/task-queue.js';
import { providerRuntimeCoordinator } from '../core/provider-runtime-coordinator.js';
import {
  evaluateProviderReadiness,
  type ProviderReadinessResult,
} from '../core/provider-readiness.js';
import {
  toLegacyProviderCatalogProjection,
  type ProviderRegistrySnapshot,
} from '../core/provider-registry-snapshot.js';
import {
  ProviderResolutionError,
  resolveExecutionProvider,
} from '../core/provider-registry.js';
import { TERMINAL_STATES, transitionTask } from '../core/task-state.js';
import { checkResponseQuality } from '../verification/response-quality.js';
import { vetAcquisitionCandidate } from '../security/acquisition-vetting.js';
import {
  attachWorkflowTask,
  createWorkflowRun,
  enforceWorkflowPrerequisites,
  evaluateWorkflowPolicy,
  failStaleDiscussions,
  markWorkflowStage,
  reconcileTerminalWorkflowTasks,
  syncWorkflowTask,
  type WorkflowPolicyDecision,
  type WorkflowStage,
} from '../core/workflow-gate.js';
import { circuitBreakerRegistry } from '../security/circuit-breaker-registry.js';
import { summarizeProviderAvailability } from './provider-health.js';
import { stripEchoLines } from '../utils/echo-filter.js';
import { recordTeamDiagnosticOutcome } from '../core/team-scorer.js';
import { refreshWorkReportPromptSnapshot } from '../core/work-report-scheduler.js';
import { registerTriadRoutes } from './routes/triad.js';
import { markTaskQualityRejected } from './task-quality-state.js';
import { readRetryCount, reserveRetry, rollbackRetryReservation } from './retry-budget.js';
import { buildConductorDiscussionOptions } from './conductor-dispatch.js';
import {
  projectDiscussionTaskProgress,
  projectSingleTaskProgress,
  type DiscussionProgressRow,
} from '../core/discussion-progress.js';

type TaskFailureContext = {
  mode?: string | null;
  prompt?: string | null;
  team_id?: string | null;
};

type TaskIdempotencyReservation = {
  task_id: string;
  request_fingerprint: string;
  assigned_to: string | null;
  status: string;
};

const canonicalizeForHash = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeForHash(entry)]),
  );
};

const createTaskRequestFingerprint = (input: z.infer<typeof CreateTaskInput>): string => {
  const metadata = { ...(input.metadata ?? {}) };
  delete metadata.idempotencyKey;
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalizeForHash({ ...input, metadata })))
    .digest('hex')}`;
};

export type NcoGateway = FastifyInstance & {
  /**
   * Run the same durable workflow, response-quality, and organization-audit
   * side effects for a task terminalized outside the HTTP intake promise.
   * Startup orphan recovery is the primary caller.
   */
  settlePersistedTaskTerminal(taskId: string): Promise<void>;
};

type FailedCompletionOptions = {
  reportMode?: boolean;
  prompt?: string | null;
};

type FailurePattern = {
  reason: string;
  pattern: RegExp;
};

const HARD_FAILURE_PATTERNS: readonly FailurePattern[] = [
  { reason: 'failure-pattern: action required', pattern: /\bActionRequiredError\b/i },
  { reason: 'failure-pattern: provider model not found', pattern: /\bProviderModelNotFoundError\b/i },
  { reason: 'failure-pattern: connection refused', pattern: /\b(?:connection\s*refused|ECONNREFUSED)\b/i },
  { reason: 'failure-pattern: request timed out', pattern: /\brequest\s+timed\s+out\b/i },
  // 오케스트레이터가 붙이는 선두 래퍼("[codex: no final response — process failed]")만.
  // 리뷰가 이 문자열을 인용하는 경우(본문 중간)는 제외하려고 ^ 앵커 사용.
  {
    reason: 'failure-pattern: no final response',
    pattern: /^\[[\w-]+:[^\]]*\bno final response\b/i,
  },
  { reason: 'failure-pattern: failed status', pattern: /^status:\s*failed\b/im },
];

const REPORTED_ERROR_CAUSE_PATTERNS: readonly FailurePattern[] = [
  {
    reason: 'failure-pattern: connection failure',
    pattern: /\b(?:connection\s*refused|ECONNREFUSED|failed\s+to\s+connect|couldn['’]t\s+connect\s+to\s+(?:the\s+)?server)\b/i,
  },
  {
    reason: 'failure-pattern: missing required input',
    pattern: /\brequired fields?\b.{0,120}\b(?:unknown|missing)\b/i,
  },
];

const SOFT_FAILURE_PATTERNS: readonly FailurePattern[] = [
  { reason: 'failure-pattern: operation failed', pattern: /\bfailed\s+(?:to|with)\b/i },
  {
    reason: 'failure-pattern: error occurred',
    pattern: /\b(?:error|exception)\b.{0,15}\b(?:occurred|happened|encountered)\b/i,
  },
  {
    reason: 'failure-pattern: quota or rate limit',
    pattern: /\b(?:exceeded|over)\b.{0,20}\b(?:limit|quota|rate)\b/i,
  },
  {
    reason: 'failure-pattern: API access failure',
    pattern: /\bAPI\s*(?:key|quota|limit)\b.{0,20}\b(?:invalid|expired|exceeded)\b/i,
  },
  { reason: 'failure-pattern: execution error', pattern: /\b(?:streaming|execution)\s+error\b/i },
  { reason: 'failure-pattern: usage exceeded', pattern: /\busage.{0,20}exceeded\b/i },
  {
    reason: 'failure-pattern: timeout',
    pattern: /\btimeout\b.{0,20}\b(?:error|exceeded|after)\b/i,
  },
  { reason: 'failure-pattern: usage limit', pattern: /\busage\s+limit\b/i },
  {
    reason: 'failure-pattern: usage limit',
    pattern: /\bhit\s+your\s+(?:usage\s+)?limit\b/i,
  },
];

function matchFailureReason(text: string, patterns: readonly FailurePattern[]): string | undefined {
  return patterns.find(({ pattern }) => pattern.test(text))?.reason;
}

const DECLARED_PREREQUISITE_BLOCK_REASON =
  'blocked-prerequisite: declared prerequisite unavailable';

/**
 * A declared prerequisite block is a policy-safe terminal outcome, not an
 * execution failure. Require both sides of the contract so an agent cannot
 * evade a real failure by merely prefixing its response with "BLOCKED".
 */
export function classifyDeclaredPrerequisiteBlock(
  response: string | null | undefined,
  options: FailedCompletionOptions = {},
): string | undefined {
  if (!response || !options.prompt) return undefined;
  const promptDeclaresPrerequisite =
    /\bprerequisites?\b|\bapproved\s+[\w -]{0,80}\bonly\b|선행\s*조건|승인(?:된)?[^\n.]{0,80}(?:만\s*(?:입력|사용)|후(?:에만)?)/i
      .test(options.prompt);
  if (!promptDeclaresPrerequisite) return undefined;

  return parseBlockedStageOutcome(response)
    ? DECLARED_PREREQUISITE_BLOCK_REASON
    : undefined;
}

export function isTextReportTask(task: TaskFailureContext): boolean {
  const prompt = task.prompt?.trimStart() ?? '';
  if (prompt.startsWith('[업무보고') || prompt.startsWith('[팀 상시 임무')) return true;

  const mode = task.mode?.trim().toLowerCase().replaceAll('_', '-') ?? '';
  return mode === 'report' || mode.endsWith('-report');
}

/** 응답 텍스트에서 안정적인 저카디널리티 실패 원인을 반환한다. */
export function classifyFailedCompletionReason(
  response: string | null | undefined,
  options: FailedCompletionOptions = {},
): string | undefined {
  if (!response) return undefined;
  if (classifyDeclaredPrerequisiteBlock(response, options)) return undefined;
  const text = response.trim();

  // 성공 프로토콜 가드(2026-07-16, claude-2 관측 + T1 실데이터: 2일 7건 중 4건 오탐).
  // NCO Core Principles상 성공은 'done:'로, 실패는 'error:'로 회신한다. 보안·에러핸들링
  // 태스크는 응답 본문에 401/403/'usage limit'/'error:' 같은 어휘가 필연적이라, 'done:'로
  // 시작하는(=에이전트가 명시적으로 성공을 선언한) 응답은 텍스트 실패 스캔에서 제외한다.
  // 실제 실패는 'error:' 프리픽스나 프로토콜 없는 원시 에러로 남아 아래 스캔에 걸린다.
  if (/^done:/i.test(text)) return undefined;
  const startsWithError = /^Error:\s/i.test(text);

  // 에코-오탐 방어(2026-07-15 라이브 프로브에서 실증): 소스코드/상태 브리프를
  // 인용한 라인은 실패 신호 스캔에서 제외한다 (orchestrated-loop 3세대와 동일 계열).
  const scanText = stripEchoLines(text);

  // HARD 시그니처도 코드리뷰·장애 분석의 본문에는 인용될 수 있다. 실제 Cursor 리뷰가
  // ECONNREFUSED를 분석했다는 이유만으로 정상 결과 전체가 실패 처리된 회귀가 있었다.
  // 짧은 원시 오류는 전체를, 긴 substantive 출력은 오류 envelope인 선두만 검사한다.
  const SHORT_OUTPUT = 500;
  const FAILURE_ENVELOPE = 200;
  const failureEnvelope = scanText.length <= SHORT_OUTPUT
    ? scanText
    : scanText.slice(0, FAILURE_ENVELOPE);
  const hardReason = matchFailureReason(failureEnvelope, HARD_FAILURE_PATTERNS);
  if (hardReason) return hardReason;
  const hasReportedError = /^\s*ERROR:\s/im.test(scanText);
  if (hasReportedError || startsWithError) {
    return matchFailureReason(scanText, REPORTED_ERROR_CAUSE_PATTERNS)
      ?? 'failure-pattern: agent reported error';
  }

  // 텍스트 보고서는 에러 현황 자체를 설명하므로 정상 본문의 SOFT 어휘를 실패로 보지 않는다.
  // HARD 시그니처는 위에서 계속 검사하며, 빈 출력은 task-queue.classifyResult가 계속 차단한다.
  if (options.reportMode) return undefined;

  // SOFT 시그니처: 정상 텍스트에도 등장할 수 있는 단어들(error/failed/usage limit 등).
  // 긴 substantive 출력의 본문 중간 등장은 오탐이므로, 짧은 출력 전체 또는 긴 출력의
  // 선두 200자에서만 판정한다. 근접 제한(.{0,N})으로 span-매칭 오탐도 차단.
  return matchFailureReason(failureEnvelope, SOFT_FAILURE_PATTERNS);
}

/** 응답 텍스트에 에러 패턴이 있으면 true — completed 오탐 방지 */
export function detectFailedCompletion(
  response: string | null | undefined,
  options: FailedCompletionOptions = {},
): boolean {
  return classifyFailedCompletionReason(response, options) !== undefined;
}

function buildFailureError(
  result: { error?: string; output?: string },
  options: FailedCompletionOptions = {},
): string {
  return result.error
    || classifyFailedCompletionReason(result.output, options)
    || 'unknown: execution failed';
}

export function resolveTaskTerminalOutcome(
  result: {
    success: boolean;
    status?: 'completed' | 'failed' | 'timed_out' | 'cancelled';
    error?: string;
    output?: string;
  },
  options: FailedCompletionOptions = {},
): {
  status: 'completed' | 'failed' | 'timed_out' | 'cancelled';
  error?: string;
} {
  const prerequisiteBlock = classifyDeclaredPrerequisiteBlock(result.output, options);
  const classifiedFailure = classifyFailedCompletionReason(result.output, options);
  const status = result.status === 'cancelled'
    ? 'cancelled'
    : prerequisiteBlock
      ? 'cancelled'
      : result.status === 'timed_out'
        || result.error === 'timeout(idle)'
        || result.error === 'timeout(hardcap)'
        ? 'timed_out'
        : result.success && !classifiedFailure
          ? 'completed'
          : 'failed';

  return {
    status,
    error: status === 'completed'
      ? undefined
      : prerequisiteBlock ?? buildFailureError(result, options),
  };
}

function readActiveDiscussionProgress(taskId: string): DiscussionProgressRow | undefined {
  return getDb().prepare(`
    SELECT
      d.status,
      d.current_round,
      d.max_rounds,
      d.participants_json,
      d.created_at AS updated_at,
      MAX(dm.created_at) AS latest_message_at,
      COALESCE(SUM(
        CASE
          WHEN dm.round = MIN(d.max_rounds, d.current_round + 1) THEN 1
          ELSE 0
        END
      ), 0) AS active_round_response_count
    FROM discussions d
    LEFT JOIN discussion_messages dm ON dm.discussion_id=d.id
    WHERE d.task_id=? AND d.status='active'
    GROUP BY d.id
    ORDER BY d.created_at DESC
    LIMIT 1
  `).get(taskId) as DiscussionProgressRow | undefined;
}

function readActiveDiscussionProgressBatch(
  taskIds: readonly string[],
): Map<string, DiscussionProgressRow> {
  const progressByTaskId = new Map<string, DiscussionProgressRow>();
  if (taskIds.length === 0) return progressByTaskId;

  const placeholders = taskIds.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    SELECT
      d.task_id,
      d.status,
      d.current_round,
      d.max_rounds,
      d.participants_json,
      d.created_at AS updated_at,
      MAX(dm.created_at) AS latest_message_at,
      COALESCE(SUM(
        CASE
          WHEN dm.round = MIN(d.max_rounds, d.current_round + 1) THEN 1
          ELSE 0
        END
      ), 0) AS active_round_response_count
    FROM discussions d
    LEFT JOIN discussion_messages dm ON dm.discussion_id=d.id
    WHERE d.task_id IN (${placeholders}) AND d.status='active'
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `).all(...taskIds) as Array<DiscussionProgressRow & { task_id: string }>;

  // created_at DESC이므로 같은 task에 active discussion이 여럿이어도 최신 한 건만 유지한다.
  for (const row of rows) {
    if (!progressByTaskId.has(row.task_id)) progressByTaskId.set(row.task_id, row);
  }
  return progressByTaskId;
}

function withTaskRuntime<T extends {
  id: string;
  status?: string | null;
  progress?: number | null;
  last_activity_at?: string | null;
  assigned_to?: string | null;
  heartbeat_seq?: number | null;
}>(
  task: T,
  prefetchedDiscussion?: DiscussionProgressRow | null,
) {
  const runtime = taskQueue.getTaskSnapshot(
    task.id,
    prefetchedDiscussion === undefined
      ? undefined
      : { lastActivityAt: task.last_activity_at ?? null },
  );
  // tasks가 terminal이면 그 행이 SSOT다. 취소/실패 직후 늦게 남은 active discussion이
  // API 응답을 다시 running으로 덮어쓰면 취소 성공 응답과 조회 결과가 모순된다.
  const discussion = task.status && TERMINAL_STATES.has(task.status)
    ? undefined
    : prefetchedDiscussion === undefined
      ? readActiveDiscussionProgress(task.id)
      : prefetchedDiscussion ?? undefined;
  if (discussion) {
    return {
      ...task,
      ...projectDiscussionTaskProgress(discussion),
    };
  }
  const terminal = projectSingleTaskProgress({
    status: task.status,
    progress: task.progress,
    liveness: runtime.liveness,
    provider: task.assigned_to,
    heartbeatSeq: task.heartbeat_seq,
  });
  return {
    ...task,
    ...terminal,
    lastActivityAt: runtime.lastActivityAt ?? task.last_activity_at ?? null,
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

function rankProviderIds(providerIds: readonly string[]): string[] {
  const ranked = sortProvidersByCostOrder([...providerIds]);
  // R1: 성공률 내림차순 정렬. 동률·데이터없음(0.5)은 원래 cost-order 유지(stable).
  const sr = getProviderSuccessRates();
  return ranked
    .map((id, i) => ({ id, i, q: sr.get(id) ?? 0.5 }))
    .sort((a, b) => (b.q - a.q) || (a.i - b.i))
    .map(x => x.id);
}

function listAvailableProviders(exclude: string[] = []): string[] {
  const excluded = new Set(exclude);
  return rankProviderIds(
    agentManager.listEnabledIds()
      .filter(agentId => !excluded.has(agentId))
      .filter(agentId => circuitBreakerRegistry.getAvailability(agentId).status === 'available'),
  );
}

function missingProviderReadiness(providerId: string): ProviderReadinessResult {
  return evaluateProviderReadiness({
    providerId,
    registration: { registered: false },
    runtimeLoaded: { loaded: false },
    heartbeat: { alive: null },
    admission: { available: null, reason: 'provider-admission-unknown' },
    queueCapacity: { available: null },
    inferenceEvidence: null,
  });
}

function buildProviderNotReadyBody(
  requested: ProviderReadinessResult,
  readyProviders: readonly string[],
  permittedProviders: readonly string[],
) {
  return {
    error: 'provider_not_ready',
    requestedProvider: requested.providerId,
    readyForNewWork: requested.readyForNewWork,
    inferenceVerified: requested.inferenceVerified,
    blockers: requested.blockers,
    verificationBlockers: requested.verificationBlockers,
    dimensions: requested.dimensions,
    availableProviders: permittedProviders,
    // Advisory only. Cross-role execution still requires explicit opt-in.
    suggestedProvider: readyProviders[0] ?? null,
    canFailover: permittedProviders.length > 0,
    requiresCrossRoleOptIn:
      permittedProviders.length === 0 && readyProviders.length > 0,
  };
}

function selectTaskProvider(
  requestedProvider: string,
  allowProviderFailover: boolean,
  readinessByProvider: ReadonlyMap<string, ProviderReadinessResult>,
  roleByProvider: ReadonlyMap<string, string>,
) {
  const requestedReadiness = readinessByProvider.get(requestedProvider)
    ?? missingProviderReadiness(requestedProvider);
  if (requestedReadiness.readyForNewWork) {
    return { agentId: requestedProvider };
  }

  // B2: 요청 프로바이더가 not-ready면 — allowProviderFailover 여부와 무관하게 —
  //     readiness-ready인 '같은 role' 프로바이더로 자동 failover한다. 같은 role 준비된 곳이 없으면 409로 명확히 거부
  //     (엉뚱한 role로 크로스 라우팅해 '가짜 성공' 내는 것 방지). "리밋 걸린 곳엔 위임 안 한다"의 인테이크 구현.
  const readyProviders = rankProviderIds(
    [...readinessByProvider.values()]
      .filter(readiness => readiness.providerId !== requestedProvider && readiness.readyForNewWork)
      .map(readiness => readiness.providerId),
  );
  const requestedRole = roleByProvider.get(requestedProvider);
  const sameRoleReady = readyProviders.filter(id => roleByProvider.get(id) === requestedRole);
  const permittedProviders = allowProviderFailover ? readyProviders : sameRoleReady;
  const failoverTarget = permittedProviders[0];
  if (!failoverTarget) {
    return {
      error: buildProviderNotReadyBody(
        requestedReadiness,
        readyProviders,
        permittedProviders,
      ),
    };
  }

  return {
    agentId: failoverTarget,
    failover: {
      applied: true,
      originalProvider: requestedProvider,
      originalGate: requestedReadiness.blockers.join(',') || 'provider-not-ready',
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
import { registerProviderAssignmentRoutes } from './routes/provider-assignments.js';
import { ProviderAssignmentRuntime } from '../core/provider-assignment-runtime.js';
import { registerCliQaRoutes } from './routes/cli-qa.js';
import { registerGoalsRoutes } from './routes/goals.js';
import { registerPerformanceRoutes } from './routes/performance.js';
import { isAutomaticProviderFailoverAllowed } from './task-failover-policy.js';
import { registerPerformanceFlowRoutes } from './routes/performance-flow.js';
import { registerWorkReportRoutes } from './routes/work-reports.js';
import { registerWorkEventRoutes } from './routes/work-events.js';
import { registerHarnessRoutes } from './routes/harness.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerTeamScoreRoutes } from './routes/team-scores.js';
import { registerWebScrapingRoutes } from './routes/web-scraping.js';
import { invocationTracker } from '../core/invocation-tracker.js';
import { delegationManager } from '../core/delegation-manager.js';
import { collaborationEngine } from '../core/collaboration-engine.js';
import { ProviderSelectionError, sortProvidersByCostOrder } from '../core/smart-router.js';
import {
  failoverPreferTeamMembersEnabled,
  isRetryableFailoverFailure,
  loadFailoverChainsConfig,
  selectFailoverCandidate,
} from './task-failover.js';
import {
  acknowledgeTaskLease,
  recordTaskHeartbeat,
  startLeaseSweeper,
  type LeaseSweepReason,
} from '../core/lease-sweeper.js';

const log = createLogger('gateway');
let draining = false;

const GATEWAY_AUTH_EXEMPT_PATHS = new Set([
  '/health',
  '/api/health',
]);
const GATEWAY_AUTH_LOCALHOSTS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PROVIDER_DISCOVERY_PATHS = new Set([
  '/api/ai-providers/registry',
  '/api/ai-providers/readiness',
  '/api/ai-providers',
  '/api/ai-providers/enabled',
  '/api/ai-providers/status',
]);

const REALTIME_MINIMUMS = {
  parallel: 2,
  discussion: 3,
  consensus: 3,
  hive: 2,
} as const;

const TaskHeartbeatBodySchema = z.object({
  progress: z.object({
    step: z.number().int().min(0),
    total: z.number().int().positive(),
  }).optional(),
  note: z.string().max(2_000).optional(),
});

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
  model?: string;
  metadata?: Record<string, unknown>;
  parentTaskId?: string;
  prompt: string;
  mode?: z.infer<typeof CreateTaskInput.shape.mode>;
  workspaceId?: string;
  priority?: number;
  timeout?: number;
  systemPrompt?: string;
  verifier?: z.infer<NonNullable<typeof CreateTaskInput.shape.verifier>>;
};
type RetryTaskResult =
  | {
      ok: true;
      newTaskId: string;
      sourceTaskId: string;
      retryCount: number;
      deduplicated?: boolean;
      replacedActive?: boolean;
    }
  | { ok: false; statusCode: number; body: Record<string, unknown> };
type RetryPayloadOptions = {
  allowCompletedSource?: boolean;
  allowActiveSource?: boolean;
};

type ReservedRetry = Extract<ReturnType<typeof reserveRetry>, { allowed: true }> & {
  sourceTaskId: string;
};

type RetryTaskOptions = {
  overrideAi?: string;
  overridePrompt?: string;
  allowCompletedSource?: boolean;
  reason?: string;
  reservedRetry?: ReservedRetry;
};

/** 아주 빠른 retry 완료 직후 도착한 동일 네트워크 재전송만 completed dedup으로 본다. */
const COMPLETED_RETRY_DEDUP_WINDOW_SECONDS = 30;

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
  prompt: CreateTaskInput.shape.prompt.optional(),
  replaceActive: z.boolean().optional().default(false),
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
const DynamicMcpToolExecuteSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
});
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
  projectDir: z.string().min(1).optional(),
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

  const resolveRetrySourceTaskId = (db: ReturnType<typeof getDb>, taskId: string) => {
  // 이전 nova-use 일반 위임 경로는 재실행할 때마다 직전 태스크를 parent로 삼아
  // root → child → grandchild 체인을 만들었다. 한 단계만 읽으면 legacy chain이 retry cap을
  // 세대별로 우회하므로, 존재하는 최상위 조상까지 따라간다. path/depth guard는 손상된
  // 순환 계보에서도 조회가 끝나게 한다.
  const root = db.prepare(`
    WITH RECURSIVE lineage(id, parent_task_id, depth, path) AS (
      SELECT id, parent_task_id, 0, ',' || id || ','
      FROM tasks
      WHERE id = ?
      UNION ALL
      SELECT parent.id, parent.parent_task_id, lineage.depth + 1,
             lineage.path || parent.id || ','
      FROM tasks AS parent
      JOIN lineage ON parent.id = lineage.parent_task_id
      WHERE lineage.depth < 63
        AND instr(lineage.path, ',' || parent.id || ',') = 0
    )
    SELECT id
    FROM lineage
    ORDER BY depth DESC
    LIMIT 1
  `).get(taskId) as { id: string } | undefined;
    return root?.id ?? taskId;
  };

  const loadRetryLineageAssignedAgents = (
    db: ReturnType<typeof getDb>,
    sourceTaskId: string,
  ): string[] => (db.prepare(`
    WITH RECURSIVE lineage(id, assigned_to, created_at, depth, path) AS (
      SELECT id, assigned_to, created_at, 0, ',' || id || ','
      FROM tasks
      WHERE id = ?
      UNION ALL
      SELECT child.id, child.assigned_to, child.created_at, lineage.depth + 1,
             lineage.path || child.id || ','
      FROM tasks AS child
      JOIN lineage ON child.parent_task_id = lineage.id
      WHERE lineage.depth < 63
        AND instr(lineage.path, ',' || child.id || ',') = 0
    )
    SELECT assigned_to
    FROM lineage
    WHERE assigned_to IS NOT NULL
    ORDER BY created_at ASC, id ASC
  `).all(sourceTaskId) as Array<{ assigned_to: string | null }>)
    .map(row => row.assigned_to)
    .filter((value): value is string => Boolean(value));

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
    SELECT verifier_json, verifier_result_json, metadata_json
    FROM tasks
    WHERE id=?
  `).get(taskId) as {
    verifier_json: string | null;
    verifier_result_json: string | null;
    metadata_json: string | null;
  } | undefined;
  const sourceStatusFilter = opts?.allowActiveSource
    ? "status IN ('pending', 'queued', 'assigned', 'running', 'streaming', 'reviewing')"
    : opts?.allowCompletedSource
      ? "status IN ('failed', 'timed_out', 'lease_expired', 'completed')"
      : "status IN ('failed', 'timed_out', 'lease_expired')";
  const sourceTask = deadLetter ? undefined : db.prepare(`
    SELECT assigned_to, prompt, mode, workspace_id, priority, system_prompt, metadata_json
    FROM tasks
    WHERE id=? AND ${sourceStatusFilter}
  `).get(taskId) as {
    assigned_to: string | null;
    prompt: string;
    mode: z.infer<typeof CreateTaskInput.shape.mode> | null;
    workspace_id: string | null;
    priority: number | null;
    system_prompt: string | null;
    metadata_json: string | null;
  } | undefined;

  const parsedVerifier = (() => {
    if (!verifierRow?.verifier_json) return undefined;
    try {
      return JSON.parse(verifierRow.verifier_json) as z.infer<NonNullable<typeof CreateTaskInput.shape.verifier>>;
    } catch {
      return undefined;
    }
  })();
  // 재시도는 원 태스크의 팀·회사 계보를 유지해야 score/업무보고 피드백에 귀속된다.
  // 실행 권한·workflow·evidence 계약도 동일해야 한다. 반대로 qualityRejected,
  // verificationStatus, attemptedAgents 같은 실행 결과/진단 플래그는 새 시도의 결과이므로
  // 승계하지 않는다. 전체 metadata spread 대신 명시적 allowlist를 유지하는 이유다.
  const retryMetadata = (() => {
    if (!verifierRow?.metadata_json) return undefined;
    try {
      const source = JSON.parse(verifierRow.metadata_json) as Record<string, unknown>;
      const inherited: Record<string, unknown> = {};
      for (const key of [
        'projectDir',
        'allowProviderFailover',
        'readOnly',
        'localNetworkAccess',
        'queuePriority',
        'queueWaitMaxMs',
        'taskTimeoutMs',
        'correlationId',
        'turnId',
        'organizationId',
        'teamId',
        'companyRunId',
        'workReportId',
        'workflowRunId',
        'workflowStage',
        'workflowRequired',
        'qualityRetryOwner',
        'requiredEvidence',
        'auditControlPlane',
        'verificationDirectiveId',
        'subjectId',
        'subjectKind',
        'kanbanTaskId',
        'kanbanPlanId',
      ]) {
        if (source[key] !== undefined) inherited[key] = source[key];
      }
      // Self-heal legacy Nova-AX audit retries created before the explicit
      // control-plane markers were persisted. Their workReportId is a stable
      // protocol identifier and cannot approve or complete a subject task.
      if (isAuditControlPlane(source)) {
        inherited.auditControlPlane = true;
        inherited.scoreEligible = false;
      }
      return Object.keys(inherited).length > 0 ? inherited : undefined;
    } catch {
      return undefined;
    }
  })();
  const retryTimeout = (() => {
    const parsed = CreateTaskInput.shape.timeout.safeParse(retryMetadata?.taskTimeoutMs);
    return parsed.success ? parsed.data : undefined;
  })();

  const payload = deadLetter
    ? {
        ai: parseRetryTaskAi(deadLetter.ai),
        prompt: deadLetter.prompt ?? '',
        timeout: retryTimeout,
        verifier: parsedVerifier,
        metadata: retryMetadata,
      }
    : sourceTask
      ? {
          ai: parseRetryTaskAi(sourceTask.assigned_to),
          model: (() => {
            if (!sourceTask.metadata_json) return undefined;
            try {
              const metadata = JSON.parse(sourceTask.metadata_json) as Record<string, unknown>;
              return typeof metadata.model === 'string' && metadata.model.trim() ? metadata.model : undefined;
            } catch {
              return undefined;
            }
          })(),
          prompt: sourceTask.prompt,
          mode: sourceTask.mode ?? undefined,
          workspaceId: sourceTask.workspace_id ?? undefined,
          priority: sourceTask.priority ?? undefined,
          timeout: retryTimeout,
          systemPrompt: sourceTask.system_prompt ?? undefined,
          verifier: parsedVerifier,
          metadata: retryMetadata,
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

export function isCompanyOrchestratorQualityRetryOwner(
  metadataJson: string | null | undefined,
): boolean {
  if (!metadataJson) return false;
  try {
    const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
    return metadata.qualityRetryOwner === 'company-orchestrator'
      && typeof metadata.companyRunId === 'string'
      && metadata.companyRunId.trim().length > 0;
  } catch {
    return false;
  }
}

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

const DYNAMIC_MCP_TASK_POLL_TIMEOUT_MS = 300_000;
const DYNAMIC_MCP_TASK_POLL_INTERVAL_MS = 250;

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text.slice(0, 2_000) };
  }
}

async function executeDynamicMcpAgentTask(agentId: string, prompt: string): Promise<string> {
  const baseUrl = `http://127.0.0.1:${env.PORT}`;
  const createResponse = await fetch(`${baseUrl}/api/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ai: agentId,
      prompt,
      callerAgentId: 'nco-dynamic-skill',
      callerSessionId: 'nco-dynamic-skill',
      metadata: { projectDir: resolveInternalProjectDir() },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const created = await readJsonResponse(createResponse);
  const taskId = typeof created.taskId === 'string' ? created.taskId : null;
  if (!createResponse.ok || !taskId) {
    throw new Error(typeof created.error === 'string'
      ? created.error
      : `dynamic skill task creation failed (HTTP ${createResponse.status})`);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < DYNAMIC_MCP_TASK_POLL_TIMEOUT_MS) {
    const statusResponse = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/status`, {
      signal: AbortSignal.timeout(30_000),
    });
    const statusBody = await readJsonResponse(statusResponse);
    const status = typeof statusBody.status === 'string' ? statusBody.status : '';
    if (status === 'completed') {
      return typeof statusBody.result === 'string'
        ? statusBody.result
        : JSON.stringify(statusBody.result ?? '');
    }
    if (['failed', 'timed_out', 'cancelled'].includes(status)) {
      throw new Error(typeof statusBody.error === 'string'
        ? statusBody.error
        : `dynamic skill task ${status}`);
    }
    await new Promise(resolveWait => setTimeout(resolveWait, DYNAMIC_MCP_TASK_POLL_INTERVAL_MS));
  }

  throw new Error(`dynamic skill task timeout: ${taskId}`);
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const NOVA_AX_BASE_URL = process.env.NOVA_AX_URL || 'http://127.0.0.1:6300';
const NOVA_AX_ACTIVITY_PATH = '/api/activity';

function parseTaskMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  const parsed = safeJsonParse(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

export function isAuditControlPlane(metadata: Record<string, unknown>): boolean {
  if (metadata.auditControlPlane === true
    || typeof metadata.verificationDirectiveId === 'string') return true;

  // Legacy audit jobs predate durable control-plane metadata, but their work
  // report identifiers still uniquely identify them. Without this fallback a
  // retry is treated as ordinary work and recursively creates another audit.
  const workReportId = typeof metadata.workReportId === 'string'
    ? metadata.workReportId
    : '';
  return workReportId.startsWith('completion_audit_task_')
    || workReportId.startsWith('remediation_vloop_');
}

function requiresNovaAxAudit(
  teamId: string | null,
  metadata: Record<string, unknown>,
): boolean {
  // UI 검사 근거 생산팀도 Nova-AX 6기관 최종감사의 대상이다.
  return Boolean(teamId) && !isAuditControlPlane(metadata);
}

async function postNovaAxActivity(body: Record<string, unknown>): Promise<{
  ok: boolean;
  status: number;
  payload: Record<string, unknown>;
}> {
  const secret = (process.env.AX_NCO_SECRET || process.env.NCO_API_TOKEN || '').trim();
  if (!secret) throw new Error('Nova-AX bridge secret is not configured');
  const bodyText = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const nonce = randomBytes(8).toString('hex');
  const signature = createHmac('sha256', secret)
    .update(`POST:${NOVA_AX_ACTIVITY_PATH}:${timestamp}:${nonce}:${bodyText}`)
    .digest('hex');
  const response = await fetch(`${NOVA_AX_BASE_URL}${NOVA_AX_ACTIVITY_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-nco-signature': signature,
      'x-nco-timestamp': timestamp,
      'x-nco-nonce': nonce,
      'x-nco-service': 'nco',
    },
    body: bodyText,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      payload = { raw: text };
    }
  }
  return { ok: response.ok, status: response.status, payload };
}

async function notifyNovaAxAuditRequired(input: {
  taskId: string;
  companyId: string;
  teamId: string;
  actorId: string;
  prompt: string;
}): Promise<void> {
  const response = await postNovaAxActivity({
    id: `nco-audit-pending:${input.taskId}:${Date.now()}`,
    timestamp: new Date().toISOString(),
    agentId: input.actorId,
    agentName: input.actorId,
    action: 'task_complete',
    description: input.prompt.slice(0, 500),
    taskId: input.taskId,
    companyId: input.companyId,
    teamId: input.teamId,
    metadata: {
      auditPending: true,
      source: 'nco-completion-gate',
      requiredPriority: 10,
    },
  });
  // A 409 is the expected fail-closed acknowledgement: Nova-AX recorded the
  // rejected completion and queued the task-bound priority-10 audit.
  if (response.status !== 409 && !response.ok) {
    throw new Error(`Nova-AX audit queue request failed with HTTP ${response.status}`);
  }
}

function markTaskAuditQueued(taskId: string): void {
  const db = getDb();
  const row = db.prepare('SELECT metadata_json FROM tasks WHERE id=?').get(taskId) as
    | { metadata_json: string | null }
    | undefined;
  const metadata = parseTaskMetadata(row?.metadata_json);
  metadata.verificationStatus = 'pending';
  metadata.verificationAuditQueuedAt = new Date().toISOString();
  metadata.auditPriority = 10;
  db.prepare(`
    UPDATE tasks
    SET metadata_json=?, updated_at=datetime('now')
    WHERE id=? AND status='reviewing'
  `).run(JSON.stringify(metadata), taskId);
}

export function quarantineLegacyNestedAuditTasks(
  limit = 25,
  db: ReturnType<typeof getDb> = getDb(),
): number {
  const boundedLimit = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), 100)
    : 25;
  const rows = db.prepare(`
    SELECT id, metadata_json
    FROM tasks
    WHERE status='reviewing'
      AND json_valid(COALESCE(metadata_json, ''))
      AND COALESCE(json_extract(metadata_json, '$.auditControlPlane'), 0) <> 1
      AND json_extract(metadata_json, '$.verificationDirectiveId') IS NULL
      AND (
        json_extract(metadata_json, '$.workReportId') LIKE 'completion_audit_task_%'
        OR json_extract(metadata_json, '$.workReportId') LIKE 'remediation_vloop_%'
      )
    ORDER BY updated_at, id
    LIMIT ?
  `).all(boundedLimit) as Array<{ id: string; metadata_json: string }>;
  let quarantined = 0;
  for (const row of rows) {
    const metadata = parseTaskMetadata(row.metadata_json);
    metadata.auditControlPlane = true;
    metadata.scoreEligible = false;
    metadata.legacyNestedAuditQuarantinedAt = new Date().toISOString();
    const marked = db.prepare(`
      UPDATE tasks
      SET metadata_json=?, updated_at=datetime('now')
      WHERE id=? AND status='reviewing'
    `).run(JSON.stringify(metadata), row.id);
    if (marked.changes === 0) continue;
    const reason = 'legacy nested audit-control task quarantined for safe redispatch';
    const moved = transitionTask(db, row.id, 'cancelled', { error: reason });
    if (!moved.ok) continue;
    syncWorkflowTask(row.id, 'cancelled', { error: reason }, db);
    quarantined++;
  }
  return quarantined;
}

async function reconcilePendingOrganizationAudits(limit = 25): Promise<number> {
  const db = getDb();
  const quarantined = quarantineLegacyNestedAuditTasks(limit, db);
  if (quarantined > 0) {
    log.warn({ quarantined }, 'Legacy nested audit-control tasks quarantined');
  }
  const rows = db.prepare(`
    SELECT k.id, k.team_id, k.assigned_to, k.prompt, k.metadata_json,
      t.organization_id
    FROM tasks k
    JOIN teams t ON t.id=k.team_id
    JOIN organizations o ON o.id=t.organization_id
    WHERE k.status='reviewing'
      AND t.is_active=1
      AND o.is_active=1
      AND (
        NOT json_valid(COALESCE(k.metadata_json, ''))
        OR COALESCE(json_extract(k.metadata_json, '$.verificationStatus'), '') <> 'approved'
      )
      AND (
        NOT json_valid(COALESCE(k.metadata_json, ''))
        OR json_extract(k.metadata_json, '$.verificationAuditQueuedAt') IS NULL
        OR datetime(json_extract(k.metadata_json, '$.verificationAuditQueuedAt'))
          <= datetime('now','-10 minutes')
      )
    ORDER BY k.updated_at, k.id
    LIMIT ?
  `).all(limit) as Array<{
    id: string;
    team_id: string;
    assigned_to: string | null;
    prompt: string;
    metadata_json: string | null;
    organization_id: string;
  }>;
  let queued = 0;
  for (const row of rows) {
    const metadata = parseTaskMetadata(row.metadata_json);
    if (isAuditControlPlane(metadata)) continue;
    await notifyNovaAxAuditRequired({
      taskId: row.id,
      companyId: row.organization_id,
      teamId: row.team_id,
      actorId: row.assigned_to || 'nco',
      prompt: row.prompt,
    });
    markTaskAuditQueued(row.id);
    queued++;
  }
  return queued;
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

export async function createGateway(): Promise<NcoGateway> {
  const app = Fastify({ logger: false }) as unknown as NcoGateway;
  if (!providerRuntimeCoordinator.getSnapshot()) {
    await providerRuntimeCoordinator.init();
  }
  const organizationAuditTimer = setInterval(() => {
    void reconcilePendingOrganizationAudits().catch(error => {
      log.warn({
        err: error instanceof Error ? error.message : String(error),
      }, 'Pending organization audit reconciliation failed');
    });
  }, 60_000);
  organizationAuditTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(organizationAuditTimer);
    providerRuntimeCoordinator.stop();
  });
  void reconcilePendingOrganizationAudits().catch(error => {
    log.warn({
      err: error instanceof Error ? error.message : String(error),
    }, 'Initial pending organization audit reconciliation failed');
  });
  try {
    reconcileTerminalWorkflowTasks();
    failStaleDiscussions();
  } catch (error) {
    // A rolling deployment may briefly run old schema code before migration.
    // Startup stays available, but the exact cleanup gap remains observable.
    log.warn({
      err: error instanceof Error ? error.message : String(error),
    }, 'Workflow stale-discussion cleanup skipped');
  }
  app.addHook('preHandler', async (request, reply) => {
    const configuredToken = process.env.NCO_API_TOKEN?.trim() ?? '';
    const path = request.url.split('?', 1)[0];

    // Provider topology is sensitive on the default 0.0.0.0 bind. Remote
    // discovery fails closed unless an API token is configured; localhost
    // remains available for Nova CLI bootstrap and diagnostics.
    if (
      !configuredToken
      && PROVIDER_DISCOVERY_PATHS.has(path)
      && !GATEWAY_AUTH_LOCALHOSTS.has(request.ip)
    ) {
      return reply.code(503).send({
        error: 'provider_registry_remote_auth_not_configured',
        statusCode: 503,
      });
    }
    // Other API authentication remains backward-compatible and opt-in.
    if (!configuredToken || !path.startsWith('/api/')) return;
    if (GATEWAY_AUTH_LOCALHOSTS.has(request.ip)) return;
    if (GATEWAY_AUTH_EXEMPT_PATHS.has(path)) return;

    const authorization = request.headers.authorization;
    const ncoTokenHeader = request.headers['x-nco-token'];
    const ncoToken = Array.isArray(ncoTokenHeader) ? ncoTokenHeader[0] : ncoTokenHeader;
    if (authorization === `Bearer ${configuredToken}` || ncoToken === configuredToken) return;

    return reply.code(401).send({ error: 'Unauthorized', statusCode: 401 });
  });
  app.addHook('preSerialization', async (request, _reply, payload) => {
    if (request.method !== 'GET' || request.url.split('?', 1)[0] !== '/api/agents') {
      return payload;
    }
    if (typeof payload !== 'object' || payload === null || !('agents' in payload)) {
      return payload;
    }

    const response = payload as { agents?: unknown } & Record<string, unknown>;
    if (!Array.isArray(response.agents)) return payload;

    const agents = response.agents.map((agent) => {
      if (typeof agent !== 'object' || agent === null || !('id' in agent)) return agent;

      let trust = null;
      if (typeof agent.id === 'string') {
        try {
          trust = computeTrustScores(agent.id);
        } catch {
          trust = null;
        }
      }
      return { ...agent, trust };
    });

    return { ...response, agents };
  });
  const getInFlightCount = (): number => {
    const db = getDb();
    const row = db.prepare(`
      SELECT COUNT(*) as count
      FROM tasks
      WHERE status IN ('queued', 'assigned', 'running', 'streaming')
    `).get() as { count: number };
    return row.count;
  };

  // 한 프로세스 안에서 같은 retry root에 대한 HTTP 요청을 직렬화한다. UI 더블클릭이나
  // 네트워크 재전송이 동시에 들어와 둘 다 "활성 자식 없음"을 본 뒤 복제본을 두 개 만드는
  // 경쟁을 막는다. 실제 중복 판정은 아래 active child 조회가 담당하고 이 맵은 TOCTOU 창만 닫는다.
  const retryLocks = new Map<string, Promise<void>>();
  const withRetryLock = async <T>(sourceTaskId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = retryLocks.get(sourceTaskId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolveCurrent) => { releaseCurrent = resolveCurrent; });
    const tail = previous.catch(() => undefined).then(() => current);
    retryLocks.set(sourceTaskId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (retryLocks.get(sourceTaskId) === tail) retryLocks.delete(sourceTaskId);
    }
  };

  const cancelTaskById = async (taskId: string, reply?: { code: (statusCode: number) => unknown }) => {
    const db = getDb();
    const task = db.prepare('SELECT id, status FROM tasks WHERE id=?').get(taskId) as { id: string; status: string } | undefined;
    if (!task) {
      reply?.code(404);
      return { ok: false, killed: false, error: 'Task not found' };
    }

    if (TERMINAL_STATES.has(task.status)) {
      // 이미 끝난 태스크라도 이전 프로세스가 side effect 직전에 죽었을 수 있다.
      // 취소의 멱등 응답을 돌려주기 전에 동일한 quality/workflow/Kanban 정산을 복구한다.
      try {
        await app.settlePersistedTaskTerminal(taskId);
      } catch (error) {
        log.warn({
          taskId,
          status: task.status,
          err: error instanceof Error ? error.message : String(error),
        }, 'Terminal cancellation lookup could not repair task side effects');
      }
      return { ok: true, killed: false, alreadyTerminal: true, status: task.status };
    }

    const moved = transitionTask(db, taskId, 'cancelled');

    if (!moved.ok) {
      if (moved.prev && TERMINAL_STATES.has(moved.prev)) {
        return { ok: true, killed: false, alreadyTerminal: true, status: moved.prev };
      }
      log.info({ taskId, prev: moved.prev }, 'Cancel skipped because task transition was rejected');
      return { ok: false, killed: false, status: moved.prev };
    }

    // DB terminal 상태를 먼저 확정한 뒤 실행기에 취소를 전파한다. 늦은 provider 완료
    // 콜백은 transition/조건부 UPDATE 가드에서 거부되므로 cancelled가 다시 열리지 않는다.
    const queueKilled = await taskQueue.abort(taskId);
    let cancelledDiscussions = 0;
    try {
      cancelledDiscussions = discussionEngine.cancelTaskDiscussions(taskId);
      syncWorkflowTask(taskId, 'cancelled', {}, db);
    } catch (error) {
      log.warn({
        taskId,
        error: error instanceof Error ? error.message : String(error),
      }, 'Task was cancelled but linked orchestration cleanup was partial');
    }
    const killed = queueKilled || cancelledDiscussions > 0;

    projectKanbanTaskStatus(taskId, 'cancelled');
    await eventBus.publish({ type: 'task:cancelled', taskId });
    return { ok: true, killed, cancelledDiscussions, status: 'cancelled' };
  };

  const validateRetryOverrideAgent = (ai: string | undefined): { ok: true } | { ok: false; body: Record<string, unknown> } => {
    if (!ai) return { ok: true };
    if (!agentManager.getProvider(ai) || !agentManager.listEnabledIds().includes(ai)) {
      return { ok: false, body: { error: 'invalid ai override' } };
    }
    return { ok: true };
  };

  /**
   * 태스크가 속한 팀의 선언 로스터(lead 우선, 그다음 provider 멤버를 등록순)를 돌려준다.
   * failover 후보를 팀 안에서 먼저 고르기 위한 preference 목록일 뿐이라 팀이 없거나
   * 멤버가 없으면 빈 배열 → 호출측은 기존 provider chain을 그대로 쓴다.
   * 근거·롤백: task-failover.ts의 failoverPreferTeamMembersEnabled 주석 참조.
   */
  const loadTeamRosterForTask = (db: ReturnType<typeof getDb>, taskId: string): string[] => {
    if (!failoverPreferTeamMembersEnabled()) return [];
    try {
      const row = db.prepare(`
        SELECT t.id AS team_id, t.lead
        FROM tasks k
        JOIN teams t ON t.id = k.team_id
        WHERE k.id = ? AND t.is_active = 1
      `).get(taskId) as { team_id: string; lead: string | null } | undefined;
      if (!row) return [];
      const members = (db.prepare(`
        SELECT member_ref
        FROM team_members
        WHERE team_id = ? AND member_type = 'provider'
        ORDER BY created_at ASC, id ASC
      `).all(row.team_id) as Array<{ member_ref: string | null }>)
        .map(member => member.member_ref?.trim())
        .filter((ref): ref is string => Boolean(ref));
      const roster = [row.lead?.trim(), ...members].filter((ref): ref is string => Boolean(ref));
      return [...new Set(roster)];
    } catch (error) {
      log.warn({
        taskId,
        error: error instanceof Error ? error.message : String(error),
      }, 'Failed to load team roster for failover preference');
      return [];
    }
  };

  let bindKanbanRetryTaskRef: ((sourceTaskId: string, newTaskId: string) => boolean) | null = null;
  const bindKanbanRetryTask = (sourceTaskId: string, newTaskId: string): void => {
    try {
      bindKanbanRetryTaskRef?.(sourceTaskId, newTaskId);
    } catch (error) {
      log.warn({
        sourceTaskId,
        newTaskId,
        err: error instanceof Error ? error.message : String(error),
      }, 'Canonical retry could not be rebound to Kanban');
    }
  };

  const createRetryTask = async (
    taskId: string,
    options?: RetryTaskOptions,
  ): Promise<RetryTaskResult> => {
    const db = getDb();
    const sourceTaskId = options?.reservedRetry?.sourceTaskId
      ?? resolveRetrySourceTaskId(db, taskId);
    const payload = loadRetryPayload(db, taskId, { allowCompletedSource: options?.allowCompletedSource });
    if (!payload) {
      return { ok: false, statusCode: 404, body: { error: 'Retry source not found' } };
    }

    const overrideValidation = validateRetryOverrideAgent(options?.overrideAi);
    if (!overrideValidation.ok) {
      return { ok: false, statusCode: 400, body: overrideValidation.body };
    }

    // 업무보고 복제본은 부모 prompt를 바이트 단위로 승계하므로 `[실데이터]` 스냅샷이
    // 부모 제출 시각에 동결된다(그래서 failover를 유발한 실패가 보고서에서 사라진다).
    // 복제 시점에 재조회해 실행 시점 사실과 일치시킨다. 롤백: NCO_WORK_REPORT_SNAPSHOT_REFRESH=off.
    const inheritedMetadata = (payload.metadata ?? {}) as Record<string, unknown>;
    const retryTeamId = typeof inheritedMetadata.teamId === 'string' ? inheritedMetadata.teamId : null;
    const isWorkReportRetry = typeof inheritedMetadata.workReportId === 'string'
      && inheritedMetadata.workReportId.length > 0;
    const selectedPrompt = options?.overridePrompt ?? payload.prompt;
    const basePrompt = isWorkReportRetry && retryTeamId
      ? refreshWorkReportPromptSnapshot(selectedPrompt, retryTeamId)
      : selectedPrompt;
    const finalPrompt = options?.reason
      ? `[Quality-gate reject: ${options.reason}]\n\n${basePrompt}`
      : basePrompt;
    const desiredAi = options?.overrideAi ?? payload.ai;
    const retryMetadata: Record<string, unknown> = {
      ...(payload.metadata ?? {}),
      projectDir: inheritedMetadata.projectDir ?? resolveInternalProjectDir(),
    };
    // /api/task는 저장 전에 prompt gate 보강과 초대형 prompt 압축을 적용한다.
    // completed child의 저장값과 호출 원문을 직접 비교하면 같은 빠른 재전송도 서로
    // 다른 prompt로 오인하므로, intake와 동일한 표준형을 fingerprint에 사용한다.
    const gatedRetryPrompt = shouldApplyPromptGateForProvider(desiredAi)
      ? applyPromptGate(finalPrompt, retryMetadata).prompt
      : finalPrompt;
    const expectedStoredPrompt = gatedRetryPrompt.length > MAX_PLAN_CHARS
      ? compressPlan(gatedRetryPrompt)
      : gatedRetryPrompt;

    // 활성 child는 같은 요청일 때만 재사용해 병렬 fan-out을 막는다. 다른 prompt/provider
    // 요청에 기존 ID를 성공처럼 돌려주면 사용자는 수정본이 실행됐다고 오인하므로 충돌로
    // 명확히 거부한다. completed child는 아주 빠르게 끝난 직후 들어온 더블클릭/네트워크
    // 재전송일 수 있으므로 짧은 창에서 같은 fingerprint만 dedup한다.
    const existingRetry = db.prepare(`
      WITH RECURSIVE retry_lineage(
        id, status, prompt, assigned_to, metadata_json, created_at, depth, path
      ) AS (
        SELECT id, status, prompt, assigned_to, metadata_json, created_at, 0,
               ',' || id || ','
        FROM tasks
        WHERE id = ?
        UNION ALL
        SELECT child.id, child.status, child.prompt, child.assigned_to,
               child.metadata_json, child.created_at, retry_lineage.depth + 1,
               retry_lineage.path || child.id || ','
        FROM tasks AS child
        JOIN retry_lineage ON child.parent_task_id = retry_lineage.id
        WHERE retry_lineage.depth < 63
          AND instr(retry_lineage.path, ',' || child.id || ',') = 0
      )
      SELECT id, status, prompt, assigned_to,
             CASE WHEN json_valid(metadata_json)
               THEN json_extract(metadata_json, '$.requestedProvider')
               ELSE NULL
             END AS requested_provider
      FROM retry_lineage
      WHERE id <> ?
        AND (
          status IN ('pending', 'queued', 'assigned', 'running', 'streaming', 'reviewing')
          OR (status='completed' AND created_at >= datetime('now', '-${COMPLETED_RETRY_DEDUP_WINDOW_SECONDS} seconds'))
        )
      ORDER BY CASE WHEN status='completed' THEN 1 ELSE 0 END, created_at DESC, id DESC
      LIMIT 1
    `).get(sourceTaskId, sourceTaskId) as {
      id: string;
      status: string;
      prompt: string;
      assigned_to: string | null;
      requested_provider: string | null;
    } | undefined;
    const existingRequestedAi = existingRetry?.requested_provider ?? existingRetry?.assigned_to;
    const sameRetryFingerprint = existingRetry
      && existingRetry.prompt === expectedStoredPrompt
      && existingRequestedAi === desiredAi;
    if (existingRetry && sameRetryFingerprint) {
      if (options?.reservedRetry) rollbackRetryReservation(db, sourceTaskId);
      const count = readRetryCount(db, sourceTaskId)?.count ?? 0;
      bindKanbanRetryTask(taskId, existingRetry.id);
      return {
        ok: true,
        newTaskId: existingRetry.id,
        sourceTaskId,
        retryCount: count,
        deduplicated: true,
      };
    }
    if (existingRetry && existingRetry.status !== 'completed') {
      if (options?.reservedRetry) rollbackRetryReservation(db, sourceTaskId);
      return {
        ok: false,
        statusCode: 409,
        body: {
          error: 'retry_in_progress_conflict',
          detail: 'A retry is already active with a different prompt or provider.',
          activeRetryTaskId: existingRetry.id,
          activeRetryStatus: existingRetry.status,
        },
      };
    }

    const retryReservation = options?.reservedRetry ?? reserveRetry(db, sourceTaskId);
    if (!retryReservation.allowed) {
      return {
        ok: false,
        statusCode: 429,
        body: {
          error: 'retry limit exceeded',
          reason: retryReservation.reason,
          count: retryReservation.count,
          totalCount: retryReservation.totalCount,
        },
      };
    }

    // A retry stays in the same user turn/correlation lineage but is a new
    // execution attempt. The source idempotency key, attempt id, absolute
    // deadline, and registry revision are scoped to the original intake, so
    // bind the child to the current registry with a fresh bounded window.
    const rawQueueBudgetMs = Number(retryMetadata.queueWaitMaxMs);
    const retryQueueBudgetMs = Number.isFinite(rawQueueBudgetMs) && rawQueueBudgetMs > 0
      ? Math.trunc(rawQueueBudgetMs)
      : 30_000;
    const rawExecutionBudgetMs = Number(payload.timeout);
    const retryExecutionBudgetMs = Number.isFinite(rawExecutionBudgetMs) && rawExecutionBudgetMs > 0
      ? Math.trunc(rawExecutionBudgetMs)
      : 120_000;
    const activeProviderRevision = providerRuntimeCoordinator.getSnapshot()?.revision;
    const finalRetryMetadata: Record<string, unknown> = {
      ...retryMetadata,
      attemptId: `attempt_${randomBytes(12).toString('hex')}`,
      deadlineAt: new Date(
        Date.now() + retryQueueBudgetMs + retryExecutionBudgetMs + 5_000,
      ).toISOString(),
      ...(activeProviderRevision ? { providerRevision: activeProviderRevision } : {}),
    };
    const finalPayload: RetryTaskPayload = {
      ...payload,
      ai: desiredAi,
      // lineage를 생성 시점에 세팅 — 사후 UPDATE 비원자성으로 인한 retry cap 우회 방지
      parentTaskId: sourceTaskId,
      prompt: finalPrompt,
      metadata: finalRetryMetadata,
    };

    const created = await app.inject({ method: 'POST', url: '/api/task', payload: finalPayload });
    const body = created.json() as { taskId?: string; error?: string; deduplicated?: boolean };
    if (created.statusCode >= 400 || !body.taskId) {
      rollbackRetryReservation(db, sourceTaskId);
      return { ok: false, statusCode: created.statusCode, body: body as Record<string, unknown> };
    }

    // workReportId idempotency가 이미 실행 중인 형제를 돌려준 경우 실제 새 시도는 없었다.
    // 이 응답을 성공으로 추적하되 retry budget을 소비하거나 "새 태스크"라고 기록하지 않는다.
    if (body.deduplicated === true) {
      rollbackRetryReservation(db, sourceTaskId);
      bindKanbanRetryTask(taskId, body.taskId);
      return {
        ok: true,
        newTaskId: body.taskId,
        sourceTaskId,
        retryCount: Math.max(0, retryReservation.count - 1),
        deduplicated: true,
      };
    }

    // parent_task_id는 finalPayload.parentTaskId로 생성 시점에 세팅됨 (원자성 — 사후 UPDATE 제거)
    bindKanbanRetryTask(taskId, body.taskId);
    return { ok: true, newTaskId: body.taskId, sourceTaskId, retryCount: retryReservation.count };
  };

  /**
   * 좌초된 활성 태스크를 retry 계약으로 교체한다.
   *
   * 일반 cancel 경로는 workflow stage까지 cancelled로 닫기 때문에 교체 실행에 쓸 수 없다.
   * 여기서는 retry 입력/프로바이더/예산을 먼저 검증·예약하고 원본을 failed로 종결한 뒤
   * 워커를 중단한다. 새 태스크 생성이 실패해도 원본은 canonical retry가 가능한 failed로
   * 남고 createRetryTask가 예약을 되돌리므로, "원본은 취소됐고 교체본도 없음" 상태가 없다.
   * workflow stage는 새 태스크 생성의 attachWorkflowTask가 동일 stage의 task_id를 넘겨받는다.
   */
  const replaceActiveTask = async (
    taskId: string,
    options: Pick<RetryTaskOptions, 'overrideAi' | 'overridePrompt'>,
  ): Promise<RetryTaskResult> => {
    const db = getDb();
    const row = db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as
      | { status: string }
      | undefined;
    if (!row) {
      return { ok: false, statusCode: 404, body: { error: 'Retry source not found' } };
    }
    if (row.status === 'failed' || row.status === 'timed_out' || row.status === 'lease_expired') {
      // 조회와 요청 사이에 자연 종료된 경우에는 일반 terminal retry로 안전하게 수렴한다.
      const created = await createRetryTask(taskId, options);
      return created.ok ? { ...created, replacedActive: true } : created;
    }
    const replaceableStatuses = new Set(['pending', 'queued', 'assigned', 'running', 'streaming', 'reviewing']);
    if (!replaceableStatuses.has(row.status)) {
      return {
        ok: false,
        statusCode: 409,
        body: { error: 'active retry source is not replaceable', status: row.status },
      };
    }

    // 상태를 바꾸기 전에 payload와 provider를 검증한다. 이 단계의 실패는 원본에 무해하다.
    if (!loadRetryPayload(db, taskId, { allowActiveSource: true })) {
      return { ok: false, statusCode: 404, body: { error: 'Retry source not found' } };
    }
    const overrideValidation = validateRetryOverrideAgent(options.overrideAi);
    if (!overrideValidation.ok) {
      return { ok: false, statusCode: 400, body: overrideValidation.body };
    }

    const sourceTaskId = resolveRetrySourceTaskId(db, taskId);
    const reservation = reserveRetry(db, sourceTaskId);
    if (!reservation.allowed) {
      return {
        ok: false,
        statusCode: 429,
        body: {
          error: 'retry limit exceeded',
          reason: reservation.reason,
          count: reservation.count,
          totalCount: reservation.totalCount,
        },
      };
    }
    const reservedRetry: ReservedRetry = { ...reservation, sourceTaskId };

    const moved = transitionTask(db, taskId, 'failed', {
      error: 'replaced by explicit active-task recovery retry',
      completedAt: true,
    });
    if (!moved.ok) {
      rollbackRetryReservation(db, sourceTaskId);
      return {
        ok: false,
        statusCode: 409,
        body: { error: 'active retry source changed status', status: moved.prev },
      };
    }

    try {
      // false는 이미 로컬 실행기가 사라진 좌초 작업이라는 뜻이라 교체를 계속해도 안전하다.
      await taskQueue.abort(taskId);
    } catch (error) {
      rollbackRetryReservation(db, sourceTaskId);
      void app.settlePersistedTaskTerminal(taskId).catch(settleError => log.warn({
        taskId,
        err: settleError instanceof Error ? settleError.message : String(settleError),
      }, 'Failed to settle active retry source after worker abort failure'));
      return {
        ok: false,
        statusCode: 503,
        body: {
          error: 'active retry could not stop the source worker',
          detail: error instanceof Error ? error.message : String(error),
          sourceStatus: 'failed',
          retryable: true,
        },
      };
    }

    const created = await createRetryTask(taskId, { ...options, reservedRetry });
    if (!created.ok) {
      void app.settlePersistedTaskTerminal(taskId).catch(error => log.warn({
        taskId,
        err: error instanceof Error ? error.message : String(error),
      }, 'Failed to settle active retry source after replacement dispatch failure'));
    }
    return created.ok ? { ...created, replacedActive: true } : created;
  };

  let projectKanbanTaskStatusRef: ((taskId: string, status?: string) => boolean) | null = null;
  const projectKanbanTaskStatus = (taskId: string, status?: string): void => {
    try {
      projectKanbanTaskStatusRef?.(taskId, status);
    } catch (error) {
      log.warn({
        taskId,
        status,
        err: error instanceof Error ? error.message : String(error),
      }, 'Canonical task could not be projected to Kanban');
    }
  };

  try {
    const { kanbanEngine } = await import('../core/kanban-engine.js');
    kanbanEngine.createTaskRef = async (input) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/task',
        payload: {
          ai: input.agentId,
          prompt: input.prompt,
          model: input.model,
          systemPrompt: input.systemPrompt,
          timeout: input.timeoutMs,
          priority: input.priority,
          verifier: input.verifier,
          requiredEvidence: input.requiredEvidence,
          metadata: {
            ...(input.metadata ?? {}),
            kanbanTaskId: input.kanbanTaskId,
            kanbanPlanId: input.planId,
            allowProviderFailover: true,
          },
        },
      });
      const body = response.json() as Record<string, unknown>;
      if (response.statusCode === 202 && typeof body.taskId === 'string') {
        return { ok: true, newTaskId: body.taskId };
      }
      return {
        ok: false,
        statusCode: response.statusCode,
        body,
      };
    };
    kanbanEngine.createRetryTaskRef = createRetryTask;
    kanbanEngine.replaceActiveTaskRef = (taskId: string) => {
      const sourceTaskId = resolveRetrySourceTaskId(getDb(), taskId);
      return withRetryLock(sourceTaskId, () => replaceActiveTask(taskId, {}));
    };
    projectKanbanTaskStatusRef = (taskId, status) => kanbanEngine.projectTaskStatus(taskId, status);
    bindKanbanRetryTaskRef = (sourceTaskId, newTaskId) => kanbanEngine.bindRetryTask(sourceTaskId, newTaskId);
  } catch (err) {
    log.error({ err }, 'Failed to bind retry task refs to kanbanEngine');
  }

  const scheduleTaskFailover = async (
    taskId: string,
    failure: { status?: string | null; error?: string | null; response?: string | null },
  ): Promise<void> => {
    const recordSkip = (reason: string, deadLetter = false): void => {
      logDecision({
        taskId,
        phase: 'failover',
        decision: 'skip',
        reason,
        evidenceTier: 'T1',
      });
      recordLearningEvent({
        agentId: 'system',
        eventType: 'failover_skip',
        pattern: reason,
        context: { taskId, deadLetter },
      });
      log.warn({ taskId, reason, deadLetter }, 'Automatic task failover skipped');
      if (!deadLetter) return;
      try {
        const db = getDb();
        db.prepare(`
          INSERT INTO dead_letter_tasks (task_id, ai, prompt, reason)
          SELECT id, assigned_to, prompt, ?
          FROM tasks
          WHERE id=?
            AND NOT EXISTS (
              SELECT 1 FROM dead_letter_tasks
              WHERE task_id=? AND reason=?
            )
        `).run('failover_exhausted', taskId, taskId, 'failover_exhausted');
      } catch (error) {
        log.warn({
          taskId,
          error: error instanceof Error ? error.message : String(error),
        }, 'Failed to persist failover dead-letter evidence');
      }
    };

    if ((process.env.NCO_AUTO_FAILOVER ?? 'on').toLowerCase() === 'off') {
      recordSkip('auto_failover_disabled');
      return;
    }
    if (!isRetryableFailoverFailure(failure)) {
      recordSkip('non_retryable_policy_or_non_failure');
      return;
    }

    const chains = loadFailoverChainsConfig();
    if (!chains) {
      recordSkip('failover_config_unavailable', true);
      return;
    }

    const db = getDb();
    const taskRow = db.prepare(`
      SELECT id, status, parent_task_id, assigned_to, metadata_json
      FROM tasks
      WHERE id=?
    `).get(taskId) as {
      id: string;
      status: string;
      parent_task_id: string | null;
      assigned_to: string | null;
      metadata_json: string | null;
    } | undefined;
    if (!taskRow) {
      recordSkip('source_task_missing', true);
      return;
    }
    if (!taskRow.assigned_to) {
      recordSkip('source_agent_missing', true);
      return;
    }
    if (!isAutomaticProviderFailoverAllowed(taskRow.metadata_json)) {
      recordSkip('provider_failover_opted_out');
      return;
    }
    if (taskRow.status === 'cancelled') {
      recordSkip('source_task_cancelled');
      return;
    }
    if (TERMINAL_STATES.has(taskRow.status)
      && taskRow.status !== 'failed'
      && taskRow.status !== 'timed_out'
      && taskRow.status !== 'lease_expired') {
      recordSkip(`source_terminal:${taskRow.status}`);
      return;
    }

    const sourceTaskId = resolveRetrySourceTaskId(db, taskRow.id);
    const attemptedAgents = loadRetryLineageAssignedAgents(db, sourceTaskId);
    const toAgent = selectFailoverCandidate({
      chain: chains[taskRow.assigned_to] ?? chains.default,
      preferred: loadTeamRosterForTask(db, taskId),
      attemptedAgents,
      isAvailable: (candidate) => {
        if (!agentManager.getProvider(candidate) || !agentManager.listEnabledIds().includes(candidate)) return false;
        return circuitBreakerRegistry.getAvailability(candidate).available;
      },
    });
    if (!toAgent) {
      recordSkip('failover_exhausted:no_available_unattempted_candidate', true);
      return;
    }

    // provider 종료 콜백과 lease sweeper가 같은 순간 failover를 요청할 수 있다.
    // HTTP 수동 retry와 같은 root lock을 공유해 둘 다 활성 자식 없음으로 판단하는 TOCTOU를 닫는다.
    const created = await withRetryLock(
      sourceTaskId,
      () => createRetryTask(taskId, { overrideAi: toAgent }),
    );
    if (!created.ok) {
      const failureReason = typeof created.body.reason === 'string'
        ? created.body.reason
        : typeof created.body.error === 'string'
          ? created.body.error
          : `http_${created.statusCode}`;
      recordSkip(
        `failover_dispatch_rejected:${failureReason}`,
        true,
      );
      return;
    }
    if (created.deduplicated) {
      recordSkip('failover_deduplicated_existing_retry');
      return;
    }

    recordLearningEvent({
      agentId: toAgent,
      eventType: 'failover_dispatch',
      pattern: failure.error ?? failure.status ?? 'retryable_failure',
      context: {
        taskId: created.newTaskId,
        sourceTaskId,
        fromAgent: taskRow.assigned_to,
        toAgent,
        retryCount: created.retryCount,
      },
    });
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

  const stopLeaseSweeper = startLeaseSweeper({
    onLeaseExpired: async (taskId: string, reason: LeaseSweepReason) => {
      // DB terminal 상태가 먼저 확정된 뒤 queue/controller를 해제한다. 늦게 끝난 provider
      // 콜백은 task-state 가드에서 거부되며, failover는 아래 root lock에서 단일화된다.
      try {
        const released = await taskQueue.abort(taskId);
        if (released) {
          log.info({ taskId, reason }, 'Released expired task execution before failover');
        }
      } catch (error) {
        // 실행기 정리가 부분 실패해도 다른 provider로의 bounded failover까지 막지는 않는다.
        log.warn({
          taskId,
          reason,
          err: error instanceof Error ? error.message : String(error),
        }, 'Expired task execution release failed; continuing failover');
      }
      // lease transition은 provider 완료 콜백 바깥에서 일어나므로 일반 terminal sync를
      // 거치지 않는다. 먼저 source workflow를 실패로 닫고, 아래 retry 생성이 성공하면
      // attachWorkflowTask가 같은 stage를 새 task_id로 깨끗하게 다시 연다.
      try {
        syncWorkflowTask(taskId, 'failed', { error: reason }, getDb());
      } catch (error) {
        log.warn({
          taskId,
          reason,
          err: error instanceof Error ? error.message : String(error),
        }, 'Failed to sync expired task with workflow');
      }
      projectKanbanTaskStatus(taskId, 'lease_expired');
      if (reason === 'lease_expired_twice' || reason === 'claim_timeout_twice') {
        // 계보당 자동 대체는 한 번으로 제한하지만, 두 번째 만료의 원본 프로세스/큐는
        // 반드시 위에서 해제한다. 이 지점에서 다시 scheduleTaskFailover를 호출하면
        // lease cap을 우회하므로 workflow만 최종 실패로 동기화한다.
        log.warn({ taskId, reason }, 'Expired task retry lineage exhausted; execution released');
        return;
      }
      await scheduleTaskFailover(taskId, {
        status: 'lease_expired',
        error: reason,
        response: null,
      });
    },
  });
  app.addHook('onClose', async () => {
    stopLeaseSweeper();
  });

  const handleCompletedTaskQualityGate = async (taskId: string, response: string): Promise<void> => {
    const db = getDb();
    const taskRow = db.prepare(`
      SELECT status, assigned_to, verifier_json, parent_task_id, metadata_json, prompt
      FROM tasks
      WHERE id=?
    `).get(taskId) as {
      status: string;
      assigned_to: string | null;
      verifier_json: string | null;
      parent_task_id: string | null;
      metadata_json: string | null;
      prompt: string;
    } | undefined;
    if (!taskRow) return;

    const companyOwnsRetry = isCompanyOrchestratorQualityRetryOwner(taskRow.metadata_json);
    const quality = checkResponseQuality(response, {
      requireProtocolPrefix: hasResponseContract(taskRow.prompt),
      rejectToolEchoes: companyOwnsRetry,
    });
    if (quality.pass) {
      try {
        recordTeamDiagnosticOutcome(db, taskId, response);
      } catch (error) {
        log.error(
          { err: error instanceof Error ? error.message : String(error), taskId },
          'Failed to record team diagnostic improvement note',
        );
      }
      return;
    }

    updateTaskQualityMetadata(db, taskId, quality.heuristics);
    recordLearningEvent({
      agentId: taskRow.assigned_to ?? 'system',
      eventType: 'quality_reject',
      pattern: quality.heuristics.join(','),
      context: { taskId, companyOwnsRetry },
    });
    const qualityError = `quality_rejected: ${quality.heuristics.join(',')}`;
    if (companyOwnsRetry) {
      const demoted = markTaskQualityRejected(db, taskId, quality.heuristics);
      if (demoted) {
        // 회사 오케스트레이터가 재시도 owner여도 reviewing 상태를 종결해야
        // waitForTask()가 실패를 관측하고 다음 실행자로 failover할 수 있다.
        syncWorkflowTask(taskId, 'failed', { error: qualityError }, db);
      }
      log.info(
        { taskId, heuristics: quality.heuristics, demoted },
        'Quality retry delegated to company orchestrator',
      );
      return;
    }

    const demoted = markTaskQualityRejected(db, taskId, quality.heuristics);
    if (demoted) {
      // Execution completion is provisional until this quality gate finishes.
      // Keep the durable workflow stage aligned with the final task state so
      // a rejected result cannot appear as a completed implementation.
      syncWorkflowTask(taskId, 'failed', { error: qualityError }, db);
    }
    if (!demoted) {
      log.warn(
        { taskId, heuristics: quality.heuristics },
        'Quality-rejected task was no longer completed; retry still evaluated from current state',
      );
    }

    // `allowProviderFailover:false` is an explicit caller contract, not merely
    // a hint for execution failures. The quality-gate path also selects another
    // provider below, so it must honor the same opt-out before creating a child.
    if (!isAutomaticProviderFailoverAllowed(taskRow.metadata_json)) {
      logDecision({
        taskId,
        phase: 'quality-gate',
        decision: 'skip',
        reason: 'provider_failover_opted_out',
        evidenceTier: 'T1',
      });
      recordLearningEvent({
        agentId: taskRow.assigned_to ?? 'system',
        eventType: 'failover_skip',
        pattern: 'provider_failover_opted_out',
        context: { taskId, qualityHeuristics: quality.heuristics },
      });
      log.warn(
        { taskId, heuristics: quality.heuristics },
        'Quality retry skipped because provider failover was explicitly disabled',
      );
      return;
    }

    // 같은 프로바이더 재시도는 quota/고장 상태에서 cap 3을 전소시킴 (E2E 실측 2026-07-03:
    // codex quota 중 ERROR_MARKER reject가 codex로 3연속 재배정) — 실패 failover와 동일한
    // 체인 선택기를 재사용해 미시도·가용 에이전트로 라우팅. 후보 없으면 기존대로 같은 ai 재시도.
    let toAgent: string | undefined;
    if (taskRow.assigned_to) {
      const chains = loadFailoverChainsConfig();
      if (chains) {
        const sourceTaskId = resolveRetrySourceTaskId(db, taskId);
        const attemptedAgents = loadRetryLineageAssignedAgents(db, sourceTaskId);
        toAgent = selectFailoverCandidate({
          chain: chains[taskRow.assigned_to] ?? chains.default,
          preferred: loadTeamRosterForTask(db, taskId),
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
      reason: qualityError,
    });
    if (!created.ok) {
      log.warn({ taskId, heuristics: quality.heuristics, statusCode: created.statusCode, body: created.body }, 'Quality gate rejected completed task but retry creation failed');
      return;
    }

    logDecision({ taskId, phase: 'quality-gate', decision: 'gate:quality_reject', reason: quality.heuristics.join(',') });
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

  app.settlePersistedTaskTerminal = async (taskId: string): Promise<void> => {
    const db = getDb();
    const row = db.prepare(`
      SELECT k.status, k.response, k.error, k.evidence_json, k.team_id,
        k.assigned_to, k.prompt, k.metadata_json, t.organization_id
      FROM tasks k
      LEFT JOIN teams t ON t.id=k.team_id
      WHERE k.id=?
    `).get(taskId) as {
      status: string;
      response: string | null;
      error: string | null;
      evidence_json: string | null;
      team_id: string | null;
      assigned_to: string | null;
      prompt: string;
      metadata_json: string | null;
      organization_id: string | null;
    } | undefined;
    if (!row) return;

    if (row.status !== 'reviewing') {
      syncWorkflowTask(taskId, row.status, {
        error: row.error,
        evidence: row.status === 'completed'
          ? safeJsonParse(row.evidence_json ?? '{}')
          : undefined,
      }, db);
    }

    if (row.status !== 'completed' && row.status !== 'reviewing') {
      projectKanbanTaskStatus(taskId, row.status);
      return;
    }

    // Quality is authoritative and must finish before an organization audit is
    // requested. Otherwise a rejected response can race into the audit queue.
    await handleCompletedTaskQualityGate(taskId, row.response ?? '');

    const current = db.prepare(`
      SELECT status, metadata_json
      FROM tasks
      WHERE id=?
    `).get(taskId) as {
      status: string;
      metadata_json: string | null;
    } | undefined;
    if (current) {
      projectKanbanTaskStatus(taskId, current.status);
    }
    if (current?.status !== 'reviewing' || !row.team_id || !row.organization_id) return;

    const metadata = parseTaskMetadata(current.metadata_json);
    if (metadata.verificationStatus === 'approved') return;
    await notifyNovaAxAuditRequired({
      taskId,
      companyId: row.organization_id,
      teamId: row.team_id,
      actorId: row.assigned_to || 'nco',
      prompt: row.prompt,
    });
    markTaskAuditQueued(taskId);
  };

  await app.register(cors, {
    origin: [
      'http://localhost:6200', 'http://127.0.0.1:6200',
      'http://localhost:3000', 'http://127.0.0.1:3000',
      /^http:\/\/localhost:\d+$/,
    ],
  });

  app.post('/api/learning/patterns/invalidate', async (request, reply) => {
    const parsed = z.object({
      pattern: z.string().min(1).max(500),
      actor: z.string().min(1).max(100).optional(),
      reason: z.string().min(1).max(500).optional(),
    }).safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'pattern is required',
        details: parsed.error.issues,
      };
    }

    const invalidated = invalidateLearnedCircuitPattern(parsed.data.pattern, {
      actor: parsed.data.actor,
      reason: parsed.data.reason,
    });
    if (!invalidated) {
      reply.code(404);
      return { error: 'learned circuit pattern not found' };
    }
    return {
      ok: true,
      pattern: parsed.data.pattern.trim(),
      invalidated: true,
    };
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
  //
  // 2026-07-31: /health 는 "가벼운" 엔드포인트가 아니었다. Redis 왕복을 하는 유일한 라우트라
  // Redis 가 흔들리면 순수 SQLite 라우트(/api/organizations 0.735s, /api/teams 0.235s)는
  // 멀쩡한데 /health 만 7.8~25초로 늘어졌다. 이 "역전"을 이벤트루프 블로킹으로 오진했었다.
  // 실제 기전은 I/O 대기다: redis.ts:18 retryStrategy(times*200ms) 누적이 8회에 7.20초로,
  // 관측된 7.78초(회차 편차 ±0.06초)와 일치한다 — 디스크 I/O 편차가 아니라 고정 재시도 상수의 지문.
  //
  // 헬스체크는 "빠르게 사실을 말하는 것"이 임무다. 느린 의존성 때문에 매달리면 감시자가
  // 프로세스를 죽었다고 오판해 재시작을 부르고, 그 재시작이 in-flight 를 파괴한다(실제로 반복됐다).
  // 그래서 데드라인을 두고, 초과하면 degraded 로 **즉시** 답한다.
  const HEALTH_DEADLINE_MS = Number(process.env.NCO_HEALTH_DEADLINE_MS) || 1_500;
  const withDeadline = async <T>(work: Promise<T>, fallback: T): Promise<{ value: T; timedOut: boolean }> => {
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<'__timeout__'>(resolve => {
      timer = setTimeout(() => resolve('__timeout__'), HEALTH_DEADLINE_MS);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([work, guard]);
      if (outcome === '__timeout__') return { value: fallback, timedOut: true };
      return { value: outcome as T, timedOut: false };
    } catch {
      return { value: fallback, timedOut: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  type ProviderReadinessAssessment = {
    response: {
      revision: string;
      generatedAt: string;
      observations: {
        queueMetricsTimedOut: boolean;
        heartbeatTimedOut: boolean;
        inferenceEvidence: string;
        admissionSemantics: string;
      };
      providers: ProviderReadinessResult[];
    };
    byProvider: Map<string, ProviderReadinessResult>;
    roleByProvider: Map<string, string>;
  };

  /** One data-only assessment shared by provider discovery and task admission. */
  const assessProviderReadiness = async (
    snapshot: ProviderRegistrySnapshot,
  ): Promise<ProviderReadinessAssessment> => {
    const [queueResult, heartbeatResult] = await Promise.all([
      withDeadline(taskQueue.getMetrics(), []),
      withDeadline(
        Promise.all(snapshot.providers.map(async provider => [
          provider.id,
          await sharedState.isAgentAlive(provider.id),
        ] as const)).then(entries => Object.fromEntries(entries) as Record<string, boolean>),
        {} as Record<string, boolean>,
      ),
    ]);
    const queueByProvider = new Map(queueResult.value.map(metric => [metric.agentId, metric]));
    const generatedAt = new Date();
    const providers = snapshot.providers.map(provider => {
      const queue = queueByProvider.get(provider.id);
      let admission: { available: boolean | null; reason?: string | null };
      if (!provider.enabled) {
        admission = { available: false, reason: 'provider-disabled' };
      } else {
        try {
          const availability = circuitBreakerRegistry.getAvailability(provider.id);
          admission = { available: availability.available, reason: availability.reason };
        } catch {
          admission = { available: null, reason: 'availability-check-failed' };
        }
      }

      return evaluateProviderReadiness({
        providerId: provider.id,
        registration: { registered: true },
        runtimeLoaded: { loaded: provider.runtime.loaded },
        heartbeat: {
          alive: heartbeatResult.timedOut
            ? null
            : heartbeatResult.value[provider.id] ?? false,
        },
        admission,
        queueCapacity: queue
          ? {
              available: queue.active < queue.concurrency,
              active: queue.active,
              concurrency: queue.concurrency,
            }
          : { available: null },
        // Emitted only after AgentManager validates a real model/CLI completion.
        inferenceEvidence: circuitBreakerRegistry.getInferenceEvidence(provider.id),
      }, { now: generatedAt });
    });

    return {
      response: {
        revision: snapshot.revision,
        generatedAt: generatedAt.toISOString(),
        observations: {
          queueMetricsTimedOut: queueResult.timedOut,
          heartbeatTimedOut: heartbeatResult.timedOut,
          inferenceEvidence: 'process-local-success-receipts',
          admissionSemantics: 'only-missing-inference-evidence-is-a-bootstrap-exception',
        },
        providers,
      },
      byProvider: new Map(providers.map(provider => [provider.providerId, provider])),
      roleByProvider: new Map(snapshot.providers.map(provider => [provider.id, provider.role])),
    };
  };

  // providerCount는 agentManager의 부팅 시점 스냅샷이라, config를 고치고 아직
  // 재기동하지 않았거나 반대로 감시자 쪽 스냅샷이 오래된 경우 "프로바이더가
  // 사라졌다"는 오탐을 만든다(2026-07-30~31 registry-anomaly 16회 연속 오탐).
  // 개수 대신 id 차집합을 함께 노출해 감시자가 무엇이 빠졌는지 바로 알게 한다.
  // loadEnabledProviders()는 동기 파일 I/O이므로 TTL 캐시로 /health 핫패스를 지킨다.
  const PROVIDER_DRIFT_TTL_MS = 30_000;
  let providerDriftCache: { at: number; enabledInConfig: string[]; missing: string[] } | null = null;

  const providerRegistryDrift = (): { enabledInConfig: string[]; missing: string[] } => {
    const cached = providerDriftCache;
    if (cached && Date.now() - cached.at < PROVIDER_DRIFT_TTL_MS) {
      return { enabledInConfig: cached.enabledInConfig, missing: cached.missing };
    }
    const registered = new Set(agentManager.listEnabledIds());
    let enabledInConfig: string[];
    try {
      enabledInConfig = loadEnabledProviders().map(p => p.id);
    } catch {
      // 설정이 일시적으로 깨져도 /health는 살아 있어야 한다 — 마지막 값/등록분으로 폴백
      enabledInConfig = cached?.enabledInConfig ?? [...registered];
    }
    const missing = enabledInConfig.filter(id => !registered.has(id));
    providerDriftCache = { at: Date.now(), enabledInConfig, missing };
    return { enabledInConfig, missing };
  };

  app.get('/health', async () => {
    // 두 의존성을 직렬로 기다리면 1.5초 데드라인이 합산돼 최악 3초가 된다.
    // 병렬 시작해 라우트 전체의 의존성 대기를 HEALTH_DEADLINE_MS 한 번으로 제한한다.
    const [agentsResult, redisResult] = await Promise.all([
      withDeadline(sharedState.getAllAgentStates(), {} as Record<string, { status: string }>),
      withDeadline(redisHealthCheck(), false),
    ]);
    const agents = agentsResult.value;
    const redisOk = redisResult.value;
    const degraded = agentsResult.timedOut || redisResult.timedOut;
    const drift = providerRegistryDrift();
    const providerAvailability = summarizeProviderAvailability(
      agentManager.listEnabledIds(),
      id => circuitBreakerRegistry.getAvailability(id),
    );
    if (degraded) {
      return {
        status: 'degraded',
        service: 'nco-backend',
        version: '1.0.0',
        ports: { api: env.PORT, ws: env.WS_PORT },
        providerCount: agentManager.listEnabledIds().length,
        providersEnabledInConfig: drift.enabledInConfig.length,
        providersMissing: drift.missing,
        providerAvailability,
        runtime: {
          redis: redisOk,
          agentsOnline: Object.values(agents).filter(a => a.status !== 'offline').length,
          uptime: process.uptime(),
          // 감시자가 "프로세스가 죽었다"로 오판하지 않도록 무엇이 느린지 명시한다.
          slow: [
            agentsResult.timedOut ? 'agent-states(redis)' : null,
            redisResult.timedOut ? 'redis-ping' : null,
          ].filter(Boolean),
          deadlineMs: HEALTH_DEADLINE_MS,
        },
        timestamp: new Date().toISOString(),
      };
    }
    return {
      status: 'healthy',
      service: 'nco-backend',
      version: '1.0.0',
      ports: { api: env.PORT, ws: env.WS_PORT },
      providerCount: agentManager.listEnabledIds().length,
      providersEnabledInConfig: drift.enabledInConfig.length,
      providersMissing: drift.missing,
      providerAvailability,
      runtime: {
        redis: redisOk,
        agentsOnline: Object.values(agents).filter(a => a.status !== 'offline').length,
        uptime: process.uptime(),
      },
      timestamp: new Date().toISOString(),
    };
  });

  app.get('/api/health', async () => {
    const redisResult = await withDeadline(redisHealthCheck(), false);
    return {
      healthy: true,
      api: { port: env.PORT },
      websocket: { port: env.WS_PORT },
      redis: {
        connected: redisResult.value,
        slow: redisResult.timedOut,
        deadlineMs: HEALTH_DEADLINE_MS,
      },
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
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error), name, action }, 'Fleet action failed');
      reply.code(400);
      return { error: 'Fleet action failed', statusCode: 400 };
    }
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
  app.get('/api/ai-providers/registry', async (request, reply) => {
    const snapshot = providerRuntimeCoordinator.getSnapshot();
    if (!snapshot) {
      reply.code(503);
      return { error: 'provider_registry_unavailable' };
    }
    const etag = `"${snapshot.revision}"`;
    reply.header('ETag', etag);
    reply.header('Cache-Control', 'no-cache');
    const ifNoneMatch = request.headers['if-none-match'];
    const requestedEtags = (Array.isArray(ifNoneMatch) ? ifNoneMatch : [ifNoneMatch])
      .filter((value): value is string => typeof value === 'string')
      .flatMap((value: string) => value.split(',').map((item: string) => item.trim()));
    if (requestedEtags.includes(etag) || requestedEtags.includes('*')) {
      return reply.code(304).send();
    }
    return snapshot;
  });

  app.get('/api/ai-providers/readiness', async (_request, reply) => {
    const snapshot = providerRuntimeCoordinator.getSnapshot();
    if (!snapshot) {
      reply.code(503);
      return { error: 'provider_registry_unavailable' };
    }
    return (await assessProviderReadiness(snapshot)).response;
  });

  app.get('/api/ai-providers', async () => {
    const snapshot = providerRuntimeCoordinator.getSnapshot();
    if (!snapshot) return { providers: [] };
    const states = await sharedState.getAllAgentStates();
    const providers = snapshot.providers.filter(manifest => manifest.enabled).map(manifest => ({
      ...toLegacyProviderCatalogProjection(manifest),
      status: states[manifest.id]?.status || 'offline',
      ai_status: states[manifest.id]?.status || 'offline',
      health: states[manifest.id]?.health || {
        consecutiveFailures: 0,
        circuitState: 'closed',
        lastError: null,
      },
    }));
    return { providers };
  });

  app.get('/api/ai-providers/enabled', async () => {
    const snapshot = providerRuntimeCoordinator.getSnapshot();
    if (!snapshot) return { providers: [] };
    const states = await sharedState.getAllAgentStates();
    const providers = snapshot.providers.filter(manifest => manifest.enabled).map(manifest => ({
      ...toLegacyProviderCatalogProjection(manifest),
      status: states[manifest.id]?.status || 'offline',
      health: states[manifest.id]?.health || {
        consecutiveFailures: 0,
        circuitState: 'closed',
        lastError: null,
      },
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
    const requestMetadata = input.metadata ?? {};
    const idempotencyKey = typeof requestMetadata.idempotencyKey === 'string'
      ? requestMetadata.idempotencyKey.trim()
      : '';
    if (idempotencyKey.length > 256) {
      reply.code(400);
      return { error: 'invalid_idempotency_key', detail: 'metadata.idempotencyKey exceeds 256 characters' };
    }
    const idempotencyRequestFingerprint = idempotencyKey
      ? createTaskRequestFingerprint(input)
      : '';
    const body = req.body as Record<string, unknown>;
    let callerSessionId = typeof body.callerSessionId === 'string'
      ? body.callerSessionId
      : (req.headers['x-nco-session-id'] as string | undefined) ?? 'unknown';
    let callerAgentId = typeof body.callerAgentId === 'string' ? body.callerAgentId : 'unknown';
    const db = getDb();
    if ((callerAgentId === 'unknown' || callerSessionId === 'unknown') && input.parentTaskId) {
      const parent = db.prepare('SELECT spawned_by_cli FROM tasks WHERE id=?')
        .get(input.parentTaskId) as { spawned_by_cli?: string | null } | undefined;
      const inherited = parent?.spawned_by_cli;
      if (inherited) {
        if (callerAgentId === 'unknown') callerAgentId = inherited;
        if (callerSessionId === 'unknown') callerSessionId = inherited;
      }
    }
    const spawnedByCli = callerAgentId !== 'unknown' ? callerAgentId
      : callerSessionId !== 'unknown' ? callerSessionId
      : null;

    // Exact network replays must recover the original task even when the
    // registry revision advanced or the original absolute deadline elapsed.
    // Payload mismatch is still rejected before any mutable intake side effect.
    if (idempotencyKey) {
      const callerScope = spawnedByCli ?? '';
      const reservation = db.prepare(`
        SELECT i.task_id, i.request_fingerprint, t.assigned_to, t.status
        FROM task_idempotency_keys i
        JOIN tasks t ON t.id=i.task_id
        WHERE i.caller_scope=? AND i.idempotency_key=?
      `).get(callerScope, idempotencyKey) as TaskIdempotencyReservation | undefined;
      if (reservation) {
        if (reservation.request_fingerprint !== idempotencyRequestFingerprint) {
          reply.code(409);
          return { error: 'idempotency_key_payload_conflict', taskId: reservation.task_id };
        }
        reply.code(202);
        return {
          taskId: reservation.task_id,
          agentId: reservation.assigned_to,
          status: reservation.status,
          deduplicated: true,
        };
      }

      const legacyTask = db.prepare(`
        SELECT id
        FROM tasks
        WHERE json_valid(COALESCE(metadata_json, ''))
          AND json_extract(metadata_json, '$.idempotencyKey') = ?
          AND COALESCE(spawned_by_cli, '') = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(idempotencyKey, callerScope) as { id: string } | undefined;
      if (legacyTask) {
        reply.code(409);
        return {
          error: 'idempotency_key_unverifiable_legacy_payload',
          taskId: legacyTask.id,
        };
      }
    }
    const rawProviderRevision = requestMetadata.providerRevision;
    if (
      rawProviderRevision !== undefined
      && (
        typeof rawProviderRevision !== 'string'
        || rawProviderRevision.trim().length === 0
      )
    ) {
      reply.code(400);
      return {
        error: 'invalid_provider_revision',
        detail: 'metadata.providerRevision must be a non-empty registry revision string',
      };
    }
    const requestedProviderRevision = typeof rawProviderRevision === 'string'
      ? rawProviderRevision.trim()
      : '';
    const activeProviderRevision = providerRuntimeCoordinator.getSnapshot()?.revision ?? '';
    if (
      requestedProviderRevision
      && activeProviderRevision
      && requestedProviderRevision !== activeProviderRevision
    ) {
      reply.code(409);
      return {
        error: 'provider_registry_revision_conflict',
        requestedRevision: requestedProviderRevision,
        activeRevision: activeProviderRevision,
      };
    }
    const rawDeadlineAt = requestMetadata.deadlineAt;
    if (rawDeadlineAt !== undefined && typeof rawDeadlineAt !== 'string') {
      reply.code(400);
      return { error: 'invalid_deadline', detail: 'metadata.deadlineAt must be an ISO-8601 string' };
    }
    if (typeof rawDeadlineAt === 'string') {
      const deadlineMs = Date.parse(rawDeadlineAt);
      const remainingMs = deadlineMs - Date.now();
      if (!Number.isFinite(deadlineMs) || remainingMs < 2_000) {
        reply.code(408);
        return { error: 'task_deadline_expired', deadlineAt: rawDeadlineAt };
      }
      const requestedQueueMs = Number(requestMetadata.queueWaitMaxMs);
      const queueBudgetMs = Math.min(
        Number.isFinite(requestedQueueMs) && requestedQueueMs > 0 ? requestedQueueMs : 30_000,
        Math.max(1_000, remainingMs - 1_000),
      );
      const requestedExecutionMs = Number(input.timeout ?? 120_000);
      const executionBudgetMs = Math.min(
        Number.isFinite(requestedExecutionMs) && requestedExecutionMs > 0
          ? requestedExecutionMs
          : 120_000,
        Math.max(1_000, remainingMs - queueBudgetMs),
      );
      input.metadata = {
        ...requestMetadata,
        deadlineAt: new Date(deadlineMs).toISOString(),
        queueWaitMaxMs: Math.trunc(queueBudgetMs),
      };
      input.timeout = Math.trunc(executionBudgetMs);
    }
    let promptGate: PromptGateInfo | undefined;
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
    if (shouldApplyPromptGateForProvider(input.ai)) {
      try {
        const promptGateApplied = applyPromptGate(input.prompt, input.metadata);
        input.prompt = promptGateApplied.prompt;
        promptGate = promptGateApplied.promptGate;
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Prompt gate failed during task intake');
      }
    }
    // GATE-COLLAB-C3-R1: done:/status:/error:/question: 프로토콜 응답을 새 태스크로
    // 재변환하지 않는다 (cycle1: company-orchestrator 30건 재변환 T1).
    // 롤백: NCO_PROTOCOL_RECONVERSION_GATE=off
    if (isProtocolReconversionGateEnabled() && isProtocolReconversionPrompt(input.prompt)) {
      reply.code(409);
      return {
        error: 'protocol_reconversion_blocked',
        detail: 'Protocol reply (done:/status:/error:/question:) cannot be converted into a new task. Use buildProtocolSafeHandoff or pass a current-stage instruction.',
      };
    }
    try {
      const defaultVerifier = buildDefaultVerifier(input);
      if (defaultVerifier && !input.verifier) {
        input.verifier = defaultVerifier;
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Default verifier assignment failed during task intake');
    }
    // P2-13 이식(context-budget): 초대형 프롬프트(>100KB)는 결정론적 압축으로 컨텍스트 예산 보호.
    if (typeof input.prompt === 'string' && input.prompt.length > MAX_PLAN_CHARS) {
      input.prompt = compressPlan(input.prompt);
    }
    let requestedProvider: string;
    try {
      const taskType = (await getSmartRouter()).inferTaskType(input.prompt);
      requestedProvider = resolveExecutionProvider(input.ai, taskType);
    } catch (error) {
      if (error instanceof ProviderResolutionError) {
        reply.code(error.statusCode);
        return error.toResponse();
      }
      throw error;
    }
    const allowProviderFailover = input.metadata?.allowProviderFailover === true;
    const projectDirError = validateProjectDirMetadata(input.metadata);
    if (projectDirError) {
      reply.code(400);
      return { error: 'invalid_project_dir', detail: projectDirError };
    }

    // Save to DB
    const taskTeamId = typeof input.metadata?.teamId === 'string' && input.metadata.teamId.trim()
      ? input.metadata.teamId.trim()
      : null;
    let taskOrganizationId = typeof input.metadata?.organizationId === 'string'
      ? input.metadata.organizationId.trim()
      : '';
    if (taskTeamId) {
      const lifecycleTarget = db.prepare(`
        SELECT
          t.is_active AS team_active,
          t.organization_id AS organization_id,
          COALESCE(o.is_active, 1) AS organization_active
        FROM teams t
        LEFT JOIN organizations o ON o.id = t.organization_id
        WHERE t.id = ?
      `).get(taskTeamId) as {
        team_active: number;
        organization_id: string | null;
        organization_active: number;
      } | undefined;
      if (!lifecycleTarget) {
        reply.code(400);
        return { error: 'invalid_team', detail: `team not found: ${taskTeamId}` };
      }
      if (lifecycleTarget.team_active !== 1 || lifecycleTarget.organization_active !== 1) {
        reply.code(409);
        return {
          error: 'team_inactive',
          detail: `team lifecycle blocks new work: ${taskTeamId}`,
        };
      }
      taskOrganizationId = lifecycleTarget.organization_id || taskOrganizationId;
      if (!taskOrganizationId) {
        reply.code(409);
        return {
          error: 'organization_audit_scope_missing',
          detail: `active team has no organization audit scope: ${taskTeamId}`,
        };
      }
    }
    const workReportId = getWorkReportId(input.metadata);
    if (workReportId) {
      const existingTask = findActiveWorkReportTask(db, workReportId);
      if (existingTask) {
        reply.code(202);
        return {
          taskId: existingTask.id,
          agentId: existingTask.assigned_to,
          deduplicated: true,
        };
      }
    }
    let workflowRunId = typeof input.metadata?.workflowRunId === 'string'
      ? input.metadata.workflowRunId.trim()
      : '';
    let workflowStage = (
      typeof input.metadata?.workflowStage === 'string'
        ? input.metadata.workflowStage
        : 'implementation'
    ) as WorkflowStage;
    const workflowDecision = evaluateWorkflowPolicy(input.prompt, input.metadata);
    const createWorkflowRunAtCommit = workflowDecision.scoped
      && !workflowRunId
      && !workflowDecision.required;
    if (workflowDecision.scoped) {
      const workflowMetadata = {
        ...(input.metadata ?? {}),
        ...(workflowRunId ? { workflowRunId } : {}),
        workflowStage,
      };
      const gateCheck = enforceWorkflowPrerequisites(
        workflowMetadata,
        input.mode || 'task',
        input.prompt,
        db,
      );
      if (!gateCheck.allowed) {
        reply.code(409);
        return {
          error: gateCheck.error,
          detail: gateCheck.detail,
          workflowRunId: gateCheck.workflowRunId,
          requiredStage: gateCheck.requiredStage,
          suggestion: 'Run the work through /api/conductor before dispatching implementation.',
        };
      }
      workflowStage = gateCheck.workflowStage ?? workflowStage;
      input.metadata = workflowMetadata;
    }

    const taskId = createTaskId();
    const readinessSnapshot = providerRuntimeCoordinator.getSnapshot();
    if (!readinessSnapshot) {
      reply.code(503);
      return { error: 'provider_registry_unavailable' };
    }
    const readinessAssessment = await assessProviderReadiness(readinessSnapshot);
    const providerSelection = selectTaskProvider(
      requestedProvider,
      allowProviderFailover,
      readinessAssessment.byProvider,
      readinessAssessment.roleByProvider,
    );
    if ('error' in providerSelection) {
      reply.code(409);
      return providerSelection.error;
    }
    const agentId = providerSelection.agentId;
    if (providerSelection.failover) logDecision({ taskId, phase: 'routing', decision: `route:${requestedProvider}->${agentId}`, reason: providerSelection.failover.originalGate });
    // DB와 실제 queue가 동일한 실행 계약을 공유해야 재시작 복구·retry가 projectDir,
    // 권한, timeout, priority를 잃지 않는다. invocationId는 생성 직후 아래에서 추가한다.
    const mergedMetadata: Record<string, unknown> = {
      ...(input.metadata ?? {}),
      ...(taskTeamId && requiresNovaAxAudit(taskTeamId, input.metadata ?? {})
        ? {
            // GATE-STRATEGIC-R1: verificationStatus는 reviewing 진입 시
            // markTaskAuditQueued가 설정한다. enqueue 시 'pending' 주입은
            // 스케줄러 우회 completed 행이 게이트에 걸려 completion=0%를 만든다.
            organizationAuditRequired: true,
            companyId: taskOrganizationId,
            teamId: taskTeamId,
            auditPriority: 10,
          }
        : {}),
      requestedProvider: input.metadata?.requestedProvider ?? requestedProvider,
      ...(input.model ? { model: input.model } : {}),
      ...(input.timeout ? { taskTimeoutMs: input.timeout } : {}),
      ...(promptGate ? { promptGate } : {}),
      ...(input.requiredEvidence && input.requiredEvidence.length > 0
        ? { requiredEvidence: input.requiredEvidence }
        : {}),
    };
    try {
      const verifierJson = input.verifier ? JSON.stringify(input.verifier) : null;
      // team_id: metadata.teamId를 태스크 행에 직접 귀속시켜 팀 성과 집계(GROUP BY team_id)에 즉시 반영.
      // (기존엔 INSERT에 team_id가 없어 /api/task 생성 태스크는 team_id=NULL이었고, 스케줄러만 별도 UPDATE로 우회했음.)
      const insertTask = db.transaction(() => {
        if (createWorkflowRunAtCommit) {
          workflowRunId = createWorkflowRun({
            prompt: input.prompt,
            teamId: taskTeamId,
            companyRunId: typeof input.metadata?.companyRunId === 'string'
              ? input.metadata.companyRunId
              : null,
            source: 'task-intake',
            metadata: input.metadata,
            decision: workflowDecision,
          }, db);
          input.metadata = { ...(input.metadata ?? {}), workflowRunId, workflowStage };
          mergedMetadata.workflowRunId = workflowRunId;
          mergedMetadata.workflowStage = workflowStage;
        }
        // Task, idempotency reservation, and workflow side effects are one
        // SQLite transaction. A concurrent replay cannot leave an orphan run.
        const metadataJson = Object.keys(mergedMetadata).length > 0
          ? JSON.stringify(mergedMetadata)
          : null;
        db.prepare(`
          INSERT INTO tasks (id, mode, prompt, system_prompt, assigned_to, status, workspace_id, team_id, priority, spawned_by_cli, verifier_json, metadata_json, parent_task_id, last_activity_at)
          VALUES (?, ?, ?, ?, ?, 'assigned', ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(taskId, input.mode, input.prompt, input.systemPrompt || null, agentId, input.workspaceId, taskTeamId, input.priority, spawnedByCli, verifierJson, metadataJson, input.parentTaskId ?? null);
        if (idempotencyKey) {
          db.prepare(`
            INSERT INTO task_idempotency_keys (
              caller_scope, idempotency_key, request_fingerprint, task_id
            ) VALUES (?, ?, ?, ?)
          `).run(
            spawnedByCli ?? '',
            idempotencyKey,
            idempotencyRequestFingerprint,
            taskId,
          );
        }
        if (workflowRunId) {
          attachWorkflowTask(taskId, workflowRunId, workflowStage, taskTeamId, agentId, db);
        }
      });
      insertTask.immediate();
    } catch (dbErr) {
      if (workReportId) {
        const existingTask = findActiveWorkReportTask(db, workReportId);
        if (existingTask) {
          reply.code(202);
          return {
            taskId: existingTask.id,
            agentId: existingTask.assigned_to,
            deduplicated: true,
          };
        }
      }
      if (idempotencyKey) {
        const reservation = db.prepare(`
          SELECT i.task_id, i.request_fingerprint, t.assigned_to, t.status
          FROM task_idempotency_keys i
          JOIN tasks t ON t.id=i.task_id
          WHERE i.caller_scope=? AND i.idempotency_key=?
        `).get(spawnedByCli ?? '', idempotencyKey) as TaskIdempotencyReservation | undefined;
        if (reservation) {
          if (reservation.request_fingerprint !== idempotencyRequestFingerprint) {
            reply.code(409);
            return {
              error: 'idempotency_key_payload_conflict',
              taskId: reservation.task_id,
            };
          }
          reply.code(202);
          return {
            taskId: reservation.task_id,
            agentId: reservation.assigned_to,
            status: reservation.status,
            deduplicated: true,
          };
        }
      }
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
    mergedMetadata.invocationId = invocationId;
    try {
      db.prepare(`
        UPDATE tasks
        SET metadata_json=?, updated_at=datetime('now')
        WHERE id=?
      `).run(JSON.stringify(mergedMetadata), taskId);
    } catch (error) {
      log.warn({
        taskId,
        invocationId,
        error: error instanceof Error ? error.message : String(error),
      }, 'Failed to persist task invocation recovery metadata');
    }

    // Inject workspace conversation history into systemPrompt so the agent
    // has context from previous turns in the same workspace session.
    // Only when the caller EXPLICITLY passed workspaceId — otherwise one-shot
    // tasks get polluted with unrelated 'default' workspace history and the
    // agent answers the old conversation instead of the current prompt.
    const explicitWorkspace = typeof (req.body as any)?.workspaceId === 'string';
    const systemPromptWithContext = explicitWorkspace
      ? injectContext(input.systemPrompt, input.workspaceId || 'default', taskId)
      : input.systemPrompt;
    const taskFailureContext: TaskFailureContext = {
      mode: input.mode,
      prompt: input.prompt,
      team_id: typeof input.metadata?.teamId === 'string' ? input.metadata.teamId : null,
    };
    const failureDetectionOptions = {
      reportMode: isTextReportTask(taskFailureContext),
      prompt: input.prompt,
    };

    // Enqueue via TaskQueueManager (BullMQ or semaphore) — respects per-agent concurrency
    taskQueue.enqueue({
      taskId,
      agentId,
      prompt: input.prompt,
      model: input.model,
      systemPrompt: systemPromptWithContext,
      timeoutMs: input.timeout,
      verifier: input.verifier,
      priority: input.priority,
      metadata: mergedMetadata,
    })
      .then(result => {
        const response = (result.output != null && result.output !== '') ? result.output : '';
        const { status: nextStatus, error } = resolveTaskTerminalOutcome(
          result,
          failureDetectionOptions,
        );
        const taskMetadata = input.metadata ?? {};
        const auditRequired = nextStatus === 'completed'
          && requiresNovaAxAudit(taskTeamId, taskMetadata);
        const persistedStatus = auditRequired ? 'reviewing' : nextStatus;
        try {
          const moved = transitionTask(db, taskId, persistedStatus, {
            response: response || undefined,
            error,
            completedAt: persistedStatus !== 'cancelled' && persistedStatus !== 'reviewing',
            evidenceJson:
              persistedStatus === 'completed' || persistedStatus === 'reviewing'
                ? result.evidenceJson
                : undefined,
          });
          if (!moved.ok) {
            log.info({ taskId, prev: moved.prev, next: persistedStatus }, 'Skipped terminal completion update');
          } else {
            void app.settlePersistedTaskTerminal(taskId)
              .catch(err => log.warn({
                err: err instanceof Error ? err.message : String(err),
                taskId,
                companyId: taskOrganizationId,
                teamId: taskTeamId,
              }, 'Task terminal side effects failed'));
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
          } else {
            void app.settlePersistedTaskTerminal(taskId)
              .catch(settleError => log.warn({
                err: settleError instanceof Error ? settleError.message : String(settleError),
                taskId,
              }, 'Task failure side effects failed'));
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
      ...(promptGate ? { promptGate } : {}),
      requestedProvider: providerSelection.failover ? requestedProvider : undefined,
      failover: providerSelection.failover,
      workflowRunId: workflowRunId || undefined,
      workflowStage: workflowRunId ? workflowStage : undefined,
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

  app.get('/api/tasks', async (req, reply) => {
    const query = req.query as any;

    const rawLimit = Number(query.limit);
    const limit = query.limit !== undefined && Number.isSafeInteger(rawLimit)
      ? Math.min(500, Math.max(1, rawLimit))
      : 100;

    const rawOffset = Number(query.offset);
    const offset = query.offset !== undefined && Number.isSafeInteger(rawOffset)
      ? Math.max(0, rawOffset)
      : 0;

    let statuses: string[] | undefined;
    if (query.status !== undefined) {
      const statusStr = String(query.status);
      const parts = statusStr.split(',').map(s => s.trim());

      if (parts.length === 0 || parts.some(s => s === '')) {
        reply.code(400);
        return { error: 'Malformed status filter' };
      }
      if (parts.length > 20) {
        reply.code(400);
        return { error: 'Too many status values' };
      }
      if (parts.some(s => s.length > 50)) {
        reply.code(400);
        return { error: 'Status value too long' };
      }
      statuses = Array.from(new Set(parts));
    }

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

    if (statuses) {
      const placeholders = statuses.map(() => '?').join(', ');
      where.push(`status IN (${placeholders})`);
      params.push(...statuses);
    }

    const whereClause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

    const statusRows = db.prepare(`
      SELECT
        assigned_to as provider,
        status,
        COUNT(*) as count,
        SUM(CASE
          WHEN status IN ('pending', 'queued', 'assigned', 'running', 'streaming', 'reviewing')
            AND MAX(
              COALESCE(julianday(last_activity_at), 0),
              COALESCE(julianday(last_heartbeat_at), 0),
              COALESCE(julianday(updated_at), 0),
              COALESCE(julianday(acked_at), 0),
              COALESCE(julianday(created_at), 0)
            ) < julianday('now', '-3 minutes')
          THEN 1 ELSE 0
        END) as stale_count
      FROM tasks${whereClause}
      GROUP BY assigned_to, status
      ORDER BY assigned_to, status
    `).all(...params) as Array<{ provider: string | null, status: string, count: number, stale_count: number }>;
    const statusCounts: Record<string, number> = {};
    const providerStatusCounts: Array<{ provider: string | null, status: string, count: number, staleCount: number }> = [];
    let total = 0;
    let staleCount = 0;
    for (const row of statusRows) {
      statusCounts[row.status] = (statusCounts[row.status] ?? 0) + row.count;
      providerStatusCounts.push({ provider: row.provider, status: row.status, count: row.count, staleCount: row.stale_count });
      total += row.count;
      staleCount += row.stale_count;
    }

    const sql = `SELECT * FROM tasks${whereClause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`;
    const taskRows = db.prepare(sql).all(...params, limit, offset) as Array<{
      id: string;
      last_activity_at?: string | null;
    }>;

    const returned = taskRows.length;
    const hasMore = offset + returned < total;

    // 대시보드의 limit=50 폴링 한 번이 101개 SQL로 증폭되므로, discussion을 한 번에 읽고
    // tasks.last_activity_at은 이미 조회된 row를 runtime fallback으로 재사용한다.
    const discussionByTaskId = readActiveDiscussionProgressBatch(taskRows.map(task => task.id));
    const tasks = taskRows.map(task =>
      withTaskRuntime(task, discussionByTaskId.get(task.id) ?? null)
    );

    return {
      tasks,
      meta: {
        limit,
        offset,
        returned,
        total,
        hasMore,
        staleCount,
        statusCounts,
        providerStatusCounts
      }
    };
  });

  app.get('/api/decisions', async (req, reply) => {
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid query', details: parsed.error.issues.map(issue => issue.message) };
    }
    const decisions = getDb().prepare('SELECT * FROM decision_log ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(parsed.data.limit);
    return { decisions };
  });

  app.get('/api/task/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const task = db.prepare(`
      SELECT id, status, assigned_to, progress, prompt, response, error, metadata_json, created_at, completed_at,
             acked_at, last_heartbeat_at, heartbeat_seq, lease_expires_at
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
      metadata_json: string | null;
      created_at: string | null;
      completed_at: string | null;
      acked_at: string | null;
      last_heartbeat_at: string | null;
      heartbeat_seq: number | null;
      lease_expires_at: string | null;
    } | undefined;

    if (!task) {
      reply.code(404);
      return { error: 'not found' };
    }

    const metadata = task.metadata_json ? safeJsonParse(task.metadata_json) : undefined;
    const requestedProvider = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      && typeof (metadata as Record<string, unknown>).requestedProvider === 'string'
      ? (metadata as Record<string, unknown>).requestedProvider as string
      : undefined;

    const projected = withTaskRuntime({
      id: task.id,
      status: task.status,
      progress: typeof task.progress === 'number' ? task.progress : Number(task.progress ?? 0),
      last_activity_at: task.last_heartbeat_at ?? task.created_at,
      assigned_to: task.assigned_to,
      heartbeat_seq: task.heartbeat_seq,
    });

    return {
      task: {
        id: task.id,
        status: projected.status,
        assigned_to: task.assigned_to,
        ...(requestedProvider ? { requestedProvider } : {}),
        ...(requestedProvider && task.assigned_to && requestedProvider !== task.assigned_to
          ? { providerMismatch: true }
          : {}),
        progress: projected.progress,
        ...('currentStep' in projected ? { currentStep: projected.currentStep } : {}),
        lastActivityAt: projected.lastActivityAt,
        liveness: projected.liveness,
        prompt: task.prompt?.slice(0, 200) ?? null,
        response: task.response?.slice(0, 20_000) ?? null,
        error: task.error,
        created_at: task.created_at,
        completed_at: task.completed_at,
        acked_at: task.acked_at,
        last_heartbeat_at: task.last_heartbeat_at,
        heartbeat_seq: task.heartbeat_seq,
        lease_expires_at: task.lease_expires_at,
      },
    };
  });

  app.post('/api/task/:id/ack', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = acknowledgeTaskLease(id);
    if (!result.ok) {
      reply.code(result.reason === 'not_found' ? 404 : 409);
      return result.reason === 'not_found'
        ? { error: 'not found' }
        : { error: 'invalid_status', status: result.status ?? null };
    }
    return { ok: true, task: result.task };
  });

  app.post('/api/task/:id/heartbeat', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = TaskHeartbeatBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid input', details: parsed.error.issues.map(issue => issue.message) };
    }

    const result = recordTaskHeartbeat(id, parsed.data);
    if (!result.ok) {
      reply.code(result.reason === 'not_found' ? 404 : 409);
      return result.reason === 'not_found'
        ? { error: 'not found' }
        : { error: 'heartbeat_conflict', status: result.status ?? null };
    }
    return { ok: true, task: result.task };
  });

  // CLI 세션 레지스트리 (2026-07-12 claude-2): cli_sessions 테이블 배선(기존 0행).
  // UserPromptSubmit 훅이 매 프롬프트마다 heartbeat POST → 대시보드가 '누가 활성·무엇 작업 중'을 관측.
  const CLI_SESSION_STATUSES = new Set(['active', 'idle', 'busy', 'disconnected']);
  app.post('/api/cli-session', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const rawId = b.id ?? b.sessionId;
    const id = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : null;
    if (!id) { reply.code(400); return { error: 'id required' }; }
    const status = typeof b.status === 'string' && CLI_SESSION_STATUSES.has(b.status) ? b.status : 'active';
    const pidNum = Number(b.pid);
    try {
      getDb().prepare(`
        INSERT INTO cli_sessions (id, hostname, pid, user_name, project_dir, cli_version, status, current_task, metadata_json, registered_at, last_heartbeat, disconnected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), NULL)
        ON CONFLICT(id) DO UPDATE SET
          hostname=excluded.hostname,
          pid=excluded.pid,
          user_name=COALESCE(excluded.user_name, cli_sessions.user_name),
          project_dir=COALESCE(excluded.project_dir, cli_sessions.project_dir),
          cli_version=COALESCE(excluded.cli_version, cli_sessions.cli_version),
          status=excluded.status,
          current_task=excluded.current_task,
          metadata_json=COALESCE(excluded.metadata_json, cli_sessions.metadata_json),
          last_heartbeat=datetime('now'),
          disconnected_at=NULL
      `).run(
        id,
        typeof b.hostname === 'string' && b.hostname.trim() ? b.hostname.trim() : 'unknown',
        Number.isFinite(pidNum) ? Math.trunc(pidNum) : 0,
        b.user ?? b.userName ?? b.user_name ?? null,
        b.projectDir ?? b.project_dir ?? null,
        b.cliVersion ?? b.cli_version ?? null,
        status,
        b.currentTask ?? b.current_task ?? null,
        b.metadata ? JSON.stringify(b.metadata) : null,
      );
    } catch (e) {
      log.error({ err: (e as Error).message, id }, 'cli-session upsert failed');
      reply.code(500); return { error: 'upsert_failed' };
    }
    return { ok: true, id, status };
  });

  app.get('/api/cli-sessions', async () => {
    const rows = getDb().prepare(`
      SELECT id, hostname, pid, project_dir, status, current_task, registered_at, last_heartbeat, disconnected_at,
        CAST((julianday('now') - julianday(last_heartbeat)) * 86400 AS INTEGER) AS idle_seconds
      FROM cli_sessions
      ORDER BY last_heartbeat DESC
    `).all();
    return { sessions: rows, count: rows.length };
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
    const task = db.prepare(`
      SELECT id, status, assigned_to, progress, response, error, updated_at,
             last_activity_at, heartbeat_seq
      FROM tasks
      WHERE id=?
    `).get(id) as any;
    if (!task) { reply.code(404); return { error: 'Task not found' }; }
    const projected = withTaskRuntime(task);
    return {
      taskId: task.id,
      status: projected.status,
      progress: projected.progress,
      ...('currentStep' in projected ? { currentStep: projected.currentStep } : {}),
      assigned_to: task.assigned_to,
      heartbeatSeq: task.heartbeat_seq,
      result: task.response,
      updatedAt: task.updated_at,
      lastActivityAt: projected.lastActivityAt,
      liveness: projected.liveness,
    };
  });

  app.post('/api/tasks/:id/verification', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({
      receiptId: z.string().min(1),
      actorId: z.string().min(1),
      uiInspectionReceiptId: z.string().min(1).optional(),
    }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'invalid_verification_receipt',
        details: parsed.error.issues.map(issue => issue.message),
      };
    }

    const db = getDb();
    const task = db.prepare(`
      SELECT k.id, k.status, k.team_id, k.assigned_to, k.prompt, k.response,
        k.metadata_json, t.organization_id
      FROM tasks k
      LEFT JOIN teams t ON t.id=k.team_id
      WHERE k.id=?
    `).get(id) as {
      id: string;
      status: string;
      team_id: string | null;
      assigned_to: string | null;
      prompt: string;
      response: string | null;
      metadata_json: string | null;
      organization_id: string | null;
    } | undefined;
    if (!task) {
      reply.code(404);
      return { error: 'task_not_found' };
    }
    const metadata = parseTaskMetadata(task.metadata_json);
    if (!requiresNovaAxAudit(task.team_id, metadata)) {
      reply.code(409);
      return { error: 'task_does_not_require_organization_audit' };
    }
    if (task.status !== 'reviewing') {
      reply.code(409);
      return {
        error: 'task_not_waiting_for_verification',
        status: task.status,
      };
    }
    const companyId = task.organization_id
      || (typeof metadata.companyId === 'string' ? metadata.companyId : '');
    if (!companyId || !task.team_id) {
      reply.code(409);
      return { error: 'organization_audit_scope_missing' };
    }

    const alreadyApproved = metadata.verificationStatus === 'approved'
      && metadata.verificationReceiptId === parsed.data.receiptId;
    if (!alreadyApproved) {
      const activity = await postNovaAxActivity({
        id: `nco-audit-approved:${id}:${Date.now()}`,
        timestamp: new Date().toISOString(),
        agentId: parsed.data.actorId,
        agentName: task.assigned_to || parsed.data.actorId,
        action: 'task_complete',
        description: task.prompt.slice(0, 500),
        result: task.response || 'execution completed; awaiting audit approval',
        taskId: id,
        companyId,
        teamId: task.team_id,
        receiptId: parsed.data.receiptId,
        metadata: parsed.data.uiInspectionReceiptId
          ? { uiInspectionReceiptId: parsed.data.uiInspectionReceiptId }
          : {},
      });
      if (!activity.ok) {
        reply.code(activity.status === 409 ? 409 : 502);
        return {
          error: 'nova_ax_verification_rejected',
          novaAxStatus: activity.status,
          detail: activity.payload,
        };
      }
      metadata.verificationStatus = 'approved';
      metadata.verificationReceiptId = parsed.data.receiptId;
      metadata.verificationApprovedAt = new Date().toISOString();
      if (parsed.data.uiInspectionReceiptId) {
        metadata.uiInspectionReceiptId = parsed.data.uiInspectionReceiptId;
      }
      db.prepare(`
        UPDATE tasks
        SET metadata_json=?, updated_at=datetime('now')
        WHERE id=? AND status='reviewing'
      `).run(JSON.stringify(metadata), id);
    }

    const moved = transitionTask(db, id, 'completed', { completedAt: true });
    if (!moved.ok) {
      reply.code(409);
      return {
        error: 'verified_completion_transition_failed',
        status: moved.prev,
      };
    }
    syncWorkflowTask(id, 'completed', {
      evidence: {
        source: 'nova-ax-6-of-6-receipt',
        receiptId: parsed.data.receiptId,
        uiInspectionReceiptId: parsed.data.uiInspectionReceiptId,
      },
    }, db);
    projectKanbanTaskStatus(id, 'completed');
    await eventBus.publish({
      type: 'task:completed',
      taskId: id,
      agentId: task.assigned_to || parsed.data.actorId,
      prompt: task.prompt,
      companyId,
      teamId: task.team_id,
      receiptId: parsed.data.receiptId,
    });
    return {
      ok: true,
      taskId: id,
      status: 'completed',
      verificationStatus: 'approved',
      receiptId: parsed.data.receiptId,
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

  // Stdio MCP processes are intentionally API-only clients. Keeping dynamic
  // skill discovery and execution behind this boundary prevents every Codex /
  // OpenCode session from opening the production SQLite database directly.
  app.get('/api/mcp/dynamic-tools', async () => ({
    tools: acquisitionRegistry.listAcquiredSkillNames().map(skill => ({
      name: skill.name,
      description: skill.description,
    })),
  }));

  app.post('/api/mcp/dynamic-tools/execute', async (req, reply) => {
    const parsed = DynamicMcpToolExecuteSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid input', details: parsed.error.issues.map(issue => issue.message) };
    }

    const skill = acquisitionRegistry.listAcquiredSkillNames()
      .find(entry => entry.name === parsed.data.name);
    if (!skill) {
      reply.code(404);
      return { error: 'Dynamic MCP tool not found' };
    }

    const result = await dynamicSkillEngine.executeSkill(
      skill.id,
      parsed.data.prompt,
      executeDynamicMcpAgentTask,
    );
    return {
      tool: skill.name,
      output: result.output,
      quality: result.quality,
      steps: result.steps,
    };
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
    const retryOptions = {
      overrideAi: parsedBody.data.ai,
      overridePrompt: parsedBody.data.prompt,
    };
    const sourceTaskId = resolveRetrySourceTaskId(getDb(), id);
    const created = await withRetryLock(sourceTaskId, () => (
      parsedBody.data.replaceActive
        ? replaceActiveTask(id, retryOptions)
        : createRetryTask(id, retryOptions)
    ));
    if (!created.ok) {
      reply.code(created.statusCode);
      return created.body;
    }
    reply.code(202);
    return {
      newTaskId: created.newTaskId,
      retryOf: id,
      ...(created.deduplicated ? { deduplicated: true } : {}),
      ...(created.replacedActive ? { replacedActive: true } : {}),
    };
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
    let agentId: string;
    try {
      agentId = resolveExecutionProvider(body.ai, 'general');
    } catch (error) {
      if (error instanceof ProviderResolutionError) {
        reply.code(error.statusCode);
        return error.toResponse();
      }
      throw error;
    }

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
      projectDir: body.projectDir,
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

    const parsedInput = CreateDiscussionInput.safeParse(req.body);
    if (!parsedInput.success) {
      reply.code(400);
      return { error: 'Invalid input', details: parsedInput.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
    }
    const input = parsedInput.data;

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

    // 형제 라우트(/api/parallel, /api/realtime/discussion)와 동일하게 스키마 검증한다.
    // 검증이 없으면 prompt 없이도 202 "started"를 돌려주어 호출자가 성공으로 오인한다.
    const parsedBody = CreateDiscussionInput.safeParse(req.body);
    if (!parsedBody.success) {
      reply.code(400);
      return { error: 'Invalid input', details: parsedBody.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
    }
    const body = parsedBody.data;

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

  // 합의 실행 핸들러. /api/realtime/consensus 와 /api/consensus 양쪽에 등록한다.
  // (/nco-team consensus 는 /api/consensus 로 POST 하는데, 예전에는 POST 핸들러가
  //  없어서 dashboard-compat 의 catch-all 이 200 + 빈 data 를 돌려주고 있었다.)
  const runConsensus = async (req: FastifyRequest, reply: FastifyReply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const parsedInput = CreateDiscussionInput.safeParse(req.body);
    if (!parsedInput.success) {
      reply.code(400);
      return { error: 'Invalid input', details: parsedInput.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
    }
    const input = parsedInput.data;

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
      maxRounds: input.maxRounds,
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
  };

  app.post('/api/realtime/consensus', runConsensus);
  app.post('/api/consensus', runConsensus);

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
      projectDir: body.projectDir,
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
    const delivery = await cliMesh.sendMessageWithReceipt(
      fromSessionId, fromAgent || 'unknown', destination, content, type,
    );
    // Backward-compatible numeric field plus evidence that distinguishes queueing
    // from receiver acknowledgement. The mesh layer already publishes the event.
    return { delivered: delivery.queuedRecipients, delivery };
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

  app.post('/api/mesh/complete', async (req, reply) => {
    const cliMesh = await getCliMesh();
    const { sessionId, completedWork } = req.body as any;
    if (!sessionId) {
      reply.code(400);
      return { error: 'sessionId required' };
    }
    await cliMesh.complete(sessionId, completedWork);
    return { completed: true };
  });

  // Recent messages across all sessions (for monitor initial load)
  app.get('/api/mesh/messages', async (req) => {
    const cliMesh = await getCliMesh();
    const limit = Math.min(Number((req.query as any)?.limit) || 50, 200);
    return { messages: cliMesh.getRecentMessages(limit) };
  });

  app.post('/api/mesh/disconnect', async (req, reply) => {
    const cliMesh = await getCliMesh();
    const { sessionId } = req.body as any;
    if (!sessionId) {
      reply.code(400);
      return { error: 'sessionId required' };
    }
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
    const delivery = await cliMesh.sendMessageWithReceipt(
      fromSessionId, fromAgent || 'unknown', '*', content, type,
    );
    // Keep `delivered` for existing clients while exposing the honest receipt.
    return { delivered: delivery.queuedRecipients, delivery };
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
    // body.result 를 엔진에 전달한다. 이전에는 close(id) 만 호출해서
    // /nco-collab close <id> [result] 의 result 인자가 조용히 버려졌다.
    const { result: requestedResult } = (req.body ?? {}) as any;
    const collab = await collaborationEngine.close(
      id,
      typeof requestedResult === 'string' && requestedResult.trim() ? requestedResult : undefined,
    );
    return { id, status: 'closed', result: collab.result };
  });

  app.get('/api/collab', async (req) => {
    const limit = Number((req.query as any).limit) || 50;
    return { collaborations: collaborationEngine.getAll(limit) };
  });

  app.get('/api/collab/open', async () => {
    return { collaborations: collaborationEngine.getOpen() };
  });

  app.get('/api/collab/:id', async (req, reply) => {
    const { id } = req.params as any;
    const collab = collaborationEngine.get(id);
    if (!collab) {
      reply.code(404);
      return { error: 'not found' };
    }
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
  app.post('/api/commander', async (req, reply) => {
    const commander = await getCommander();
    const { prompt } = req.body as any;
    if (!prompt) {
      reply.code(400);
      return { error: 'prompt is required' };
    }
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

  app.get('/api/learn/query', async (req, reply) => {
    const { knowledgeBase } = await import('../core/knowledge-base.js');
    const { keywords, project } = req.query as any;
    if (!keywords) {
      reply.code(400);
      return { error: 'keywords parameter required' };
    }
    return { results: knowledgeBase.query(keywords, project) };
  });

  // /api/learn/search is registered in dashboard-compat.ts (inside catch-all handler)

  app.get('/api/learn/context', async (req, reply) => {
    const { knowledgeBase } = await import('../core/knowledge-base.js');
    const { project } = req.query as any;
    if (!project) {
      reply.code(400);
      return { error: 'project parameter required' };
    }
    return { context: knowledgeBase.getContext(project) };
  });

  // ═══ Plan + Kanban ════════════════════════════════
  app.post('/api/plan/create', async (req, reply) => {
    const { planManager, PlanTaskValidationError } = await import('../core/plan-manager.js');
    const parsed = z.object({
      title: z.string().trim().min(1).max(200),
      tasks: z.array(z.string().trim().min(1).max(1_000)).max(500).optional(),
      sourceDiscussionId: z.string().trim().min(1).max(200).optional(),
    }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'invalid_plan',
        details: parsed.error.issues.map(issue => issue.message),
      };
    }
    try {
      return await planManager.createPlan(
        parsed.data.title,
        parsed.data.tasks,
        parsed.data.sourceDiscussionId,
      );
    } catch (error) {
      if (error instanceof PlanTaskValidationError) {
        reply.code(400);
        return { error: error.code, issues: error.issues };
      }
      throw error;
    }
  });

  app.get('/api/plan/:id', async (req, reply) => {
    const { planManager } = await import('../core/plan-manager.js');
    const { id } = req.params as any;
    const plan = planManager.getPlan(id);
    if (!plan) {
      reply.code(404);
      return { error: 'Plan not found' };
    }
    return plan;
  });

  app.post('/api/plan/:id/sync', async (req, reply) => {
    const {
      planManager,
      PlanMarkdownNotFoundError,
      PlanNotFoundError,
      PlanSyncCompletionError,
      PlanSyncConflictError,
      PlanTaskValidationError,
    } = await import('../core/plan-manager.js');
    const { id } = req.params as any;
    try {
      const synced = await planManager.syncFromMarkdown(id);
      await planManager.syncToMarkdown(id);
      return { synced };
    } catch (error) {
      if (error instanceof PlanNotFoundError) {
        reply.code(404);
        return { error: error.code, planId: error.planId };
      }
      if (error instanceof PlanMarkdownNotFoundError) {
        reply.code(404);
        return {
          error: error.code,
          planId: error.planId,
          markdownPath: error.markdownPath,
        };
      }
      if (error instanceof PlanSyncConflictError) {
        reply.code(409);
        return { error: error.code, conflicts: error.conflicts };
      }
      if (error instanceof PlanSyncCompletionError) {
        reply.code(409);
        return { error: error.code, conflicts: error.conflicts };
      }
      if (error instanceof PlanTaskValidationError) {
        reply.code(400);
        return { error: error.code, issues: error.issues };
      }
      throw error;
    }
  });

  app.get('/api/kanban', async (req) => {
    const { kanbanEngine } = await import('../core/kanban-engine.js');
    const { planId } = req.query as any;
    return kanbanEngine.getBoard(planId);
  });

  app.post('/api/kanban/move', async (req, reply) => {
    const { kanbanEngine } = await import('../core/kanban-engine.js');
    const parsed = z.object({
      taskId: z.string().min(1),
      to: z.enum(['todo', 'in_progress', 'review', 'done']).optional(),
      toColumn: z.enum(['todo', 'in_progress', 'review', 'done']).optional(),
    }).superRefine((value, context) => {
      if (!value.to && !value.toColumn) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'to or toColumn is required',
        });
      }
      if (value.to && value.toColumn && value.to !== value.toColumn) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'to and toColumn must match when both are provided',
        });
      }
    }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'invalid_kanban_move',
        details: parsed.error.issues.map(issue => issue.message),
      };
    }
    const to = parsed.data.to ?? parsed.data.toColumn!;
    const move = kanbanEngine.moveTaskDetailed(parsed.data.taskId, to);
    if (!move.moved && move.error === 'canonical_task_not_completed') {
      reply.code(409);
      return {
        error: move.error,
        taskId: parsed.data.taskId,
        canonicalTaskId: move.canonicalTaskId,
        canonicalStatus: move.canonicalStatus,
      };
    }
    if (!move.moved) {
      reply.code(404);
      return { error: 'kanban_task_not_found', taskId: parsed.data.taskId };
    }
    return { moved: true };
  });

  app.post('/api/plan/execute', async (req, reply) => {
    const { kanbanEngine } = await import('../core/kanban-engine.js');
    const parsed = z.object({
      planId: z.string().min(1),
      strategy: z.enum(['sequential', 'parallel', 'auto']).optional(),
    }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'invalid_plan_execution',
        details: parsed.error.issues.map(issue => issue.message),
      };
    }
    const planExists = getDb().prepare('SELECT id FROM plans WHERE id=?')
      .get(parsed.data.planId) as { id: string } | undefined;
    if (!planExists) {
      reply.code(404);
      return { error: 'plan_not_found', planId: parsed.data.planId };
    }
    const result = await kanbanEngine.executePlan(
      parsed.data.planId,
      parsed.data.strategy ?? 'auto',
    );
    return result;
  });

  // ═══ Conductor (Smart Router Auto-Dispatch) ════════
  app.post('/api/conductor', async (req, reply) => {
    if (draining) {
      return rejectWhileDraining(reply);
    }

    const smartRouter = await getSmartRouter();
    const { prompt, metadata: rawMetadata, callerAgentId: rawCallerAgentId } = req.body as any;
    if (!prompt) {
      reply.code(400);
      return { error: 'prompt is required' };
    }
    const metadata = rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
      ? rawMetadata as Record<string, unknown>
      : {};
    const callerAgentId = typeof rawCallerAgentId === 'string' && rawCallerAgentId.trim()
      ? rawCallerAgentId.trim()
      : null;

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
    const teamId = typeof metadata.teamId === 'string' && metadata.teamId.trim()
      ? metadata.teamId.trim()
      : null;
    const companyRunId = typeof metadata.companyRunId === 'string' && metadata.companyRunId.trim()
      ? metadata.companyRunId.trim()
      : null;
    const baseWorkflowDecision = evaluateWorkflowPolicy(prompt, {
      ...metadata,
      workflowRequired: decision.mode !== 'task' || decision.complexity >= 4,
    });
    const workflowDecision: WorkflowPolicyDecision = {
      ...baseWorkflowDecision,
      scoped: true,
      required: decision.mode !== 'task' || decision.complexity >= 4,
      policy: decision.mode !== 'task' || decision.complexity >= 4 ? 'required' : 'routine',
      requireReview: baseWorkflowDecision.requireReview,
      requireVerification: baseWorkflowDecision.requireVerification,
      reason: decision.mode !== 'task' || decision.complexity >= 4
        ? `conductor_complexity_${decision.complexity}`
        : 'conductor_routine',
    };
    const workflowRunId = createWorkflowRun({
      prompt,
      teamId,
      companyRunId,
      source: 'conductor',
      metadata,
      decision: workflowDecision,
    }, db);
    const requiresPlanning = workflowDecision.required;
    const effectiveMode = decision.mode === 'task' && requiresPlanning
      ? 'discussion'
      : decision.mode;
    // DiscussionEngine owns the discussion stage itself. The canonical task is
    // the synthesized design artifact, so its quality/audit outcome must gate
    // the design stage rather than completing discussion twice.
    const workflowStage: WorkflowStage = requiresPlanning ? 'design' : 'implementation';
    const taskMetadata = {
      ...metadata,
      ...(callerAgentId ? { callerAgentId } : {}),
      workflowRunId,
      workflowStage,
      workflowRequired: workflowDecision.required,
    };

    // Record task
    try {
      db.prepare(`
        INSERT INTO tasks (
          id, mode, prompt, assigned_to, status, priority, team_id,
          metadata_json, workflow_run_id, workflow_stage, spawned_by_cli
        )
        VALUES (?, ?, ?, ?, 'assigned', 5, ?, ?, ?, ?, ?)
      `).run(
        taskId,
        effectiveMode,
        prompt,
        decision.providers[0] || null,
        teamId,
        JSON.stringify(taskMetadata),
        workflowRunId,
        workflowStage,
        callerAgentId,
      );
      attachWorkflowTask(
        taskId,
        workflowRunId,
        workflowStage,
        teamId,
        decision.providers[0] || null,
        db,
      );
    } catch (dbErr) {
      db.prepare('DELETE FROM workflow_runs WHERE id=?').run(workflowRunId);
      log.error({ err: (dbErr as Error).message, taskId }, 'Failed to insert conductor task');
      return { error: 'Failed to create task' };
    }

    // Execute via discussion engine for multi-agent modes, or taskQueue for single
    const sessionId = createSessionId();
    if (effectiveMode === 'task' && decision.providers.length === 1) {
      taskQueue.enqueue({
        taskId,
        agentId: decision.providers[0],
        prompt,
        metadata: taskMetadata,
      })
        .then(result => {
          try {
            const cResp = result.output || result.error || '';
            const terminalOutcome = resolveTaskTerminalOutcome({
              ...result,
              output: cResp,
            }, { prompt });
            let cStatus = terminalOutcome.status;
            let cError = terminalOutcome.error ?? null;
            // P1-6 evidence-gate opt-in 하드차단: requiredEvidence 선언 태스크는 증거 충족 시에만 완료.
            if (cStatus === 'completed') {
              const requiredKinds = metadata.requiredEvidence;
              if (Array.isArray(requiredKinds) && requiredKinds.length > 0) {
                const gate = requireEvidence(result.evidenceJson ?? {}, requiredKinds);
                if (!gate.allowed) {
                  cStatus = 'failed';
                  cError = `evidence_gate_blocked: missing ${gate.missing.join(', ')}`;
                }
              }
            }
            const auditRequired = cStatus === 'completed'
              && requiresNovaAxAudit(teamId, taskMetadata);
            const persistedStatus = auditRequired ? 'reviewing' : cStatus;
            const moved = transitionTask(db, taskId, persistedStatus, {
              response: cResp || undefined,
              error: cError ?? undefined,
              completedAt: persistedStatus !== 'cancelled' && persistedStatus !== 'reviewing',
              evidenceJson:
                persistedStatus === 'completed' || persistedStatus === 'reviewing'
                  ? result.evidenceJson
                  : undefined,
            });
            if (!moved.ok) {
              log.info({ taskId, prev: moved.prev, next: persistedStatus }, 'Skipped late conductor terminal update');
              return;
            }
            void app.settlePersistedTaskTerminal(taskId)
              .catch(err => log.warn({
                err: err instanceof Error ? err.message : String(err),
                taskId,
              }, 'Conductor task terminal side effects failed'));
          } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update failed'); }
        })
        .catch(err => {
          try {
            const moved = transitionTask(db, taskId, 'failed', {
              error: err.message,
              completedAt: true,
            });
            if (moved.ok) {
              void app.settlePersistedTaskTerminal(taskId)
                .catch(settleError => log.warn({
                  err: settleError instanceof Error ? settleError.message : String(settleError),
                  taskId,
                }, 'Conductor failure side effects failed'));
            }
          } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update failed'); }
        });
    } else {
      discussionEngine.startDiscussion(
        buildConductorDiscussionOptions(
          {
            topic: prompt,
            mode: effectiveMode as any,
            providers: decision.providers,
            maxRounds: effectiveMode === 'consensus' ? 5 : 3,
            sessionId,
            taskId,
            teamId: teamId ?? undefined,
            companyRunId: companyRunId ?? undefined,
            workflowRunId,
          },
          taskMetadata,
        ),
      )
        .then(report => {
          try {
            const discussionEvidence = {
              discussion: {
                sessionId: report.sessionId,
                consensusRate: report.finalConsensusRate,
                participants: report.participants,
                rounds: report.rounds.length,
                proposalQuorum: report.proposalQuorum,
              },
              design: {
                synthesisLength: report.adoptedProposal.length,
                rationale: report.rationale,
              },
            };
            let terminalStatus: 'completed' | 'failed' = 'completed';
            let terminalError: string | undefined;
            const requiredKinds = metadata.requiredEvidence;
            if (Array.isArray(requiredKinds) && requiredKinds.length > 0) {
              const gate = requireEvidence(discussionEvidence, requiredKinds);
              if (!gate.allowed) {
                terminalStatus = 'failed';
                terminalError = `evidence_gate_blocked: missing ${gate.missing.join(', ')}`;
              }
            }
            const auditRequired = terminalStatus === 'completed'
              && requiresNovaAxAudit(teamId, taskMetadata);
            const persistedStatus = auditRequired ? 'reviewing' : terminalStatus;
            const moved = transitionTask(db, taskId, persistedStatus, {
              response: report.adoptedProposal,
              error: terminalError,
              completedAt: persistedStatus !== 'reviewing',
              evidenceJson: terminalStatus === 'completed'
                ? JSON.stringify(discussionEvidence)
                : undefined,
            });
            if (!moved.ok) {
              log.info({ taskId, prev: moved.prev, next: persistedStatus }, 'Skipped late discussion completion after terminal task state');
              return;
            }
            void app.settlePersistedTaskTerminal(taskId)
              .catch(err => log.warn({
                err: err instanceof Error ? err.message : String(err),
                taskId,
              }, 'Conductor discussion terminal side effects failed'));
          } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update failed'); }
        })
        .catch(err => {
          try {
            const moved = transitionTask(db, taskId, 'failed', {
              error: err.message,
              completedAt: true,
            });
            if (moved.ok) {
              markWorkflowStage(workflowRunId, 'discussion', 'failed', {
                teamId,
                taskId,
                discussionId: sessionId,
                error: err.message,
              }, db);
              void app.settlePersistedTaskTerminal(taskId)
                .catch(settleError => log.warn({
                  err: settleError instanceof Error ? settleError.message : String(settleError),
                  taskId,
                }, 'Conductor discussion failure side effects failed'));
            }
          } catch (dbErr) { log.error({ err: (dbErr as Error).message, taskId }, 'DB update failed'); }
        });
    }

    return {
      taskId,
      mode: effectiveMode,
      providers: decision.providers,
      complexity: decision.complexity,
      reasoning: decision.reasoning,
      status: 'dispatched',
      workflowRunId,
      workflowStage,
      requiredStages: workflowDecision.required ? ['discussion', 'design'] : [],
    };
  });

  // ═══ Agent Sessions ════════════════════════════════
  app.post('/api/agent/start', async (req, reply) => {
    const sessionManager = await getSessionManager();
    const { prompt, provider, systemPrompt, autoApprove } = req.body as any;
    if (!prompt) {
      reply.code(400);
      return { error: 'prompt is required' };
    }
    let agentId: string;
    try {
      agentId = resolveExecutionProvider(provider, 'general');
    } catch (error) {
      if (error instanceof ProviderResolutionError) {
        reply.code(error.statusCode);
        return error.toResponse();
      }
      throw error;
    }
    const sessionId = await sessionManager.startSession(prompt, agentId, { systemPrompt, autoApprove });
    return { sessionId, status: 'running', agentId };
  });

  app.get('/api/agent/sessions', async () => {
    const sessionManager = await getSessionManager();
    const active = sessionManager.listSessions();
    const history = sessionManager.getSessionsFromDb(20);
    return { sessions: [...active, ...history.filter(h => !active.find(a => a.id === h.id))] };
  });

  app.get('/api/agent/:sessionId/status', async (req, reply) => {
    const sessionManager = await getSessionManager();
    const { sessionId } = req.params as any;
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      reply.code(404);
      return { error: 'Session not found' };
    }
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

  app.get('/api/invocations/overview', async (req) => {
    const { limit } = req.query as any;
    const parsedLimit = Number(limit);
    return invocationTracker.getOverview(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined);
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
  await registerProviderAssignmentRoutes(app, new ProviderAssignmentRuntime());
  await registerCliQaRoutes(app);

  await registerTriadRoutes(app);
  registerGoalsRoutes(app);
  registerPerformanceRoutes(app);
  registerPerformanceFlowRoutes(app);
  await registerTeamScoreRoutes(app);
  await registerWebScrapingRoutes(app);
  await registerWorkReportRoutes(app);
  await registerWorkEventRoutes(app);
  await registerHarnessRoutes(app);
  await registerMathRoutes(app);
  // audit.ts는 구현만 있고 미마운트였음(emergency-stop이 compat 스텁으로 응답 — claude-1 T1 제보 2026-07-08)
  await registerAuditRoutes(app);

  // ═══ HR Organization Design Audit ════════════════
  app.get('/api/hr/organization-design', async () => {
    const db = getDb();
    const latest = db.prepare(`
      SELECT * FROM organization_design_audits ORDER BY audit_time DESC LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    if (!latest) return { audit: null };
    return {
      audit: {
        ...latest,
        excessCandidates: safeJsonParse(String(latest.excess_json ?? '[]')),
        actions: safeJsonParse(String(latest.actions_json ?? '[]')),
        evidence: safeJsonParse(String(latest.evidence_json ?? '[]')),
      },
    };
  });

  app.post('/api/hr/organization-design/run', async (req) => {
    const { repair } = (req.body ?? {}) as { repair?: boolean };
    const { runOrganizationDesignAudit } = await import('../core/organization-design-audit.js');
    const result = runOrganizationDesignAudit({ source: 'manual', repair: repair !== false });
    return { audit: result };
  });

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
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'GitHub search route failed');
      reply.code(500);
      return { error: 'GitHub search failed', statusCode: 500 };
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
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'GitHub agent route failed');
      reply.code(500);
      return { error: 'GitHub agent failed', statusCode: 500 };
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
