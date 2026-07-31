/**
 * NCO Adaptive Scorer — 에이전트별 도메인 강점 학습 + 동적 가중치 조정
 *
 * 역할:
 *   - agent_performance 테이블에서 통계를 읽어 도메인별 에이전트 강점을 파악
 *   - 앙상블/교차검증에서 에이전트 신뢰도 가중치를 동적 조정
 *   - EWM(지수가중평균) 기반 실시간 학습 — 최신 성과가 더 큰 영향
 *   - Cold start: 데이터 없으면 균등 가중치(1.0) 반환
 */

import { getDb } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';
import type { TaskType } from './quality-gate.js';
import { capabilityRank, isRegistered, type ProviderTaskType } from './provider-registry.js';

const log = createLogger('adaptive-scorer');

export interface AgentDomainScore {
  agentId: string;
  taskType: TaskType | string;
  weight: number;        // 0-2.0: 1.0 = 기준, >1.0 = 강점, <1.0 = 약점
  avgQuality: number;    // 0-100
  successRate: number;   // 0-1
  sampleCount: number;
  confidence: number;    // 0-1: 샘플이 적으면 낮음
}

export interface AdaptiveWeights {
  agentId: string;
  weights: Record<string, number>;  // taskType → weight
  overallScore: number;
  lastUpdated: string;
}

const MIN_SAMPLES = 3;          // 최소 샘플 수 (미달 시 prior 가중치)
const EWM_ALPHA = 0.3;          // 지수가중평균 계수 (최신 데이터 비중)
const WEIGHT_FLOOR = 0.2;       // 최소 가중치 (완전 배제 방지)
const WEIGHT_CEILING = 2.0;     // 최대 가중치
const PERFORMANCE_FRESHNESS_MS = 14 * 24 * 60 * 60_000;
const OPERATIONAL_WINDOW_DAYS = 14;

// ── 도메인별 에이전트 사전 강점 (cold-start prior) ─────────────────────
// 경험적 지식 기반: 데이터 부족 시 이 prior를 사용
// prior 는 손으로 관리하는 경험값이다. config 에서 사라진 프로바이더의 prior 는
// 후보 목록 자체가 등록된 것만 담기므로 자연히 무시된다(표는 이력으로 보존).
//
// 이 표에 **없는** 등록 프로바이더는 예전에 무조건 1.0(중립)으로 떨어졌다.
// 2026-07-29 실측: claude-code / hermes / ollama 는 8개 taskType 어디에도 prior 가
// 없었다. ollama 는 유일한 무료 로컬 워커이고 hermes 는 research 체인 선두인데,
// 유료 프로바이더가 1.1~1.5 를 받는 동안 둘만 중립에 묶여 콜드스타트에서 밀렸다.
// 표를 손으로 늘리면 프로바이더가 바뀔 때마다 또 어긋나므로, 표에 없는 등록
// 프로바이더는 config 의 capabilities/score 에서 파생한 값을 쓴다(derivedPrior).
// 표에 적힌 값은 사람 판단이므로 그대로 존중하고 덮어쓰지 않는다.
const COLD_START_PRIORS: Record<string, Record<string, number>> = {
  code:     { codex: 1.3, 'cursor-agent': 1.4, opencode: 1.2, agy: 1.0, copilot: 1.0 },
  design:   { opencode: 1.5, agy: 1.3, codex: 1.0, copilot: 1.1, 'cursor-agent': 1.0 },
  review:   { 'cursor-agent': 1.5, opencode: 1.3, copilot: 1.2, codex: 1.1 },
  verify:   { 'cursor-agent': 1.5, codex: 1.3, opencode: 1.1, copilot: 1.0 },
  research: { copilot: 1.5, opencode: 1.2, agy: 1.1, 'cursor-agent': 1.0 },
  ui:       { agy: 1.5, opencode: 1.3, codex: 1.1, 'cursor-agent': 1.0 },
  media:    { agy: 1.3 },
  general:  { opencode: 1.2, codex: 1.1, 'cursor-agent': 1.1 },
};

const DERIVED_PRIOR_FLOOR = 1.0;   // 중립. 역량이 맞지 않으면 여기 머문다.
const DERIVED_PRIOR_SPAN = 0.09;   // 상한 1.09 — 큐레이션 최저 가산값(1.1) '미만'.
                                   // 밴드를 0.2 로 뒀더니 general 에서 파생 1.2 가
                                   // 큐레이션 최고값과 동률이 됐다. 파생은 사람 판단을
                                   // 넘어설 수 없어야 하므로 큐레이션 구간과 겹치지 않게 낮춘다.

/**
 * 큐레이션 표에 없는 등록 프로바이더의 prior 를 config 에서 파생한다.
 *
 * provider-registry.capabilityRank(taskType) 는 config 의 capabilities 매칭 수와
 * score 로 그 유형의 후보를 정렬한다. 그 순위를 [1.0, 1.09] 밴드로 사상한다.
 * - 역량이 하나도 안 맞으면 후보 목록에 없으므로 1.0(중립) 유지
 * - 밴드 상한이 큐레이션 최저 가산값(1.1) 미만이라, 큐레이션된 프로바이더 간
 *   순위는 절대 바뀌지 않는다. 바뀌는 것은 예전에 모두 1.0 으로 동률이던
 *   무-prior 그룹의 내부 순서뿐이다.
 * 미등록 id 는 파생하지 않는다 — 퇴출된 프로바이더가 prior 를 얻으면 안 된다.
 */
function derivedPrior(agentId: string, taskType: string): number | undefined {
  return derivedPriorFromRank(agentId, capabilityRank(taskType as ProviderTaskType));
}

function derivedPriorFromRank(agentId: string, ranked: readonly string[]): number | undefined {
  if (!isRegistered(agentId)) return undefined;
  const position = ranked.indexOf(agentId);
  if (position === -1) return undefined;
  const span = Math.max(1, ranked.length - 1);
  return DERIVED_PRIOR_FLOOR + DERIVED_PRIOR_SPAN * (1 - position / span);
}

interface PerformanceSummaryRow {
  avg_quality: number;
  success_rate: number;
  total_runs: number;
  last_updated?: string;
}

interface OperationalWeight {
  weight: number;
  sampleCount: number;
}

export function computeOperationalReliabilityWeight(
  successRate: number,
  avgDurationMs: number,
): number {
  const boundedSuccess = Math.max(0, Math.min(1, successRate));
  const reliability = 0.5 + boundedSuccess;
  const speed = avgDurationMs > 0
    ? Math.max(0.75, Math.min(1.25, 90_000 / avgDurationMs))
    : 1;
  return Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEILING, (reliability + speed) / 2));
}

class AdaptiveScorer {
  /**
   * 특정 에이전트의 특정 도메인 가중치 조회
   */
  getWeight(agentId: string, taskType: string): number {
    try {
      const db = getDb();
      const row = db.prepare(
        `SELECT avg_quality, success_rate, total_runs, last_updated
         FROM agent_performance_summary
         WHERE agent_id=? AND task_type=?`
      ).get(agentId, taskType) as PerformanceSummaryRow | undefined;
      const operational = this.getOperationalWeight(agentId);
      const derivedRank = capabilityRank(taskType as ProviderTaskType);
      return this.computeWeightFromInputs(agentId, taskType, row, operational, derivedRank);
    } catch {
      return 1.0;
    }
  }

  /**
   * 에이전트 목록에 대한 특정 도메인 가중치 맵 반환
   */
  getWeightsForTask(agentIds: string[], taskType: string): Record<string, number> {
    if (agentIds.length === 0) return {};
    if (agentIds.length === 1) {
      return { [agentIds[0]]: this.getWeight(agentIds[0], taskType) };
    }
    try {
      const derivedRank = capabilityRank(taskType as ProviderTaskType);
      const performanceRows = this.batchFetchPerformanceRows(agentIds, taskType);
      const operationalWeights = this.batchFetchOperationalWeights(agentIds);
      const result: Record<string, number> = {};
      for (const agentId of agentIds) {
        result[agentId] = this.computeWeightFromInputs(
          agentId,
          taskType,
          performanceRows.get(agentId),
          operationalWeights.get(agentId) ?? null,
          derivedRank,
        );
      }
      return result;
    } catch {
      const result: Record<string, number> = {};
      for (const id of agentIds) {
        result[id] = 1.0;
      }
      return result;
    }
  }

  /**
   * 가중치 기준 최적 에이전트 순위
   */
  rankAgents(agentIds: string[], taskType: string): Array<{ agentId: string; weight: number }> {
    const weights = this.getWeightsForTask(agentIds, taskType);
    return agentIds
      .map(id => ({ agentId: id, weight: weights[id] ?? 1.0 }))
      .sort((a, b) => b.weight - a.weight);
  }

  /**
   * 상위 N개 에이전트 추천 (가중치 기준)
   */
  topAgents(agentIds: string[], taskType: string, n = 3): string[] {
    return this.rankAgents(agentIds, taskType)
      .slice(0, n)
      .map(r => r.agentId);
  }

  /**
   * 가중 점수 집계 — 결과 배열에서 가중 평균 계산
   */
  weightedAverage(
    results: Array<{ agentId: string; score: number }>,
    taskType: string,
  ): number {
    if (results.length === 0) return 0;

    const weights = this.getWeightsForTask(
      results.map(({ agentId }) => agentId),
      taskType,
    );
    let totalWeight = 0;
    let weightedSum = 0;

    for (const { agentId, score } of results) {
      const w = weights[agentId] ?? 1.0;
      weightedSum += score * w;
      totalWeight += w;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  /**
   * 전체 에이전트 강점 맵 조회 (도메인별 상위 에이전트)
   */
  getDomainLeaders(): Record<string, string[]> {
    try {
      const db = getDb();
      const rows = db.prepare(
        `SELECT agent_id, task_type, avg_quality, success_rate, total_runs
         FROM agent_performance_summary
         WHERE total_runs >= ?
         ORDER BY avg_quality DESC`
      ).all(MIN_SAMPLES) as any[];

      const byDomain: Record<string, Array<{ agentId: string; weight: number }>> = {};
      for (const r of rows) {
        if (!byDomain[r.task_type]) byDomain[r.task_type] = [];
        byDomain[r.task_type].push({
          agentId: r.agent_id,
          weight: this.computeWeight(r.avg_quality, r.success_rate),
        });
      }

      const leaders: Record<string, string[]> = {};
      for (const [domain, agents] of Object.entries(byDomain)) {
        leaders[domain] = agents
          .sort((a, b) => b.weight - a.weight)
          .slice(0, 3)
          .map(a => a.agentId);
      }

      return leaders;
    } catch {
      return {};
    }
  }

  /**
   * 전체 에이전트 능력 프로파일 리포트
   */
  getAgentProfiles(): AgentDomainScore[] {
    try {
      const db = getDb();
      const rows = db.prepare(
        `SELECT agent_id, task_type, avg_quality, success_rate, total_runs
         FROM agent_performance_summary
         ORDER BY agent_id, task_type`
      ).all() as any[];

      return rows.map(r => ({
        agentId: r.agent_id,
        taskType: r.task_type,
        weight: r.total_runs >= MIN_SAMPLES
          ? this.computeWeight(r.avg_quality, r.success_rate)
          : 1.0,
        avgQuality: r.avg_quality,
        successRate: r.success_rate,
        sampleCount: r.total_runs,
        confidence: Math.min(1, r.total_runs / 20), // 20샘플 = 최대 신뢰도
      }));
    } catch {
      return [];
    }
  }

  /**
   * EWM 가중치로 새 성과 반영 업데이트
   * 직접 호출 필요 없음 — quality-gate.recordPerformance()가 DB를 업데이트하므로
   * 다음 getWeight() 호출 시 자동으로 반영됨
   */
  updateWeight(agentId: string, taskType: string, newScore: number, success: boolean): void {
    try {
      const db = getDb();
      const existing = db.prepare(
        `SELECT avg_quality, success_rate, total_runs FROM agent_performance_summary WHERE agent_id=? AND task_type=?`
      ).get(agentId, taskType) as any;

      if (!existing) {
        db.prepare(
          `INSERT INTO agent_performance_summary (agent_id, task_type, avg_quality, success_rate, total_runs, avg_duration_ms, p95_quality)
           VALUES (?, ?, ?, ?, 1, 0, ?)`
        ).run(agentId, taskType, newScore, success ? 1 : 0, newScore);
      } else {
        // EWM 업데이트
        const ewmQuality = EWM_ALPHA * newScore + (1 - EWM_ALPHA) * existing.avg_quality;
        const ewmSuccess = EWM_ALPHA * (success ? 1 : 0) + (1 - EWM_ALPHA) * existing.success_rate;
        db.prepare(
          `UPDATE agent_performance_summary SET avg_quality=?, success_rate=?, total_runs=total_runs+1 WHERE agent_id=? AND task_type=?`
        ).run(ewmQuality, ewmSuccess, agentId, taskType);
      }
    } catch (e: any) {
      log.warn({ err: e.message }, 'Failed to update weight');
    }
  }

  // ── 내부: 가중치 계산식 ───────────────────────────────────────────────
  private computeWeightFromInputs(
    agentId: string,
    taskType: string,
    row: PerformanceSummaryRow | undefined,
    operational: OperationalWeight | null,
    derivedRank: readonly string[],
  ): number {
    const domainPrior = COLD_START_PRIORS[taskType]?.[agentId];
    const globalPrior = COLD_START_PRIORS['general']?.[agentId];
    const prior = domainPrior ?? globalPrior ?? derivedPriorFromRank(agentId, derivedRank) ?? 1.0;
    const updatedAt = typeof row?.last_updated === 'string' ? Date.parse(row.last_updated) : Number.NaN;
    const fresh = Number.isFinite(updatedAt) && Date.now() - updatedAt <= PERFORMANCE_FRESHNESS_MS;

    if (!row || row.total_runs < MIN_SAMPLES || !fresh) {
      if (!operational) return prior;
      const confidence = Math.min(0.7, operational.sampleCount / 50);
      return operational.weight * confidence + prior * (1 - confidence);
    }

    const learnedWeight = this.computeWeight(row.avg_quality, row.success_rate);
    const confidence = Math.min(1, row.total_runs / 20);
    return learnedWeight * confidence + prior * (1 - confidence);
  }

  private batchFetchPerformanceRows(
    agentIds: string[],
    taskType: string,
  ): Map<string, PerformanceSummaryRow> {
    const db = getDb();
    const placeholders = agentIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT agent_id, avg_quality, success_rate, total_runs, last_updated
       FROM agent_performance_summary
       WHERE agent_id IN (${placeholders}) AND task_type=?`,
    ).all(...agentIds, taskType) as Array<PerformanceSummaryRow & { agent_id: string }>;
    const result = new Map<string, PerformanceSummaryRow>();
    for (const row of rows) {
      result.set(row.agent_id, row);
    }
    return result;
  }

  private batchFetchOperationalWeights(agentIds: string[]): Map<string, OperationalWeight> {
    const db = getDb();
    const placeholders = agentIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT agent_id,
             COUNT(*) AS samples,
             AVG(success) AS success_rate,
             AVG(CASE WHEN success=1 THEN duration_ms END) AS avg_duration_ms
      FROM agent_evolution_log
      WHERE agent_id IN (${placeholders})
        AND created_at >= datetime('now', ?)
      GROUP BY agent_id
    `).all(...agentIds, `-${OPERATIONAL_WINDOW_DAYS} days`) as Array<{
      agent_id: string;
      samples?: number;
      success_rate?: number;
      avg_duration_ms?: number;
    }>;
    const result = new Map<string, OperationalWeight>();
    for (const row of rows) {
      const sampleCount = Number(row.samples ?? 0);
      if (sampleCount < MIN_SAMPLES) continue;
      result.set(row.agent_id, {
        sampleCount,
        weight: computeOperationalReliabilityWeight(
          Number(row.success_rate ?? 0),
          Number(row.avg_duration_ms ?? 0),
        ),
      });
    }
    return result;
  }

  private computeWeight(avgQuality: number, successRate: number): number {
    // quality 0-100 → 0-1.5 (75점 = 1.0 기준점)
    const qualityWeight = (avgQuality / 75) * 1.0;
    // success 0-1 → 0.5-2.0 (선형)
    const successWeight = 0.5 + successRate * 1.5;

    const raw = (qualityWeight + successWeight) / 2;
    return Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEILING, raw));
  }

  private getOperationalWeight(agentId: string): { weight: number; sampleCount: number } | null {
    try {
      const row = getDb().prepare(`
        SELECT COUNT(*) AS samples,
               AVG(success) AS success_rate,
               AVG(CASE WHEN success=1 THEN duration_ms END) AS avg_duration_ms
        FROM agent_evolution_log
        WHERE agent_id=?
          AND created_at >= datetime('now', ?)
      `).get(agentId, `-${OPERATIONAL_WINDOW_DAYS} days`) as {
        samples?: number;
        success_rate?: number;
        avg_duration_ms?: number;
      } | undefined;
      const sampleCount = Number(row?.samples ?? 0);
      if (sampleCount < MIN_SAMPLES) return null;
      return {
        sampleCount,
        weight: computeOperationalReliabilityWeight(
          Number(row?.success_rate ?? 0),
          Number(row?.avg_duration_ms ?? 0),
        ),
      };
    } catch {
      return null;
    }
  }
}

export const adaptiveScorer = new AdaptiveScorer();
