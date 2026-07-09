/**
 * NCO Workflow Pipeline — 사용자 요청 전체 워크플로우 자동 실행
 *
 * Phase 1: 분석·라우팅 (smartRouter)
 * Phase 2: NCO 실행 (mode별 API 호출)
 * Phase 3: 품질 점수 (workflow-score.sh)
 * Phase 4: 보고서 생성 (auto-report.sh)
 * Phase 5: 임계값 미달 시 루프백 (최대 3회)
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { smartRouter } from './smart-router.js';
import { qualityGate } from './quality-gate.js';
import { eventBus } from './event-bus.js';
import { createId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('workflow-pipeline');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SCRIPTS_DIR = path.join(PROJECT_ROOT, 'scripts');
const NCO_API = process.env.NCO_API ?? 'http://localhost:6200';

export const WORKFLOW_DEFAULTS = {
  SCORE_THRESHOLD: 80,
  MAX_LOOPS: 3,
  MAX_PROMPT_LENGTH: 8000,
  POLL_INTERVAL_MS: 2000,
  POLL_TIMEOUT_MS: 300_000,
} as const;

export type WorkflowPhaseName = 'analyze' | 'execute' | 'score' | 'report' | 'loop';

export interface WorkflowPhaseResult {
  name: WorkflowPhaseName;
  status: 'pending' | 'running' | 'done' | 'failed';
  output: string;
  durationMs: number;
}

export interface WorkflowScoreDimensions {
  build: { score: number; max: number; errors?: number };
  tests: { score: number; max: number; ran?: boolean };
  nco_usage: { score: number; max: number; calls?: number; features?: string };
  plan: { score: number; max: number; done?: number; total?: number };
  changes: { score: number; max: number; files?: number };
  quality: { score: number; max: number };
}

export interface WorkflowScore {
  workflowId: string;
  total: number;
  passed: boolean;
  threshold: number;
  dimensions: WorkflowScoreDimensions;
}

export interface WorkflowPipelineOptions {
  prompt: string;
  projectDir?: string;
  planFile?: string;
  scoreThreshold?: number;
  maxLoops?: number;
  skipExecution?: boolean;
}

export interface WorkflowReport {
  workflowId: string;
  prompt: string;
  status: 'completed' | 'partial' | 'failed';
  route: { mode: string; providers: string[]; complexity: number; reasoning: string };
  phases: WorkflowPhaseResult[];
  score: WorkflowScore;
  reportPath?: string;
  loops: number;
  totalDurationMs: number;
  completedAt: string;
}

class WorkflowPipeline {
  /**
   * 전체 워크플로우 실행 — 분석 → 실행 → 점수 → 보고서
   */
  async run(options: WorkflowPipelineOptions): Promise<WorkflowReport> {
    const prompt = options.prompt?.trim();
    if (!prompt) throw new Error('prompt must be a non-empty string');
    if (prompt.length > WORKFLOW_DEFAULTS.MAX_PROMPT_LENGTH) {
      throw new Error(`prompt too long (max ${WORKFLOW_DEFAULTS.MAX_PROMPT_LENGTH} chars)`);
    }

    const workflowId = createId('workflow');
    const projectDir = options.projectDir ?? PROJECT_ROOT;
    const threshold = Math.min(100, Math.max(0, options.scoreThreshold ?? WORKFLOW_DEFAULTS.SCORE_THRESHOLD));
    const maxLoops = Math.min(WORKFLOW_DEFAULTS.MAX_LOOPS, Math.max(1, options.maxLoops ?? WORKFLOW_DEFAULTS.MAX_LOOPS));
    const phases: WorkflowPhaseResult[] = [];
    const start = Date.now();
    let loops = 0;
    let reportPath: string | undefined;
    let executionOutput = '';
    let score: WorkflowScore = this.zeroScore(workflowId, threshold);
    let route = { mode: 'task', providers: ['codex'], complexity: 3, reasoning: '' };
    let status: WorkflowReport['status'] = 'failed';

    await eventBus.publish({
      type: 'workflow:started',
      workflowId,
      prompt: prompt.slice(0, 500),
      threshold,
    });

    log.info({ workflowId, threshold, maxLoops }, 'Workflow pipeline started');

    while (loops < maxLoops) {
      loops++;

      // ── Phase 1: Analyze & Route ─────────────────────────────────────
      const analyzeStart = Date.now();
      try {
        const decision = await smartRouter.dispatch(prompt);
        route = {
          mode: decision.mode,
          providers: decision.providers,
          complexity: decision.complexity,
          reasoning: decision.reasoning,
        };
        phases.push({
          name: 'analyze',
          status: 'done',
          output: decision.reasoning,
          durationMs: Date.now() - analyzeStart,
        });
      } catch (err) {
        phases.push({
          name: 'analyze',
          status: 'failed',
          output: String(err),
          durationMs: Date.now() - analyzeStart,
        });
        break;
      }

      // ── Phase 2: Execute ───────────────────────────────────────────────
      if (!options.skipExecution) {
        const execStart = Date.now();
        try {
          executionOutput = await this.executeViaApi(prompt, route.mode, route.providers);
          const qResult = qualityGate.evaluate(executionOutput, prompt, smartRouter.inferTaskType(prompt));
          phases.push({
            name: 'execute',
            status: 'done',
            output: `mode=${route.mode} quality=${qResult.score} agents=[${route.providers.join(',')}]\n${executionOutput.slice(0, 2000)}`,
            durationMs: Date.now() - execStart,
          });
        } catch (err) {
          phases.push({
            name: 'execute',
            status: 'failed',
            output: String(err),
            durationMs: Date.now() - execStart,
          });
          status = 'failed';
          break;
        }
      } else {
        phases.push({
          name: 'execute',
          status: 'done',
          output: 'skipped (--skip-execution)',
          durationMs: 0,
        });
      }

      // ── Phase 3: Score ─────────────────────────────────────────────────
      const scoreStart = Date.now();
      const outputFile = await this.writeTempOutput(executionOutput);
      try {
        score = await this.runScoreScript(projectDir, {
          workflowId,
          planFile: options.planFile,
          outputFile,
          threshold,
        });
        phases.push({
          name: 'score',
          status: 'done',
          output: `total=${score.total}/${threshold}`,
          durationMs: Date.now() - scoreStart,
        });
      } catch (err) {
        phases.push({
          name: 'score',
          status: 'failed',
          output: String(err),
          durationMs: Date.now() - scoreStart,
        });
        break;
      }

      // ── Phase 4: Report ────────────────────────────────────────────────
      const reportStart = Date.now();
      try {
        reportPath = await this.runReportScript(projectDir, {
          workflowId,
          prompt,
          score,
          phases,
        });
        phases.push({
          name: 'report',
          status: 'done',
          output: reportPath,
          durationMs: Date.now() - reportStart,
        });
      } catch (err) {
        phases.push({
          name: 'report',
          status: 'failed',
          output: String(err),
          durationMs: Date.now() - reportStart,
        });
      }

      if (score.passed) {
        status = 'completed';
        break;
      }

      phases.push({
        name: 'loop',
        status: 'done',
        output: `Loop ${loops}/${maxLoops}: score ${score.total} < ${threshold}`,
        durationMs: 0,
      });

      if (loops >= maxLoops) {
        status = 'partial';
        break;
      }
    }

    const report: WorkflowReport = {
      workflowId,
      prompt,
      status,
      route,
      phases,
      score,
      reportPath,
      loops,
      totalDurationMs: Date.now() - start,
      completedAt: new Date().toISOString(),
    };

    await eventBus.publish({
      type: 'workflow:completed',
      workflowId,
      status,
      score: score.total,
      loops,
    });

    log.info({ workflowId, status, score: score.total, loops }, 'Workflow pipeline finished');
    return report;
  }

  private zeroScore(workflowId: string, threshold: number): WorkflowScore {
    return {
      workflowId,
      total: 0,
      passed: false,
      threshold,
      dimensions: {
        build: { score: 0, max: 25 },
        tests: { score: 0, max: 20 },
        nco_usage: { score: 0, max: 15 },
        plan: { score: 0, max: 15 },
        changes: { score: 0, max: 10 },
        quality: { score: 0, max: 15 },
      },
    };
  }

  private async writeTempOutput(output: string): Promise<string | undefined> {
    if (!output.trim()) return undefined;
    const dir = path.join(PROJECT_ROOT, '.tmp');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `workflow-output-${Date.now()}.txt`);
    await writeFile(file, output, 'utf-8');
    return file;
  }

  private async runScoreScript(
    projectDir: string,
    opts: { workflowId: string; planFile?: string; outputFile?: string; threshold: number },
  ): Promise<WorkflowScore> {
    const args = [path.join(SCRIPTS_DIR, 'workflow-score.sh'), projectDir, '--json', '--workflow-id', opts.workflowId];
    if (opts.planFile) args.push('--plan', opts.planFile);
    if (opts.outputFile) args.push('--output', opts.outputFile);

    const { stdout } = await execFileAsync('bash', args, { timeout: 120_000 });
    const parsed = JSON.parse(stdout.trim()) as WorkflowScore;
    parsed.threshold = opts.threshold;
    parsed.passed = parsed.total >= opts.threshold;
    return parsed;
  }

  private async runReportScript(
    projectDir: string,
    opts: { workflowId: string; prompt: string; score: WorkflowScore; phases: WorkflowPhaseResult[] },
  ): Promise<string> {
    const tmpDir = path.join(PROJECT_ROOT, '.tmp');
    await mkdir(tmpDir, { recursive: true });
    const phasesFile = path.join(tmpDir, `phases-${opts.workflowId}.json`);
    await writeFile(phasesFile, JSON.stringify(opts.phases), 'utf-8');

    const args = [
      path.join(SCRIPTS_DIR, 'auto-report.sh'),
      '--prompt', opts.prompt,
      '--score-json', JSON.stringify(opts.score),
      '--workflow-id', opts.workflowId,
      '--phases-json', phasesFile,
      '--project-dir', projectDir,
    ];

    const { stdout } = await execFileAsync('bash', args, { timeout: 30_000 });
    const lines = stdout.trim().split('\n');
    return lines.find(l => l.endsWith('-workflow.md')) ?? lines[lines.length - 1] ?? '';
  }

  private endpointForMode(mode: string): string {
    const map: Record<string, string> = {
      task: '/api/task',
      parallel: '/api/realtime/parallel',
      discussion: '/api/discussion',
      consensus: '/api/consensus',
      commander: '/api/commander',
      hive: '/api/hive',
      'full-pipeline': '/api/realtime/parallel',
      company: '/api/conductor',
      harness: '/api/harness',
    };
    return map[mode] ?? '/api/task';
  }

  private buildPayload(mode: string, prompt: string, providers: string[]): Record<string, unknown> {
    switch (mode) {
      case 'parallel':
      case 'full-pipeline':
        return { prompt, providers };
      case 'discussion':
        return { prompt, providers, rounds: 2 };
      case 'consensus':
        return { prompt, providers, consensusThreshold: 0.75 };
      case 'commander':
        return { prompt };
      case 'hive':
        return { prompt };
      case 'company':
        return { prompt, projectDir: PROJECT_ROOT };
      case 'harness':
        return { requirement: prompt, maxIterations: 3, scoreThreshold: 80 };
      default:
        return { ai: providers[0] ?? 'codex', prompt, mode: 'task' };
    }
  }

  private async executeViaApi(prompt: string, mode: string, providers: string[]): Promise<string> {
    const endpoint = this.endpointForMode(mode);
    const payload = this.buildPayload(mode, prompt, providers);

    const res = await fetch(`${NCO_API}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`NCO API ${endpoint} failed (${res.status}): ${errText.slice(0, 500)}`);
    }

    const data = await res.json() as Record<string, unknown>;
    const pollId = (data.taskId ?? data.sessionId ?? data.harnessId) as string | undefined;

    if (!pollId) {
      return JSON.stringify(data, null, 2);
    }

    const pollTarget = this.pollTargetForMode(mode);
    if (!pollTarget) {
      return JSON.stringify(data, null, 2);
    }

    return this.pollResult(pollTarget, pollId);
  }

  private pollTargetForMode(mode: string): 'task' | 'discussion' | null {
    switch (mode) {
      case 'discussion':
      case 'consensus':
      case 'hive':
        return 'discussion';
      case 'commander':
        return null;
      case 'harness':
        return 'task';
      default:
        return 'task';
    }
  }

  private async pollResult(kind: 'task' | 'discussion', id: string): Promise<string> {
    const deadline = Date.now() + WORKFLOW_DEFAULTS.POLL_TIMEOUT_MS;
    const path = kind === 'discussion' ? `/api/discussions/${id}` : `/api/tasks/${id}`;

    while (Date.now() < deadline) {
      const res = await fetch(`${NCO_API}${path}`);
      if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
      const data = await res.json() as Record<string, unknown>;

      const discussion = data.discussion as Record<string, unknown> | undefined;
      const task = data.task as Record<string, unknown> | undefined;
      const status = (data.status ?? discussion?.status ?? task?.status) as string | undefined;
      if (status === 'completed' || status === 'done') {
        const output = data.output ?? data.result ?? discussion?.report ?? task?.output ?? task?.response;
        return typeof output === 'string' ? output : JSON.stringify(data, null, 2);
      }
      if (status === 'failed' || status === 'error') {
        throw new Error(`Execution failed: ${JSON.stringify(data).slice(0, 500)}`);
      }

      await new Promise(r => setTimeout(r, WORKFLOW_DEFAULTS.POLL_INTERVAL_MS));
    }

    throw new Error(`Poll timeout after ${WORKFLOW_DEFAULTS.POLL_TIMEOUT_MS}ms for ${kind}/${id}`);
  }
}

export const workflowPipeline = new WorkflowPipeline();

// ── CLI entry ──────────────────────────────────────────────────────────────
async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const prompt = args.filter(a => !a.startsWith('--')).join(' ').trim();
  const skipExecution = args.includes('--skip-execution');
  const planIdx = args.indexOf('--plan');
  const planFile = planIdx >= 0 ? args[planIdx + 1] : undefined;

  if (!prompt) {
    console.error('Usage: npx tsx src/core/workflow-pipeline.ts "<prompt>" [--plan plan.md] [--skip-execution]');
    process.exit(1);
  }

  const report = await workflowPipeline.run({ prompt, planFile, skipExecution });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.status === 'completed' ? 0 : 1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runCli().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
