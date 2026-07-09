/**
 * NCO Quality Gate — Mithosis-level output quality evaluator
 *
 * 에이전트 출력에 0-100 품질 점수를 부여하고,
 * 임계값 미달 시 다음 에이전트로 자동 폴백 체인을 실행한다.
 *
 * 점수 구성 (합계 100점):
 *   - 길이/완성도 (30점): 너무 짧거나 에러 메시지만 있으면 감점
 *   - 구조/형식  (25점): 마크다운, 코드블록, 섹션 헤더 등 구조적 출력
 *   - 작업 충족도 (30점): 프롬프트 키워드가 출력에 얼마나 반영됐는지
 *   - 자신감/확실성 (15점): 불확실 표현("모르겠", "잘 모름", "error") 페널티
 */

import { createLogger } from '../utils/logger.js';
import { getDb } from '../storage/database.js';

const log = createLogger('quality-gate');

export type TaskType = 'general' | 'code' | 'design' | 'review' | 'verify' | 'research' | 'ui' | 'media';

export interface QualityDimensions {
  completeness: number;   // 0-30: 길이·완성도
  structure: number;      // 0-25: 구조·형식
  relevance: number;      // 0-30: 작업 충족도
  confidence: number;     // 0-15: 확실성
}

export interface QualityResult {
  score: number;           // 0-100 합산
  passed: boolean;         // score >= threshold
  dimensions: QualityDimensions;
  reasons: string[];       // 감점 사유
}

// ── 작업 유형별 키워드 → 출력 기대 키워드 맵 ─────────────────────────
const TASK_KEYWORDS: Record<TaskType, RegExp[]> = {
  code:     [/```/, /function|const|let|var|class|import|export|async/, /return|if|for/],
  design:   [/아키텍처|architecture|설계|interface|schema|diagram|구조/, /단계|phase|layer/, /고려사항|trade.?off/],
  review:   [/문제|issue|버그|bug|개선|improvement|취약|vulnerability/, /추천|recommend|제안/],
  verify:   [/테스트|test|검증|verify|통과|pass|실패|fail/, /결과|result|확인/],
  research: [/분석|analysis|결론|conclusion|요약|summary/, /참고|source|출처/],
  ui:       [/컴포넌트|component|레이아웃|layout|스타일|style/, /사용자|user|화면|screen/],
  media:    [/이미지|image|영상|video|생성|generate/],
  general:  [/.+/],
};

class QualityGate {
  private readonly defaultThreshold = 55;

  /**
   * 에이전트 출력 품질을 평가하고 0-100 점수를 반환한다.
   */
  evaluate(output: string, prompt: string, taskType: TaskType = 'general', threshold?: number): QualityResult {
    const thr = threshold ?? this.defaultThreshold;
    const reasons: string[] = [];
    const dims: QualityDimensions = { completeness: 0, structure: 0, relevance: 0, confidence: 0 };

    // ── 1. 길이·완성도 (30점) ──────────────────────────────────────
    const len = output.trim().length;
    if (len < 50) {
      dims.completeness = 0;
      reasons.push(`출력 너무 짧음 (${len}자)`);
    } else if (len < 200) {
      dims.completeness = 10;
      reasons.push('출력이 짧음');
    } else if (len < 500) {
      dims.completeness = 20;
    } else if (len < 1500) {
      dims.completeness = 27;
    } else {
      dims.completeness = 30;
    }

    // 에러 출력 페널티
    if (/^\s*(error:|exception:|traceback|failed to|could not)/im.test(output)) {
      dims.completeness = Math.max(0, dims.completeness - 15);
      reasons.push('에러 메시지 감지');
    }
    // 단순 거절 페널티
    if (/^(죄송|sorry|unable to|cannot|don't know|모르겠)/im.test(output)) {
      dims.completeness = Math.max(0, dims.completeness - 10);
      reasons.push('거절/모름 응답');
    }

    // ── 2. 구조·형식 (25점) ─────────────────────────────────────────
    const hasCode     = /```[\s\S]+?```/.test(output);
    const hasHeaders  = /^#{1,4}\s+\S/m.test(output);
    const hasBullets  = /^[\s]*[-*•]\s+\S/m.test(output);
    const hasNumbers  = /^\s*\d+[.)]\s+\S/m.test(output);
    const hasTable    = /\|.+\|.+\|/.test(output);
    const hasNewlines = (output.match(/\n/g) || []).length > 3;

    let structScore = 0;
    if (hasCode)     structScore += 10;
    if (hasHeaders)  structScore += 6;
    if (hasBullets || hasNumbers) structScore += 5;
    if (hasTable)    structScore += 4;
    if (hasNewlines) structScore += Math.min(4, structScore === 0 ? 0 : 4);
    dims.structure = Math.min(25, structScore);

    if (dims.structure < 5 && len > 300) {
      reasons.push('구조 없음 (plain text)');
    }

    // ── 3. 작업 충족도 (30점) ────────────────────────────────────────
    const patterns = TASK_KEYWORDS[taskType] ?? TASK_KEYWORDS.general;
    let matchCount = 0;
    for (const pat of patterns) {
      if (pat.test(output)) matchCount++;
    }
    const matchRatio = patterns.length > 0 ? matchCount / patterns.length : 0;
    dims.relevance = Math.round(matchRatio * 30);

    // 프롬프트 주요 단어가 출력에 반영됐는지
    const promptWords = prompt.split(/\s+/).filter(w => w.length > 3).slice(0, 10);
    const coveredWords = promptWords.filter(w => output.toLowerCase().includes(w.toLowerCase())).length;
    const promptCoverage = promptWords.length > 0 ? coveredWords / promptWords.length : 0;
    dims.relevance = Math.min(30, dims.relevance + Math.round(promptCoverage * 10));

    if (dims.relevance < 15) reasons.push('작업 요구사항 미충족');

    // ── 4. 확실성 (15점) ──────────────────────────────────────────
    const uncertainPatterns = [
      /잘\s*모르|모르겠|확실하지\s*않|불확실|아마도|어쩌면/i,
      /might be|not sure|unclear|uncertain|maybe|perhaps/i,
      /\[TODO\]|\[TBD\]|\[FIXME\]/i,
    ];
    let penaltyCount = 0;
    for (const pat of uncertainPatterns) {
      if (pat.test(output)) penaltyCount++;
    }
    dims.confidence = Math.max(0, 15 - penaltyCount * 5);
    if (penaltyCount > 0) reasons.push(`불확실 표현 ${penaltyCount}개`);

    const score = dims.completeness + dims.structure + dims.relevance + dims.confidence;

    log.debug({ score, taskType, len, reasons }, 'Quality evaluated');

    return { score, passed: score >= thr, dimensions: dims, reasons };
  }

  /**
   * 폴백 체인 — 에이전트 목록을 순서대로 시도하여 품질 임계값을 통과한 첫 번째 결과 반환.
   * executor: (agentId, prompt) => Promise<string>
   */
  async runWithFallback(
    prompt: string,
    agentChain: string[],
    executor: (agentId: string, prompt: string) => Promise<string>,
    options: { taskType?: TaskType; threshold?: number } = {},
  ): Promise<{ agentId: string; output: string; quality: QualityResult; attempts: number }> {
    const taskType = options.taskType ?? 'general';
    const threshold = options.threshold ?? this.defaultThreshold;

    let lastOutput = '';
    let lastQuality: QualityResult | null = null;
    let bestCandidate: { agentId: string; output: string; quality: QualityResult; attempt: number } | null = null;

    for (let i = 0; i < agentChain.length; i++) {
      const agentId = agentChain[i];
      const start = Date.now();
      try {
        const output = await executor(agentId, prompt);
        const quality = this.evaluate(output, prompt, taskType, threshold);
        const durationMs = Date.now() - start;

        this.recordPerformance(agentId, taskType, quality.score, output.length, durationMs, true);

        log.info({ agentId, score: quality.score, passed: quality.passed, attempt: i + 1 }, 'Quality gate check');

        if (quality.passed) {
          return { agentId, output, quality, attempts: i + 1 };
        }

        lastOutput = output;
        lastQuality = quality;
        if (!bestCandidate || quality.score > bestCandidate.quality.score) {
          bestCandidate = { agentId, output, quality, attempt: i + 1 };
        }

        if (i < agentChain.length - 1) {
          log.warn({ agentId, score: quality.score, threshold, next: agentChain[i + 1] }, 'Quality gate failed — falling back');
        }
      } catch (e: any) {
        const durationMs = Date.now() - start;
        this.recordPerformance(agentId, taskType, 0, 0, durationMs, false);
        log.error({ agentId, err: e.message }, 'Agent execution failed');
        lastOutput = `[ERROR] ${e.message}`;
        lastQuality = this.evaluate(lastOutput, prompt, taskType, threshold);
        if (!bestCandidate || lastQuality.score > bestCandidate.quality.score) {
          bestCandidate = { agentId, output: lastOutput, quality: lastQuality, attempt: i + 1 };
        }
      }
    }

    // 모든 에이전트 실패 — 마지막 결과 반환
    log.warn({ attempts: agentChain.length }, 'All agents in fallback chain failed quality gate — returning best available');
    const fallback = bestCandidate ?? {
      agentId: agentChain[agentChain.length - 1],
      output: lastOutput,
      quality: lastQuality ?? this.evaluate(lastOutput, prompt, taskType, threshold),
      attempt: agentChain.length,
    };
    return {
      agentId: fallback.agentId,
      output: fallback.output,
      quality: fallback.quality,
      attempts: fallback.attempt,
    };
  }

  /**
   * 성능 데이터를 DB에 기록하고 summary를 갱신한다.
   */
  recordPerformance(
    agentId: string,
    taskType: TaskType,
    qualityScore: number,
    outputLength: number,
    durationMs: number,
    success: boolean,
  ): void {
    try {
      const db = getDb();
      db.prepare(
        `INSERT INTO agent_performance (agent_id, task_type, success, quality_score, output_length, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(agentId, taskType, success ? 1 : 0, qualityScore, outputLength, durationMs);

      // Summary 갱신 (최근 50건 기준)
      const rows = db.prepare(
        `SELECT success, quality_score, duration_ms FROM agent_performance
         WHERE agent_id=? AND task_type=? ORDER BY created_at DESC LIMIT 50`
      ).all(agentId, taskType) as any[];

      if (rows.length > 0) {
        const successRate = rows.filter((r: any) => r.success).length / rows.length;
        const avgQuality = rows.reduce((s: number, r: any) => s + r.quality_score, 0) / rows.length;
        const avgDuration = rows.reduce((s: number, r: any) => s + r.duration_ms, 0) / rows.length;
        const sortedQ = [...rows].map((r: any) => r.quality_score).sort((a, b) => a - b);
        const p95Quality = sortedQ[Math.floor(sortedQ.length * 0.95)] ?? avgQuality;

        db.prepare(
          `INSERT OR REPLACE INTO agent_performance_summary
           (agent_id, task_type, total_runs, success_rate, avg_quality, avg_duration_ms, p95_quality, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).run(agentId, taskType, rows.length, successRate, avgQuality, avgDuration, p95Quality);
      }
    } catch (e: any) {
      log.warn({ agentId, err: e.message }, 'Failed to record performance');
    }
  }

  /**
   * 에이전트 성능 요약 조회 (smart-router 통합용)
   */
  getPerformanceSummary(taskType?: TaskType): Array<{ agentId: string; taskType: string; avgQuality: number; successRate: number; totalRuns: number }> {
    try {
      const db = getDb();
      const rows = taskType
        ? db.prepare(`SELECT * FROM agent_performance_summary WHERE task_type=? ORDER BY avg_quality DESC`).all(taskType)
        : db.prepare(`SELECT * FROM agent_performance_summary ORDER BY avg_quality DESC`).all();
      return (rows as any[]).map(r => ({
        agentId: r.agent_id,
        taskType: r.task_type,
        avgQuality: r.avg_quality,
        successRate: r.success_rate,
        totalRuns: r.total_runs,
      }));
    } catch {
      return [];
    }
  }
}

export const qualityGate = new QualityGate();
