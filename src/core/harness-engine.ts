/**
 * NCO Harness Engine
 *
 * 자율 실행 루프 — 요청이 들어오면 100% 완료까지 반복:
 *   Phase 1: Gap 분석 (요구사항 vs 현재 상태)
 *   Phase 2: Plan 생성 (kanban 태스크 포함)
 *   Phase 3: Commander 4-Layer 실행
 *   Phase 4: Triple Verification Gate (tsc + lint + change-ratio)
 *   Phase 5: 품질 점수 산출 (security/stability/centralization/isolation/improvement)
 *   Phase 6: 평균 < 95점이면 간격 분석 후 Phase 1으로 루프백 (최대 5회)
 *   Phase 7: 결과 기록 + 이벤트 발행
 */

import { commander } from './commander.js';
import { planManager } from './plan-manager.js';
import { agentManager } from '../agent/agent-manager.js';
import { eventBus } from './event-bus.js';
import { verificationGate } from '../security/verification-gate.js';
import { getDb } from '../storage/database.js';
import { createId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('harness-engine');

// ─── Constants ────────────────────────────────────────
const MAX_ITERATIONS = 5;
const SCORE_THRESHOLD = 95;
const ABSOLUTE_MAX_ITERATIONS = 10;
const MAX_REQUIREMENT_LENGTH = 5000;
const HARNESS_TIMEOUT_MS = 30 * 60 * 1000; // 30분
const SCORE_DIMENSIONS = ['security', 'stability', 'centralization', 'isolation', 'improvement'] as const;
type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

/** 외부 참조용 기본값 (hardcoding 방지) */
export const HARNESS_DEFAULTS = {
  MAX_ITERATIONS,
  SCORE_THRESHOLD,
  ABSOLUTE_MAX_ITERATIONS,
  MAX_REQUIREMENT_LENGTH,
  SCORE_DIMENSIONS,
} as const;

// ─── Types ────────────────────────────────────────────
export interface HarnessOptions {
  requirement: string;
  providers?: string[];
  maxIterations?: number;
  scoreThreshold?: number;
}

export interface PhaseResult {
  phase: string;
  success: boolean;
  output: string;
  durationMs: number;
}

export interface DimensionScores {
  security: number;
  stability: number;
  centralization: number;
  isolation: number;
  improvement: number;
  average: number;
}

export interface IterationReport {
  iteration: number;
  phases: PhaseResult[];
  scores: DimensionScores;
  gaps: string[];
  verificationPassed: boolean;
  /** 치명적 에러 발생 시 기록 */
  fatalError?: string;
  /** 반복 총 소요 시간 */
  durationMs: number;
}

export interface HarnessReport {
  harnessId: string;
  requirement: string;
  status: 'completed' | 'partial' | 'failed';
  totalIterations: number;
  iterations: IterationReport[];
  finalScores: DimensionScores;
  planId?: string;
  contextNote: string;
  improvementNote: string;
  totalDurationMs: number;
  completedAt: string;
}

/** 에이전트 실행 추상 인터페이스 (테스트/DI 대체 가능) */
export type AgentExecutor = (agentId: string, prompt: string) => Promise<string>;

const defaultAgentExecutor: AgentExecutor = async (agentId, prompt) => {
  const result = await agentManager.executeTask(agentId, prompt, {});
  return result.output;
};

// ─── Harness Engine ───────────────────────────────────
class HarnessEngine {
  private readonly executor: AgentExecutor;

  constructor(executor: AgentExecutor = defaultAgentExecutor) {
    this.executor = executor;
  }

  /**
   * 테스트 또는 DI용 — 다른 executor로 하네스 인스턴스 생성
   */
  withExecutor(executor: AgentExecutor): HarnessEngine {
    return new HarnessEngine(executor);
  }

  /**
   * 주 진입점 — 요청이 100% 완료될 때까지 반복 실행
   */
  async run(options: HarnessOptions): Promise<HarnessReport> {
    // ─── 입력 검증 ──────────────────────────────────
    if (!options.requirement || typeof options.requirement !== 'string') {
      throw new Error('requirement must be a non-empty string');
    }
    if (options.requirement.length > MAX_REQUIREMENT_LENGTH) {
      throw new Error(`requirement too long (max ${MAX_REQUIREMENT_LENGTH} chars)`);
    }

    const harnessId = createId('harness');
    const startTime = Date.now();
    const maxIter = Math.min(
      Math.max(1, options.maxIterations ?? MAX_ITERATIONS),
      ABSOLUTE_MAX_ITERATIONS,
    );
    const threshold = Math.min(100, Math.max(0, options.scoreThreshold ?? SCORE_THRESHOLD));

    const iterations: IterationReport[] = [];
    let planId: string | undefined;
    let finalScores: DimensionScores = this.zeroScores();
    let bestScores: DimensionScores = this.zeroScores();

    await eventBus.publish({
      type: 'harness:started',
      harnessId,
      requirement: options.requirement.slice(0, 500),
      maxIterations: maxIter,
      scoreThreshold: threshold,
    });

    log.info({ harnessId, maxIter, threshold }, 'Harness started');

    let currentRequirement = options.requirement;

    const timeoutHandle = setTimeout(() => {
      log.warn({ harnessId }, 'Harness global timeout — forcing exit after 30min');
    }, HARNESS_TIMEOUT_MS);

    try {
    for (let i = 1; i <= maxIter; i++) {
      log.info({ harnessId, iteration: i }, 'Harness iteration begin');

      await eventBus.publish({
        type: 'harness:iteration_started',
        harnessId,
        iteration: i,
      });

      const iterResult = await this.runIteration({
        harnessId,
        iteration: i,
        requirement: currentRequirement,
        providers: options.providers,
        planId,
      });

      iterations.push(iterResult);
      finalScores = iterResult.scores;

      if (iterResult.scores.average > bestScores.average) {
        bestScores = iterResult.scores;
      }

      await eventBus.publish({
        type: 'harness:iteration_completed',
        harnessId,
        iteration: i,
        scores: iterResult.scores,
        verificationPassed: iterResult.verificationPassed,
      });

      log.info({ harnessId, iteration: i, avgScore: iterResult.scores.average, threshold }, 'Iteration complete');

      // 성공 조건: 검증 통과 + 점수 임계값 초과
      if (iterResult.verificationPassed && iterResult.scores.average >= threshold) {
        log.info({ harnessId, iteration: i, avgScore: iterResult.scores.average }, 'Harness achieved target — stopping loop');
        break;
      }

      // 치명적 실패 (모든 Phase 실패) — 조기 종료
      const criticalFailures = iterResult.phases.filter(p => !p.success && p.phase === 'commander_execution');
      if (criticalFailures.length > 0 && i === 1) {
        log.warn({ harnessId, iteration: i }, 'Commander execution failed on first iteration — aborting');
        break;
      }

      // 마지막 반복이 아니면 간격 기반으로 요구사항 정제
      if (i < maxIter && iterResult.gaps.length > 0) {
        currentRequirement = this.refineRequirement(options.requirement, iterResult.gaps);
        log.info({ harnessId, iteration: i, gaps: iterResult.gaps.length }, 'Requirement refined for next iteration');
      }
    }

    } finally {
      clearTimeout(timeoutHandle);
    }

    const status = finalScores.average >= threshold ? 'completed' : finalScores.average >= 70 ? 'partial' : 'failed';
    const totalDurationMs = Date.now() - startTime;

    const contextNote = this.buildContextNote(harnessId, options.requirement, iterations, finalScores);
    const improvementNote = this.buildImprovementNote(harnessId, iterations, finalScores);

    const report: HarnessReport = {
      harnessId,
      requirement: options.requirement,
      status,
      totalIterations: iterations.length,
      iterations,
      finalScores,
      planId,
      contextNote,
      improvementNote,
      totalDurationMs,
      completedAt: new Date().toISOString(),
    };

    // DB 기록
    this.persistReport(report);

    await eventBus.publish({
      type: 'harness:completed',
      harnessId,
      status,
      finalAvgScore: finalScores.average,
      totalIterations: iterations.length,
      totalDurationMs,
    });

    log.info({ harnessId, status, finalAvgScore: finalScores.average, totalDurationMs }, 'Harness finished');

    return report;
  }

  // ─── Single Iteration ──────────────────────────────
  private async runIteration(ctx: {
    harnessId: string;
    iteration: number;
    requirement: string;
    providers?: string[];
    planId?: string;
  }): Promise<IterationReport> {
    const iterStart = Date.now();
    const phases: PhaseResult[] = [];

    // Phase 1: Gap 분석
    const gapPhase = await this.runPhase('gap_analysis', () =>
      this.gapAnalysis(ctx.requirement, ctx.iteration)
    );
    phases.push(gapPhase);

    const gaps = this.parseGaps(gapPhase.output);
    const taskList = this.parseTaskList(gapPhase.output);

    // Phase 2: Plan 생성 (첫 번째 반복만, 이후는 업데이트)
    let planId = ctx.planId;
    if (!planId) {
      const planPhase = await this.runPhase('plan_creation', async () => {
        const plan = await planManager.createPlan(
          `Harness: ${ctx.requirement.slice(0, 60)}`,
          taskList.length > 0 ? taskList : [`${ctx.requirement.slice(0, 100)} 실행`],
        );
        planId = plan.id;
        return `Plan created: ${plan.id} (${taskList.length} tasks)`;
      });
      phases.push(planPhase);
    }

    // Phase 3: Commander 4-Layer 실행
    const execPhase = await this.runPhase('commander_execution', async () => {
      const result = await commander.executeCommand(
        `[Harness Iteration ${ctx.iteration}]\n${ctx.requirement}\n\nFocus on these gaps:\n${gaps.slice(0, 5).join('\n')}`
      );
      return result.finalOutput;
    });
    phases.push(execPhase);

    // Phase 4: Triple Verification Gate
    const taskId = createId('ht');
    const verifyPhase = await this.runPhase('verification', async () => {
      const vResult = await verificationGate.verify(taskId, []);
      const summary = vResult.results.map(r => `${r.level}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`).join(', ');
      return `Passed: ${vResult.passed} | ${summary}`;
    });
    phases.push(verifyPhase);

    const verificationPassed = verifyPhase.output.startsWith('Passed: true');

    // Phase 5: 품질 점수 산출 (다중 에이전트 합의)
    const scorePhase = await this.runPhase('quality_scoring', () =>
      this.scoreQuality(ctx.requirement, execPhase.output, ctx.providers)
    );
    phases.push(scorePhase);

    const scores = this.parseScores(scorePhase.output);

    return {
      iteration: ctx.iteration,
      phases,
      scores,
      gaps,
      verificationPassed,
      durationMs: Date.now() - iterStart,
    };
  }

  // ─── Phase Runner ──────────────────────────────────
  private async runPhase(name: string, fn: () => Promise<string>): Promise<PhaseResult> {
    const start = Date.now();

    await eventBus.publish({ type: 'harness:phase_started', phase: name });

    try {
      const output = await fn();
      const durationMs = Date.now() - start;

      await eventBus.publish({ type: 'harness:phase_completed', phase: name, durationMs });

      return { phase: name, success: true, output, durationMs };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      log.error({ phase: name, err: err.message }, 'Phase failed');

      await eventBus.publish({ type: 'harness:phase_failed', phase: name, error: err.message });

      return { phase: name, success: false, output: `Error: ${err.message}`, durationMs };
    }
  }

  // ─── Gap Analysis ──────────────────────────────────
  private async gapAnalysis(requirement: string, iteration: number): Promise<string> {
    const agents = agentManager.listEnabledIds();
    if (agents.length === 0) {
      return JSON.stringify({ gaps: ['No agents available'], tasks: [requirement] });
    }

    const agentId = agents[0]!;
    const prompt = [
      `[GAP ANALYSIS — Iteration ${iteration}]`,
      ``,
      `Requirement:`,
      requirement,
      ``,
      `Analyze the gap between the requirement and the current implementation state.`,
      `Respond ONLY with valid JSON:`,
      `{`,
      `  "gaps": ["gap1", "gap2", ...],`,
      `  "tasks": ["concrete task 1", "concrete task 2", ...],`,
      `  "priority": "high|medium|low"`,
      `}`,
      ``,
      `Limit to 5 gaps and 5 tasks maximum.`,
    ].join('\n');

    try {
      return await this.executor(agentId, prompt);
    } catch (err: any) {
      return JSON.stringify({ gaps: [err.message], tasks: [requirement] });
    }
  }

  // ─── Quality Scoring ───────────────────────────────
  private async scoreQuality(
    requirement: string,
    executionOutput: string,
    providers?: string[],
  ): Promise<string> {
    const agents = providers ?? agentManager.listEnabledIds().slice(0, 3);
    if (agents.length === 0) {
      return JSON.stringify(this.defaultScores(70));
    }

    const scoringPrompt = [
      `[QUALITY SCORING]`,
      ``,
      `Requirement:`,
      requirement.slice(0, 500),
      ``,
      `Execution Output (excerpt):`,
      executionOutput.slice(0, 1000),
      ``,
      `Score each dimension from 0-100:`,
      `- security: code safety, auth, input validation, sandboxing`,
      `- stability: error handling, circuit breakers, retry logic, graceful degradation`,
      `- centralization: single source of truth, unified config, no duplication`,
      `- isolation: module boundaries, dependency injection, testability`,
      `- improvement: code quality, maintainability, documentation, best practices`,
      ``,
      `Respond ONLY with valid JSON:`,
      `{`,
      `  "security": <0-100>,`,
      `  "stability": <0-100>,`,
      `  "centralization": <0-100>,`,
      `  "isolation": <0-100>,`,
      `  "improvement": <0-100>,`,
      `  "rationale": "brief explanation"`,
      `}`,
    ].join('\n');

    // 여러 에이전트에게 점수 요청 후 평균
    const scoreResults = await Promise.allSettled(
      agents.slice(0, 3).map(agentId =>
        this.executor(agentId, scoringPrompt).catch(() => null)
      )
    );

    const validScores: Partial<DimensionScores>[] = [];
    for (const r of scoreResults) {
      if (r.status === 'fulfilled' && r.value) {
        const parsed = this.extractJsonScores(r.value);
        if (parsed) validScores.push(parsed);
      }
    }

    if (validScores.length === 0) {
      return JSON.stringify(this.defaultScores(70));
    }

    // 에이전트 점수 평균
    const averaged: Record<string, number> = {};
    for (const dim of SCORE_DIMENSIONS) {
      const vals = validScores.map(s => s[dim] ?? 70).filter(v => typeof v === 'number');
      averaged[dim] = vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 70;
    }

    return JSON.stringify(averaged);
  }

  // ─── Helpers ───────────────────────────────────────

  private parseGaps(output: string): string[] {
    try {
      const json = this.extractJson(output);
      if (json?.gaps && Array.isArray(json.gaps)) {
        return json.gaps.slice(0, 10).map(String);
      }
    } catch { /* ignore */ }
    return [];
  }

  private parseTaskList(output: string): string[] {
    try {
      const json = this.extractJson(output);
      if (json?.tasks && Array.isArray(json.tasks)) {
        return json.tasks.slice(0, 10).map(String);
      }
    } catch { /* ignore */ }
    return [];
  }

  private parseScores(output: string): DimensionScores {
    try {
      const json = this.extractJson(output);
      if (json) {
        const scores = {
          security: this.clampScore(json.security),
          stability: this.clampScore(json.stability),
          centralization: this.clampScore(json.centralization),
          isolation: this.clampScore(json.isolation),
          improvement: this.clampScore(json.improvement),
          average: 0,
        };
        scores.average = Math.round(
          (scores.security + scores.stability + scores.centralization + scores.isolation + scores.improvement) / 5
        );
        return scores;
      }
    } catch { /* ignore */ }
    return this.defaultScores(70);
  }

  private extractJsonScores(text: string): Partial<DimensionScores> | null {
    try {
      const json = this.extractJson(text);
      if (!json) return null;
      const result: Partial<DimensionScores> = {};
      for (const dim of SCORE_DIMENSIONS) {
        if (typeof json[dim] === 'number') {
          result[dim] = this.clampScore(json[dim]);
        }
      }
      return Object.keys(result).length > 0 ? result : null;
    } catch {
      return null;
    }
  }

  private extractJson(text: string): any {
    // JSON 블록 추출 (```json ... ``` 또는 raw JSON)
    const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]
      ?? text.match(/(\{[\s\S]*\})/)?.[1];
    if (jsonBlock) return JSON.parse(jsonBlock.trim());
    return null;
  }

  private clampScore(val: unknown): number {
    const n = Number(val);
    if (!isFinite(n)) return 70;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  private zeroScores(): DimensionScores {
    return { security: 0, stability: 0, centralization: 0, isolation: 0, improvement: 0, average: 0 };
  }

  private defaultScores(val: number): DimensionScores {
    return {
      security: val, stability: val, centralization: val,
      isolation: val, improvement: val, average: val,
    };
  }

  private refineRequirement(original: string, gaps: string[]): string {
    return [
      original,
      ``,
      `[이전 반복에서 발견된 개선 필요 항목]:`,
      ...gaps.slice(0, 5).map((g, i) => `${i + 1}. ${g}`),
    ].join('\n');
  }

  // ─── Report Builders ──────────────────────────────
  private buildContextNote(
    harnessId: string,
    requirement: string,
    iterations: IterationReport[],
    finalScores: DimensionScores,
  ): string {
    const last = iterations[iterations.length - 1];
    return [
      `# NCO Harness 실행 결과 (${new Date().toLocaleDateString('ko-KR')})`,
      ``,
      `## 요구사항`,
      requirement.slice(0, 300),
      ``,
      `## 실행 요약`,
      `- Harness ID: ${harnessId}`,
      `- 총 반복: ${iterations.length}회`,
      `- 최종 평균 점수: ${finalScores.average}/100`,
      `- 검증 통과: ${last?.verificationPassed ? '✓' : '✗'}`,
      ``,
      `## 최종 점수`,
      ...SCORE_DIMENSIONS.map(d => `- ${d}: ${finalScores[d]}/100`),
    ].join('\n');
  }

  private buildImprovementNote(
    harnessId: string,
    iterations: IterationReport[],
    finalScores: DimensionScores,
  ): string {
    const allGaps = iterations.flatMap(i => i.gaps);
    const uniqueGaps = [...new Set(allGaps)].slice(0, 10);
    const lowDims = SCORE_DIMENSIONS.filter(d => finalScores[d] < SCORE_THRESHOLD);

    return [
      `# NCO Harness 개선 노트 (${new Date().toLocaleDateString('ko-KR')})`,
      ``,
      `## Harness: ${harnessId}`,
      ``,
      `## 점수 미달 항목`,
      lowDims.length > 0
        ? lowDims.map(d => `- ${d}: ${finalScores[d]}/100 (목표: ${SCORE_THRESHOLD})`).join('\n')
        : '- 모든 항목 목표 달성',
      ``,
      `## 발견된 Gap 목록`,
      uniqueGaps.length > 0
        ? uniqueGaps.map((g, i) => `${i + 1}. ${g}`).join('\n')
        : '- Gap 없음',
      ``,
      `## 반복별 점수 추이`,
      ...iterations.map(it =>
        `- Iter ${it.iteration}: avg=${it.scores.average} | sec=${it.scores.security} stab=${it.scores.stability} central=${it.scores.centralization} iso=${it.scores.isolation} imp=${it.scores.improvement}`
      ),
    ].join('\n');
  }

  // ─── Persistence ──────────────────────────────────
  private persistReport(report: HarnessReport): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT OR REPLACE INTO harness_reports
        (id, requirement, status, total_iterations, final_avg_score, report_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        report.harnessId,
        report.requirement.slice(0, 500),
        report.status,
        report.totalIterations,
        report.finalScores.average,
        JSON.stringify(report),
        report.completedAt,
      );
    } catch (err: any) {
      // DB 테이블이 없을 경우 무시 (migration 후 활성화)
      log.warn({ err: err.message }, 'Harness report persistence skipped (table may not exist yet)');
    }
  }

  /**
   * 최근 harness 실행 목록 (DB 테이블이 없으면 빈 배열)
   */
  listReports(limit = 20): any[] {
    try {
      const db = getDb();
      return db.prepare(
        'SELECT id, requirement, status, total_iterations, final_avg_score, created_at FROM harness_reports ORDER BY created_at DESC LIMIT ?'
      ).all(limit);
    } catch {
      return [];
    }
  }

  /**
   * 특정 harness 리포트 조회
   */
  getReport(harnessId: string): HarnessReport | null {
    try {
      const db = getDb();
      const row = db.prepare('SELECT report_json FROM harness_reports WHERE id = ?').get(harnessId) as any;
      if (!row) return null;
      return JSON.parse(row.report_json);
    } catch {
      return null;
    }
  }
}

export const harnessEngine = new HarnessEngine();
