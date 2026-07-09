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

// ── 도메인별 에이전트 사전 강점 (cold-start prior) ─────────────────────
// 경험적 지식 기반: 데이터 부족 시 이 prior를 사용
const COLD_START_PRIORS: Record<string, Record<string, number>> = {
  code:     { codex: 1.3, 'cursor-agent': 1.4, opencode: 1.2, nvidia: 0.9, agy: 1.0, copilot: 1.0 },
  design:   { opencode: 1.5, agy: 1.3, nvidia: 1.2, codex: 1.0, copilot: 1.1, 'cursor-agent': 1.0 },
  review:   { 'cursor-agent': 1.5, opencode: 1.3, copilot: 1.2, codex: 1.1, nvidia: 1.0 },
  verify:   { 'cursor-agent': 1.5, codex: 1.3, opencode: 1.1, copilot: 1.0 },
  research: { copilot: 1.5, nvidia: 1.4, opencode: 1.2, agy: 1.1, 'cursor-agent': 1.0 },
  ui:       { agy: 1.5, opencode: 1.3, codex: 1.1, 'cursor-agent': 1.0 },
  media:    { higgsfield: 1.8, agy: 1.3 },
  general:  { opencode: 1.2, codex: 1.1, 'cursor-agent': 1.1, nvidia: 1.0 },
};

class AdaptiveScorer {
  /**
   * 특정 에이전트의 특정 도메인 가중치 조회
   */
  getWeight(agentId: string, taskType: string): number {
    try {
      const db = getDb();
      const row = db.prepare(
        `SELECT avg_quality, success_rate, total_runs
         FROM agent_performance_summary
         WHERE agent_id=? AND task_type=?`
      ).get(agentId, taskType) as any;

      if (!row || row.total_runs < MIN_SAMPLES) {
        // cold-start: domain prior > global prior > default
        const domainPrior = COLD_START_PRIORS[taskType]?.[agentId];
        if (domainPrior) return domainPrior;
        const globalPrior = COLD_START_PRIORS['general']?.[agentId];
        return globalPrior ?? 1.0;
      }

      // 충분한 데이터: EWM 학습 가중치 + prior 블렌딩 (데이터 적을수록 prior 비중 ↑)
      const learnedWeight = this.computeWeight(row.avg_quality, row.success_rate);
      const prior = COLD_START_PRIORS[taskType]?.[agentId] ?? 1.0;
      const confidence = Math.min(1, row.total_runs / 20);
      return learnedWeight * confidence + prior * (1 - confidence);
    } catch {
      return 1.0;
    }
  }

  /**
   * 에이전트 목록에 대한 특정 도메인 가중치 맵 반환
   */
  getWeightsForTask(agentIds: string[], taskType: string): Record<string, number> {
    const result: Record<string, number> = {};
    for (const id of agentIds) {
      result[id] = this.getWeight(id, taskType);
    }
    return result;
  }

  /**
   * 가중치 기준 최적 에이전트 순위
   */
  rankAgents(agentIds: string[], taskType: string): Array<{ agentId: string; weight: number }> {
    return agentIds
      .map(id => ({ agentId: id, weight: this.getWeight(id, taskType) }))
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

    let totalWeight = 0;
    let weightedSum = 0;

    for (const { agentId, score } of results) {
      const w = this.getWeight(agentId, taskType);
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
  private computeWeight(avgQuality: number, successRate: number): number {
    // quality 0-100 → 0-1.5 (75점 = 1.0 기준점)
    const qualityWeight = (avgQuality / 75) * 1.0;
    // success 0-1 → 0.5-2.0 (선형)
    const successWeight = 0.5 + successRate * 1.5;

    const raw = (qualityWeight + successWeight) / 2;
    return Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEILING, raw));
  }
}

export const adaptiveScorer = new AdaptiveScorer();
