import { CreateTaskInput } from '../utils/validation.js';

export type RecoverableTaskStatus = 'queued' | 'assigned' | 'in_progress' | 'running' | 'streaming';

export type OrphanRecoveryDecision =
  | { action: 'dead_letter'; reason: 'no_agent' | 'poison' | 'external_injection' | 'orchestration_restart' }
  | { action: 'requeue'; incrementRecoveryCount: boolean };

export function restoreOrphanExecutionContract(input: {
  metadataJson: string | null;
  verifierJson: string | null;
  priority: number | null;
}): {
  metadata?: Record<string, unknown>;
  model?: string;
  timeoutMs?: number;
  verifier?: { type: 'run'; command: string; timeoutMs?: number };
  priority?: number;
} {
  let metadata: Record<string, unknown> | undefined;
  if (input.metadataJson) {
    try {
      const parsed = JSON.parse(input.metadataJson) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = undefined;
    }
  }

  const parsedTimeout = CreateTaskInput.shape.timeout.safeParse(metadata?.taskTimeoutMs);
  const parsedPriority = CreateTaskInput.shape.priority.safeParse(input.priority);
  const parsedVerifier = (() => {
    if (!input.verifierJson) return undefined;
    try {
      const result = CreateTaskInput.shape.verifier.safeParse(JSON.parse(input.verifierJson));
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  })();
  const model = typeof metadata?.model === 'string' && metadata.model.trim()
    ? metadata.model
    : undefined;

  return {
    ...(metadata ? { metadata } : {}),
    ...(model ? { model } : {}),
    ...(parsedTimeout.success ? { timeoutMs: parsedTimeout.data } : {}),
    ...(parsedVerifier ? { verifier: parsedVerifier } : {}),
    ...(parsedPriority.success ? { priority: parsedPriority.data } : {}),
  };
}

/**
 * queued는 아직 실행을 시작하지 않았으므로 재시작 실패 횟수로 계산하지 않는다.
 * 실행 중이던 작업만 실제 orphan 복구 횟수를 올리고, 그 횟수가 상한에 도달하면
 * 무한 재실행을 막기 위해 poison으로 종결한다.
 *
 * externallyInjected(외부 주입 행)는 NCO가 만든 적 없는 tasks 행이므로 재큐잉하지 않는다
 * — 아래 isExternallyInjectedOrphan 주석 참조.
 */
export function decideOrphanRecovery(input: {
  status: RecoverableTaskStatus;
  assignedTo: string | null;
  recoveryCount: number;
  maxRecoveryCount: number;
  externallyInjected?: boolean;
  /** 죽은 프로세스가 소유하던 active discussion/hive/consensus 루트 태스크. */
  orchestrationOwned?: boolean;
}): OrphanRecoveryDecision {
  // 멀티-agent orchestration을 assigned_to 한 명의 일반 BullMQ 작업으로 재실행하면
  // 협업이 단일 응답으로 조용히 강등된다. 현 엔진에는 durable round resume이 없으므로
  // 중단을 정직하게 종결하고 사용자가 conductor 전체를 재시도하게 한다.
  if (input.orchestrationOwned) {
    return { action: 'dead_letter', reason: 'orchestration_restart' };
  }
  if (input.externallyInjected) return { action: 'dead_letter', reason: 'external_injection' };
  if (!input.assignedTo) return { action: 'dead_letter', reason: 'no_agent' };
  if (input.status !== 'queued' && input.recoveryCount >= input.maxRecoveryCount) {
    return { action: 'dead_letter', reason: 'poison' };
  }
  return {
    action: 'requeue',
    incrementRecoveryCount: input.status !== 'queued',
  };
}

// ─── 외부 주입 orphan 가드 ────────────────────────────────────────────────
//
// 근거(2026-07-27 실측, db/nco.db):
//   외부 저장소의 cron이 게이트웨이·이벤트버스를 우회해 `tasks`에 raw sqlite3로 직접
//   행을 넣는다(`/Users/nova-ai/project/nova-sns/automation/{trend-collector,content-gen}.py`의
//   register_nco_task → `INSERT OR REPLACE INTO tasks (...) VALUES (... 'running' ...)`).
//   그 행은 prompt가 지시문이 아니라 상태 문구("누락된 SEO 키워드 분석 및 최적화 중")이고
//   response·result_json·evidence_json·metadata_json·system_prompt가 전부 비어 있다.
//   파이썬 프로세스가 완료 UPDATE 전에 죽거나 그 사이 NCO가 재시작되면 행이 'running'으로 남고,
//   부팅 orphan 복구가 이를 정상 in-flight 태스크로 오인해 실제 CLI 에이전트에 재배정한다.
//   실측 귀결: task_content_generation(orphan_requeue_count=1)이 cursor-agent로 재배정돼
//   ENOENT로 실패 → team_content-planning 실패로 계상(48h 계상 실패 2건 중 1건),
//   task_quality_check(orphan_requeue_count=2)는 team_quality-audit에서 동일 경로를 밟았다.
//
// 판별식은 "주입 직후 원본 상태"만 고른다. team_id가 있는데 NCO가 채우는 provenance 컬럼
// (metadata_json·system_prompt·spawned_by_cli)이 전부 비어 있고 아직 한 번도 재큐잉되지 않은 행.
// 14일 실측: team_id 있는 6,049행 중 이 조건에 걸리는 행은 1건(task_trend_collector — 확인된
// 주입 행)뿐이라 정상 팀 태스크 오탐은 0건이다. 이미 재큐잉된 행(count>0)은 기존 동작을 유지해
// 소급 변경이 없다.
//
// 롤백: 런타임 즉시 → NCO_ORPHAN_EXTERNAL_INJECTION_GUARD=off (재빌드 불필요).

/** 주입 판별에 쓰는 tasks 행의 부분 스냅샷. */
export interface OrphanProvenanceRow {
  teamId: string | null;
  metadataJson: string | null;
  systemPrompt: string | null;
  spawnedByCli: string | null;
  orphanRequeueCount: number;
}

function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim() === '';
}

/**
 * NCO가 만든 적 없는(=게이트웨이·이벤트버스를 거치지 않은) 팀 귀속 행인지 판정한다.
 * true면 재큐잉 대상에서 제외해야 한다 — 재배정해도 지시문이 아닌 상태 문구를 실행시키고,
 * 그 실패가 팀 점수에 계상된다.
 */
export function isExternallyInjectedOrphan(row: OrphanProvenanceRow): boolean {
  return !isBlank(row.teamId)
    && isBlank(row.metadataJson)
    && isBlank(row.systemPrompt)
    && isBlank(row.spawnedByCli)
    && (row.orphanRequeueCount ?? 0) === 0;
}

const EXTERNAL_INJECTION_GUARD_DISABLED = new Set(['0', 'false', 'off']);

/** 가드 토글. 기본 on, `NCO_ORPHAN_EXTERNAL_INJECTION_GUARD=off|0|false`로 즉시 해제. */
export function isExternalInjectionGuardEnabled(
  toggle: string | undefined = process.env.NCO_ORPHAN_EXTERNAL_INJECTION_GUARD,
): boolean {
  return !EXTERNAL_INJECTION_GUARD_DISABLED.has(toggle?.trim().toLowerCase() ?? '');
}
