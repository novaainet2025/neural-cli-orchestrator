/**
 * NCO Ensemble Engine — Mithosis-level parallel multi-agent execution
 *
 * 동일 작업을 N개 에이전트에 병렬 실행하고 QualityGate 점수로
 * 최적 결과를 선택한다. Mixture-of-Experts 방식의 앙상블.
 *
 * 동작 모드:
 *   - best-of-n  : N개 병렬 실행 → 최고 점수 결과 반환
 *   - voting     : 다수결 — 유사 답변 클러스터 중 가장 큰 것 선택
 *   - aggregate  : 모든 결과를 통합 요약 (summarizer 에이전트 사용)
 */

import { agentManager } from '../agent/agent-manager.js';
import { qualityGate, type TaskType } from './quality-gate.js';
import { adaptiveScorer } from './adaptive-scorer.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ensemble-engine');

export type EnsembleMode = 'best-of-n' | 'voting' | 'aggregate';

export interface EnsembleOptions {
  agents?: string[];          // 비어있으면 available 에이전트 자동 선택
  maxAgents?: number;         // 최대 병렬 실행 수 (기본 4)
  mode?: EnsembleMode;        // 기본: best-of-n
  taskType?: TaskType;
  threshold?: number;         // 최소 품질 임계값 (기본 55)
  timeoutMs?: number;         // 개별 에이전트 타임아웃 (기본 60s)
  aggregatorAgent?: string;   // aggregate 모드에서 통합 사용 에이전트
}

export interface AgentEnsembleResult {
  agentId: string;
  output: string;
  score: number;
  durationMs: number;
  error?: string;
}

export interface EnsembleResult {
  winner: AgentEnsembleResult;
  runnerUp?: AgentEnsembleResult;
  all: AgentEnsembleResult[];
  mode: EnsembleMode;
  totalAgents: number;
  elapsedMs: number;
}

// ── 텍스트 유사도 (Jaccard on word sets) ─────────────────────────────
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  setA.forEach(w => { if (setB.has(w)) intersection++; });
  return intersection / (setA.size + setB.size - intersection);
}

class EnsembleEngine {
  /**
   * 앙상블 실행 메인 진입점
   */
  async run(prompt: string, options: EnsembleOptions = {}): Promise<EnsembleResult> {
    const mode = options.mode ?? 'best-of-n';
    const maxAgents = options.maxAgents ?? 4;
    const taskType = options.taskType ?? 'general';
    const threshold = options.threshold ?? 55;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const start = Date.now();

    // 에이전트 목록 결정
    const agents = this.resolveAgents(options.agents, maxAgents);
    if (agents.length === 0) {
      throw new Error('No agents available for ensemble');
    }
    log.info({ mode, agents, taskType }, 'Ensemble started');

    // 병렬 실행
    const results = await this.runParallel(agents, prompt, taskType, threshold, timeoutMs);
    if (results.length === 0) {
      throw new Error('Ensemble returned no agent results');
    }

    let result: EnsembleResult;
    if (mode === 'voting') {
      result = this.selectByVoting(results, mode, start, taskType);
    } else if (mode === 'aggregate') {
      result = await this.selectByAggregation(results, prompt, options.aggregatorAgent ?? 'opencode', mode, start);
    } else {
      result = this.selectBestOfN(results, mode, start, taskType);
    }

    log.info({
      winner: result.winner.agentId,
      score: result.winner.score,
      elapsedMs: result.elapsedMs,
    }, 'Ensemble complete');

    return result;
  }

  /**
   * 사용 가능한 에이전트 목록을 결정한다.
   * 명시적 목록이 없으면 활성 에이전트에서 maxAgents개 선택.
   */
  private resolveAgents(explicit: string[] | undefined, max: number): string[] {
    if (explicit && explicit.length > 0) {
      return explicit.slice(0, max);
    }
    // 기본 앙상블 에이전트 우선순위
    const preferred = ['codex', 'cursor-agent', 'opencode', 'nvidia', 'agy', 'copilot'];
    const available = agentManager.listEnabledIds();
    const filtered = preferred.filter(id => available.includes(id));
    return filtered.slice(0, max);
  }

  /**
   * 모든 에이전트를 병렬로 실행하고 개별 결과를 수집한다.
   */
  private async runParallel(
    agents: string[],
    prompt: string,
    taskType: TaskType,
    threshold: number,
    timeoutMs: number,
  ): Promise<AgentEnsembleResult[]> {
    const tasks = agents.map(async (agentId): Promise<AgentEnsembleResult> => {
      const start = Date.now();
      let timeoutHandle: NodeJS.Timeout | undefined;
      try {
        const execPromise = agentManager.executeTask(agentId, prompt, {});
        const timeoutPromise = new Promise<never>((_, reject) =>
          { timeoutHandle = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs); }
        );
        const result = await Promise.race([execPromise, timeoutPromise]) as any;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        const output = result.output ?? result.error ?? '';
        const durationMs = Date.now() - start;
        const quality = qualityGate.evaluate(output, prompt, taskType, threshold);
        qualityGate.recordPerformance(agentId, taskType, quality.score, output.length, durationMs, true);
        return { agentId, output, score: quality.score, durationMs };
      } catch (e: any) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        const durationMs = Date.now() - start;
        qualityGate.recordPerformance(agentId, taskType, 0, 0, durationMs, false);
        return { agentId, output: '', score: 0, durationMs, error: e.message };
      }
    });

    return Promise.all(tasks);
  }

  /**
   * Best-of-N: 적응형 가중 점수 기반 최적 결과 선택
   * AdaptiveScorer 가중치 × 품질 점수로 정렬 (cold start 시 가중치=1.0)
   */
  private selectBestOfN(
    results: AgentEnsembleResult[],
    mode: EnsembleMode,
    start: number,
    taskType?: string,
  ): EnsembleResult {
    const domain = taskType ?? 'general';
    const sorted = [...results].sort((a, b) => {
      const wa = adaptiveScorer.getWeight(a.agentId, domain);
      const wb = adaptiveScorer.getWeight(b.agentId, domain);
      return (b.score * wb) - (a.score * wa);
    });
    return {
      winner: sorted[0],
      runnerUp: sorted[1],
      all: results,
      mode,
      totalAgents: results.length,
      elapsedMs: Date.now() - start,
    };
  }

  /**
   * Voting: Jaccard 유사도로 클러스터링 → 가장 큰 클러스터에서 적응형 가중 점수 최고 결과 선택
   */
  private selectByVoting(
    results: AgentEnsembleResult[],
    mode: EnsembleMode,
    start: number,
    taskType?: string,
  ): EnsembleResult {
    const SIMILARITY_THRESHOLD = 0.25;
    const domain = taskType ?? 'general';
    const clusters: AgentEnsembleResult[][] = [];

    for (const result of results) {
      if (!result.output) continue;
      let added = false;
      for (const cluster of clusters) {
        if (jaccardSimilarity(result.output, cluster[0].output) >= SIMILARITY_THRESHOLD) {
          cluster.push(result);
          added = true;
          break;
        }
      }
      if (!added) clusters.push([result]);
    }

    // 가장 큰 클러스터에서 적응형 가중 점수 최고 결과 선택
    const largestCluster = clusters.sort((a, b) => b.length - a.length)[0] ?? results;
    const winner = [...largestCluster].sort((a, b) => {
      const wa = adaptiveScorer.getWeight(a.agentId, domain);
      const wb = adaptiveScorer.getWeight(b.agentId, domain);
      return (b.score * wb) - (a.score * wa);
    })[0] ?? results[0];
    const sorted = [...results].sort((a, b) => b.score - a.score);

    log.debug({ clusterCount: clusters.length, clusterSizes: clusters.map(c => c.length) }, 'Voting clusters');

    return {
      winner,
      runnerUp: sorted.find(r => r.agentId !== winner.agentId),
      all: results,
      mode,
      totalAgents: results.length,
      elapsedMs: Date.now() - start,
    };
  }

  /**
   * Aggregate: 모든 결과를 하나의 에이전트가 통합 요약
   */
  private async selectByAggregation(
    results: AgentEnsembleResult[],
    originalPrompt: string,
    aggregatorId: string,
    mode: EnsembleMode,
    start: number,
  ): Promise<EnsembleResult> {
    const parts = results
      .filter(r => r.output)
      .map((r, i) => `## 에이전트 ${i + 1}: ${r.agentId} (점수: ${r.score})\n${r.output}`)
      .join('\n\n---\n\n');

    const aggregatePrompt = `다음은 "${originalPrompt}"에 대한 여러 AI 에이전트의 응답입니다.\n\n${parts}\n\n---\n\n위 응답들을 통합하여 가장 완성도 높은 최종 답변을 작성하라. 각 에이전트의 장점을 결합하되 중복을 제거하라.`;

    try {
      const aggResult = await agentManager.executeTask(aggregatorId, aggregatePrompt, {});
      const aggregated = aggResult.output ?? '';
      const quality = qualityGate.evaluate(aggregated, originalPrompt, 'general');

      return {
        winner: { agentId: `${aggregatorId}[aggregated]`, output: aggregated, score: quality.score, durationMs: Date.now() - start },
        all: results,
        mode,
        totalAgents: results.length,
        elapsedMs: Date.now() - start,
      };
    } catch (e: any) {
      log.error({ aggregatorId, err: e.message }, 'Aggregation failed — falling back to best-of-n');
      return this.selectBestOfN(results, 'best-of-n', start);
    }
  }

  /**
   * 단순 품질 점수 계산 (외부 호출용)
   */
  scoreOutput(output: string, prompt: string, taskType: TaskType = 'general'): number {
    return qualityGate.evaluate(output, prompt, taskType).score;
  }
}

export const ensembleEngine = new EnsembleEngine();
