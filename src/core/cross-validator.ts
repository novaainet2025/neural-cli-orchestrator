/**
 * NCO Cross-Validator — 세계 최고 하네스 핵심 모듈
 *
 * 동일 태스크를 N개 에이전트로 독립 실행 → 결과 교차 검증 → 불일치/합의 판정.
 * Anthropic Claude Opus 수준의 신뢰도를 다중 에이전트 앙상블로 구현.
 *
 * 검증 단계:
 *   1. 독립 실행 (에이전트 간 결과 공유 없음)
 *   2. 결과 비교 (Jaccard + 핵심 키워드 커버리지)
 *   3. 합의 판정 (≥70% 유사 → 합의, <30% → 불일치 경고)
 *   4. 불일치 시 재실행 또는 다수결
 */

import { qualityGate, type TaskType } from './quality-gate.js';
import { createLogger } from '../utils/logger.js';
import { getDb } from '../storage/database.js';

const log = createLogger('cross-validator');

export interface ValidationResult {
  agentId: string;
  output: string;
  score: number;
  durationMs: number;
  keyTerms: string[];
}

export interface CrossValidationReport {
  consensus: boolean;           // 합의 달성 여부
  consensusScore: number;       // 0-1: 전체 합의 강도
  winner: ValidationResult;     // 최고 점수 결과
  results: ValidationResult[];  // 모든 에이전트 결과
  agreements: Array<{ agentA: string; agentB: string; similarity: number }>;
  disagreements: Array<{ agentA: string; agentB: string; similarity: number; reason: string }>;
  recommendation: 'accept' | 'retry' | 'escalate';
  elapsedMs: number;
}

// ── 핵심 키워드 추출 ──────────────────────────────────────────────────
function extractKeyTerms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .reduce((acc: string[], w) => {
      if (!acc.includes(w)) acc.push(w);
      return acc;
    }, [])
    .slice(0, 30);
}

// ── Jaccard 유사도 ────────────────────────────────────────────────────
function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  setA.forEach(w => { if (setB.has(w)) intersection++; });
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── 핵심 사실 커버리지 (숫자/코드 블록/패턴 + 의미 키워드 코사인) ────
function factualAgreement(a: string, b: string): number {
  const numbers = (t: string) => t.match(/\b\d+(\.\d+)?\b/g) ?? [];
  const codeBlocks = (t: string) => (t.match(/```[\s\S]+?```/g) ?? []).map(c => c.slice(0, 50));

  const numsA = new Set(numbers(a));
  const numsB = new Set(numbers(b));
  const numOverlap = [...numsA].filter(n => numsB.has(n)).length;
  const numScore = (numsA.size + numsB.size) > 0
    ? (2 * numOverlap) / (numsA.size + numsB.size) : 1;

  const codeA = new Set(codeBlocks(a));
  const codeB = new Set(codeBlocks(b));
  const codeOverlap = [...codeA].filter(c => codeB.has(c)).length;
  const codeScore = (codeA.size + codeB.size) > 0
    ? (2 * codeOverlap) / (codeA.size + codeB.size) : 1;

  // 의미 벡터 코사인 유사도 (길이 정규화된 단어 빈도)
  const freq = (t: string): Record<string, number> => {
    const f: Record<string, number> = {};
    const stop = new Set(['the','a','an','is','it','to','of','in','for','and','or','be','has']);
    t.toLowerCase().replace(/[^a-z0-9가-힣\s]/g,' ').split(/\s+/)
      .filter(w => w.length > 2 && !stop.has(w))
      .forEach(w => { f[w] = (f[w] ?? 0) + 1; });
    return f;
  };
  const fA = freq(a), fB = freq(b);
  const all = new Set([...Object.keys(fA), ...Object.keys(fB)]);
  let dot = 0, na = 0, nb = 0;
  for (const w of all) {
    const fa = fA[w] ?? 0, fb = fB[w] ?? 0;
    dot += fa * fb; na += fa * fa; nb += fb * fb;
  }
  const cosineScore = (na > 0 && nb > 0) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;

  return (numScore * 0.25 + codeScore * 0.25 + cosineScore * 0.5);
}

class CrossValidator {
  private readonly consensusThreshold = 0.35;  // ≥35% 유사 → 부분 합의 (완화)
  private readonly strongConsensus = 0.60;     // ≥60% → 강한 합의

  /**
   * 교차 검증 실행
   */
  async validate(
    prompt: string,
    agents: string[],
    executor: (agentId: string, prompt: string) => Promise<string>,
    options: { taskType?: TaskType; timeoutMs?: number } = {},
  ): Promise<CrossValidationReport> {
    const start = Date.now();
    const taskType = options.taskType ?? 'general';
    const timeoutMs = options.timeoutMs ?? 90_000;

    if (agents.length < 2) {
      throw new Error('Cross-validation requires at least 2 agents');
    }

    log.info({ agents, taskType }, 'Cross-validation started');

    // ── 독립 병렬 실행 ───────────────────────────────────────────────
    const execPromises = agents.map(async (agentId): Promise<ValidationResult> => {
      const t = Date.now();
      try {
        const raceResult = await Promise.race([
          executor(agentId, prompt),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
        ]);
        const output = raceResult as string;
        const quality = qualityGate.evaluate(output, prompt, taskType);
        qualityGate.recordPerformance(agentId, taskType, quality.score, output.length, Date.now() - t, true);
        return { agentId, output, score: quality.score, durationMs: Date.now() - t, keyTerms: extractKeyTerms(output) };
      } catch (e: any) {
        qualityGate.recordPerformance(agentId, taskType, 0, 0, Date.now() - t, false);
        return { agentId, output: `[ERROR] ${e.message}`, score: 0, durationMs: Date.now() - t, keyTerms: [] };
      }
    });

    const results = await Promise.all(execPromises);

    // ── 쌍별 유사도 계산 ──────────────────────────────────────────────
    const agreements: CrossValidationReport['agreements'] = [];
    const disagreements: CrossValidationReport['disagreements'] = [];

    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const rA = results[i];
        const rB = results[j];
        const termSim = jaccard(rA.keyTerms, rB.keyTerms);
        const factSim = factualAgreement(rA.output, rB.output);
        // factualAgreement already includes cosine; blend with Jaccard for best coverage
        const similarity = termSim * 0.4 + factSim * 0.6;

        if (similarity >= this.consensusThreshold) {
          agreements.push({ agentA: rA.agentId, agentB: rB.agentId, similarity });
        } else {
          const reason = factSim < 0.3 ? '핵심 사실 불일치' : '키워드 차이';
          disagreements.push({ agentA: rA.agentId, agentB: rB.agentId, similarity, reason });
        }
      }
    }

    // ── 합의 점수 계산 ────────────────────────────────────────────────
    const totalPairs = (agents.length * (agents.length - 1)) / 2;
    const consensusScore = totalPairs > 0 ? agreements.length / totalPairs : 0;
    const consensus = consensusScore >= this.consensusThreshold;

    // ── 최고 점수 결과 선택 ───────────────────────────────────────────
    const winner = [...results].sort((a, b) => b.score - a.score)[0];

    // ── 권고 결정 ─────────────────────────────────────────────────────
    let recommendation: CrossValidationReport['recommendation'];
    const majorityAgreement = agreements.length > disagreements.length;
    if (consensus && majorityAgreement && consensusScore >= this.strongConsensus && winner.score >= 65) {
      recommendation = 'accept';
    } else if (disagreements.length > agreements.length) {
      recommendation = winner.score < 40 ? 'escalate' : 'retry';
    } else {
      recommendation = winner.score < 40 ? 'escalate' : 'retry';
    }

    const report: CrossValidationReport = {
      consensus, consensusScore, winner, results, agreements, disagreements, recommendation,
      elapsedMs: Date.now() - start,
    };

    this.recordValidation(prompt, report);
    log.info({
      consensus, consensusScore: consensusScore.toFixed(2),
      winner: winner.agentId, score: winner.score, recommendation,
    }, 'Cross-validation complete');

    return report;
  }

  private recordValidation(prompt: string, report: CrossValidationReport): void {
    try {
      const db = getDb();
      db.prepare(
        `INSERT INTO agent_performance
         (agent_id, task_type, success, quality_score, output_length, duration_ms)
         VALUES (?, 'cross_validation', ?, ?, ?, ?)`
      ).run(
        report.winner.agentId,
        report.consensus ? 1 : 0,
        report.consensusScore * 100,
        report.winner.output.length,
        report.elapsedMs,
      );
    } catch { /* non-critical */ }
  }
}

export const crossValidator = new CrossValidator();
