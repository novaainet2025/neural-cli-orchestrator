/**
 * 태스크 실행 실패를 서킷에 반영할지 판정한다.
 *
 * **왜 필요한가.** `circuitBreakerRegistry.recordFailure` 는 코드 전체에서 딱 한 곳
 * — `provider-prober.ts` 의 헬스 프로브 — 에서만 호출된다. 태스크 실행 경로는
 * `getAvailability`·`getSnapshot` 으로 **읽기만 한다.** 그래서 프로바이더가 모든 태스크를
 * 쿼터 초과로 떨어뜨려도 서킷은 닫힌 채로 남고, NCO 는 계속 그 프로바이더에 배정한다.
 *
 * 실측(gentop, 2026-08-07): hermes 가 Gemini `429 RESOURCE_EXHAUSTED` 를 뱉는데
 * `consecutiveFailures 0` 으로 서킷이 `closed` 였다. 349건 배정 · 완료 0건.
 * 헬스체크가 대부분 `--version` 이라(6종 중 5종) 쿼터가 말라도 rc=0 으로 통과하기 때문에
 * 프로브만으로는 영영 안 열린다.
 *
 * 피해가 배정 로직 전체로 번진다 — 토론 참가자 자동 선정도 `circuitState` 로 거르므로,
 * 죽은 프로바이더가 계속 참가자로 뽑힌다.
 *
 * **다만 아무 실패나 반영하면 안 된다.** 프롬프트가 나빠서 실패한 태스크로 프로바이더를
 * 게이트하면 멀쩡한 프로바이더가 죽는다. 그래서 **프로바이더급 사유로 분류된 것만** 넘긴다
 * (쿼터·레이트리밋·인증). 판정은 기존 `classifyCircuitError` 를 그대로 재사용한다 —
 * 프로브 경로와 같은 기준이어야 두 경로가 어긋나지 않는다.
 */

import { classifyCircuitError, type CircuitReason } from '../security/circuit-breaker-registry.js';

/**
 * 태스크 실패로 서킷을 열어도 되는 사유.
 *
 * `generic` 은 제외한다 — 태스크 하나가 알 수 없는 이유로 죽은 것과 프로바이더가 망가진
 * 것을 구분할 수 없기 때문이다. 그 구분은 헬스 프로브가 계속 담당한다.
 */
const PROVIDER_LEVEL_REASONS: ReadonlySet<CircuitReason> = new Set<CircuitReason>([
  'quota',
  'rate-limit',
  'auth',
]);

export interface TaskFailureCircuitSignal {
  reason: CircuitReason;
  matchedText: string;
  resetTime: number | null;
}

/**
 * 태스크 실패 텍스트에서 서킷 반영 신호를 뽑는다. 반영 대상이 아니면 null.
 *
 * `error` 와 `output` 을 모두 본다. 프로바이더가 **exit 0 으로 오류 본문만 남기는** 경우가
 * 있어서(실측: `silent-failure: provider error body (exit 0)` 13건) error 만 보면 놓친다.
 */
export function classifyTaskFailureForCircuit(
  failure: { error?: string | null; output?: string | null },
): TaskFailureCircuitSignal | null {
  for (const raw of [failure.error, failure.output]) {
    const classified = classifyCircuitError(raw);
    if (!classified) continue;
    if (!PROVIDER_LEVEL_REASONS.has(classified.reason)) continue;
    return {
      reason: classified.reason,
      matchedText: classified.matchedText,
      resetTime: classified.resetTime,
    };
  }
  return null;
}
