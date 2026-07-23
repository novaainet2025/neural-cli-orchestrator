import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';
import { execa } from 'execa';
import { createId } from '../utils/id.js';
import { getDb } from '../storage/database.js';
import { isRedisConnected } from '../storage/redis.js';
import { createLogger } from '../utils/logger.js';
import { sharedState } from './shared-state.js';
import { cliMesh } from './cli-mesh.js';
import { logDecision } from './decision-log.js';
import {
  buildTriadPlan,
  loadTriadPolicy,
  type TriadPlan,
  type TriadProfileName,
  type TriadStageName,
} from './triad-policy.js';

const log = createLogger('triad-orchestrator');
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const SAFE_PROOF_BINARIES = new Set(['npm', 'npx', 'node', 'git', 'python3', 'pytest', 'vitest', 'tsc']);
const RUNS = new Map<string, TriadRun>();
const MAX_RUNS = 100;

type RunStatus = 'planned' | 'running' | 'completed' | 'failed' | 'blocked';
type StageStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface TriadProofCommand {
  name: string;
  command: string;
  kind: 'verifier_exit_0' | 'behavior_probe' | 'a11y' | 'user_path' | 'visual_or_dom';
  timeoutMs?: number;
}

export interface StartTriadRunOptions {
  goal: string;
  projectDir: string;
  profile?: TriadProfileName;
  ownedFiles?: string[];
  proofCommands?: TriadProofCommand[];
  dryRun?: boolean;
}

export interface TriadProofReceipt {
  name: string;
  kind: TriadProofCommand['kind'] | 'diff_scope';
  command: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  outputSnippet: string;
  capturedAt: string;
}

export interface TriadStageResult {
  name: TriadStageName;
  owner: string;
  status: StageStatus;
  attempt: number;
  taskId?: string;
  output?: string;
  error?: string;
  verifier?: Record<string, unknown>;
  receipts?: TriadProofReceipt[];
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface TriadRun {
  id: string;
  goal: string;
  projectDir: string;
  baselineSha: string | null;
  ownedFiles: string[];
  plan: TriadPlan;
  status: RunStatus;
  stages: TriadStageResult[];
  fixIterations: number;
  paidCalls: number;
  proofCommands: TriadProofCommand[];
  finalOutput?: string;
  error?: string;
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  completedAt?: string;
}

interface TaskOutcome {
  taskId: string;
  status: string;
  response: string;
  error: string | null;
  verifier: Record<string, unknown> | null;
}

interface WorkspaceSnapshot {
  dirty: Map<string, string>;
}

class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>(resolveWaiter => this.waiters.push(resolveWaiter));
    this.active++;
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }
}

const policyAtBoot = loadTriadPolicy();
const globalPaidLane = new Semaphore(policyAtBoot.parallelism.globalPaidCli);
const providerLanes = new Map<string, Semaphore>([
  ['claude-code', new Semaphore(policyAtBoot.parallelism['claude-code'])],
  ['codex', new Semaphore(policyAtBoot.parallelism.codex)],
  ['agy', new Semaphore(policyAtBoot.parallelism.agy)],
]);

function touch(run: TriadRun): void {
  run.updatedAt = new Date().toISOString();
}

function putRun(run: TriadRun): void {
  RUNS.set(run.id, run);
  while (RUNS.size > MAX_RUNS) {
    const oldest = RUNS.keys().next().value;
    if (!oldest) break;
    RUNS.delete(oldest);
  }
}

function safeOutput(value: string | null | undefined, limit = 12_000): string {
  return (value ?? '').trim().slice(0, limit);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

function isForbiddenSharedPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return normalized.startsWith('node_modules/')
    || /^db\/[^/]+\.db(?:-|$)/.test(normalized)
    || normalized.startsWith('db/hnsw-indices/')
    || (/^data\/team-runner\/.*\.last$/).test(normalized);
}

export function normalizeOwnedFiles(projectDir: string, files: string[] = []): string[] {
  const root = resolve(projectDir);
  const normalized: string[] = [];
  for (const raw of files) {
    const trimmed = raw.trim().replaceAll('\\', '/').replace(/^\.\//, '');
    if (!trimmed || trimmed.startsWith('/') || trimmed.split('/').includes('..')) {
      throw new Error(`invalid owned file path: ${raw}`);
    }
    if (isForbiddenSharedPath(trimmed)) {
      throw new Error(`shared/volatile path cannot be owned by a Triad builder: ${trimmed}`);
    }
    const absolute = resolve(root, trimmed);
    if (!isInside(root, absolute)) throw new Error(`owned file escapes projectDir: ${raw}`);
    if (!normalized.includes(trimmed)) normalized.push(trimmed);
  }
  return normalized.sort();
}

function isLinkedWorktree(projectDir: string): boolean {
  try {
    const dotGit = resolve(projectDir, '.git');
    return existsSync(dotGit) && statSync(dotGit).isFile();
  } catch {
    return false;
  }
}

function readPackageScripts(projectDir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(resolve(projectDir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

function defaultProofCommands(projectDir: string): TriadProofCommand[] {
  const scripts = readPackageScripts(projectDir);
  const commands: TriadProofCommand[] = [];
  if (scripts.build) {
    commands.push({ name: 'build', command: 'npm run build', kind: 'verifier_exit_0', timeoutMs: 180_000 });
  } else if (scripts.typecheck) {
    commands.push({ name: 'typecheck', command: 'npm run typecheck', kind: 'verifier_exit_0', timeoutMs: 180_000 });
  }
  if (scripts['test:run']) {
    commands.push({ name: 'tests', command: 'npm run test:run', kind: 'behavior_probe', timeoutMs: 300_000 });
  } else if (scripts.test) {
    commands.push({ name: 'tests', command: 'npm test -- --run', kind: 'behavior_probe', timeoutMs: 300_000 });
  }
  return commands;
}

function validateProofCommand(command: TriadProofCommand): void {
  if (!command.name.trim() || !command.command.trim()) throw new Error('proof command name and command are required');
  if (/[;|&<>$`(){}\n'"\\]/.test(command.command)) {
    throw new Error(`proof command contains forbidden shell syntax: ${command.name}`);
  }
  const [binary] = command.command.trim().split(/\s+/);
  if (!binary || binary.includes('/') || !SAFE_PROOF_BINARIES.has(binary)) {
    throw new Error(`proof binary is not allowed: ${binary || '(empty)'}`);
  }
}

function gitBaselineSha(projectDir: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 5000,
    }).trim() || null;
  } catch {
    return null;
  }
}

function hashFile(projectDir: string, path: string): string {
  const absolute = resolve(projectDir, path);
  try {
    return createHash('sha256').update(readFileSync(absolute)).digest('hex');
  } catch {
    return '<missing>';
  }
}

function captureWorkspace(projectDir: string): WorkspaceSnapshot {
  const dirty = new Map<string, string>();
  try {
    const raw = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    for (const record of raw.split('\0')) {
      if (!record) continue;
      const path = record.slice(3).split(' -> ').at(-1)?.trim();
      if (path) dirty.set(path, hashFile(projectDir, path));
    }
  } catch {
    // A non-git project can still use proof commands, but cannot claim diff scope.
  }
  return { dirty };
}

function changedSince(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  const paths = new Set([...before.dirty.keys(), ...after.dirty.keys()]);
  return [...paths].filter(path => before.dirty.get(path) !== after.dirty.get(path)).sort();
}

function parseChallenge(output: string): { passed: boolean; feedback: string } {
  const verdict = output.match(/^\s*TRIAD_VERDICT\s*:\s*(PASS|FIX)\s*$/im)?.[1]?.toUpperCase();
  if (verdict === 'PASS') return { passed: true, feedback: '' };
  if (verdict === 'FIX') return { passed: false, feedback: safeOutput(output) };
  return {
    passed: false,
    feedback: `AGY challenge omitted TRIAD_VERDICT: PASS|FIX.\n${safeOutput(output)}`,
  };
}

function parseApproval(output: string): { passed: boolean; feedback: string } {
  const decision = output.match(/^\s*TRIAD_DECISION\s*:\s*(APPROVE|REJECT)\s*$/im)?.[1]?.toUpperCase();
  if (decision === 'APPROVE') return { passed: true, feedback: '' };
  return {
    passed: false,
    feedback: decision === 'REJECT'
      ? safeOutput(output)
      : `Commander omitted TRIAD_DECISION: APPROVE|REJECT.\n${safeOutput(output)}`,
  };
}

function feedbackKey(feedback: string): string {
  return feedback.toLowerCase().replace(/\s+/g, ' ').replace(/\d+/g, '#').slice(0, 2000);
}

export class TriadOrchestrator {
  start(app: FastifyInstance, options: StartTriadRunOptions): TriadRun {
    const policy = loadTriadPolicy();
    const goal = options.goal.trim();
    const projectDir = resolve(options.projectDir);
    if (!goal) throw new Error('goal is required');
    if (!existsSync(projectDir)) throw new Error(`projectDir does not exist: ${projectDir}`);

    const plan = buildTriadPlan(goal, options.profile, policy);
    const ownedFiles = normalizeOwnedFiles(projectDir, options.ownedFiles);
    if (ownedFiles.length === 0 && !options.dryRun) {
      const mode = isLinkedWorktree(projectDir) ? 'linked worktree' : 'shared working tree';
      throw new Error(`ownedFiles[] is required for mutating Triad work (${mode})`);
    }
    const proofCommands = options.proofCommands?.length
      ? options.proofCommands
      : defaultProofCommands(projectDir);
    proofCommands.forEach(validateProofCommand);
    if (!options.dryRun) {
      const kinds = new Set(proofCommands.map(command => command.kind));
      for (const required of ['verifier_exit_0', 'behavior_probe']) {
        if (!kinds.has(required as TriadProofCommand['kind'])) {
          throw new Error(`code run requires a ${required} proof command`);
        }
      }
    }
    if (!options.dryRun && plan.providers.experience) {
      const kinds = new Set(proofCommands.map(command => command.kind));
      const missingExperienceProofs = policy.evidence.experience.filter(
        kind => !kinds.has(kind as TriadProofCommand['kind']),
      );
      if (missingExperienceProofs.length > 0) {
        throw new Error(`experience run is missing proof commands: ${missingExperienceProofs.join(', ')}`);
      }
    }
    if (!options.dryRun && !isLinkedWorktree(projectDir) && !isRedisConnected()) {
      throw new Error('shared working tree requires Redis file ownership; use an isolated linked worktree or restore Redis');
    }

    const now = new Date().toISOString();
    const run: TriadRun = {
      id: createId('triad'),
      goal,
      projectDir,
      baselineSha: gitBaselineSha(projectDir),
      ownedFiles,
      plan,
      status: options.dryRun ? 'planned' : 'running',
      stages: plan.stages.map(stage => ({
        name: stage.name,
        owner: stage.owner,
        status: stage.active ? 'pending' : 'skipped',
        attempt: 0,
      })),
      fixIterations: 0,
      paidCalls: 0,
      proofCommands,
      createdAt: now,
      updatedAt: now,
      deadlineAt: new Date(Date.now() + policy.loop.runTimeoutMs).toISOString(),
    };
    putRun(run);

    if (!options.dryRun) {
      void this.drive(app, run).catch(error => {
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
        run.completedAt = new Date().toISOString();
        touch(run);
        log.error({ runId: run.id, err: run.error }, 'Triad run failed');
      });
    }
    return run;
  }

  get(runId: string): TriadRun | null {
    return RUNS.get(runId) ?? null;
  }

  list(limit = 20): TriadRun[] {
    return [...RUNS.values()].slice(-limit).reverse();
  }

  private stage(run: TriadRun, name: TriadStageName): TriadStageResult {
    return run.stages.find(stage => stage.name === name)!;
  }

  private async drive(app: FastifyInstance, run: TriadRun): Promise<void> {
    const policy = loadTriadPolicy();
    const lockOwner = `triad:${run.id}:codex`;
    const absoluteOwnedFiles = run.ownedFiles.map(path => resolve(run.projectDir, path));
    const acquired: string[] = [];
    const workspaceBefore = captureWorkspace(run.projectDir);

    try {
      for (const file of absoluteOwnedFiles) {
        const locked = await sharedState.acquireLock(file, lockOwner, policy.parallelism.isolation.lockTtlMs);
        if (!locked) {
          const holder = await sharedState.getLockHolder(file);
          throw new Error(`file ownership conflict: ${relative(run.projectDir, file)} held by ${holder ?? 'unknown'}`);
        }
        acquired.push(file);
      }

      let planOutput = '';
      if (run.plan.providers.commander) {
        const outcome = await this.executeProviderStage(app, run, 'plan', 'claude-code', [
          'You are the NCO Triad Commander. Produce a bounded implementation contract.',
          'Return a structured handoff with goal, acceptance, planned_paths, agent_context, risks, and rollback.',
          'agent_context must name only observed file paths and tool/runtime state; mark unknowns explicitly.',
          'Do not edit files. 텍스트만 응답하고 도구/커맨드 사용 금지.',
          `Declared owned files: ${run.ownedFiles.join(', ') || '(none)'}`,
          `Goal: ${run.goal}`,
        ].join('\n\n'));
        if (outcome.status !== 'completed') throw new Error(`plan failed: ${outcome.error ?? outcome.response}`);
        planOutput = outcome.response;
      }

      let latestBuilderOutput = '';
      let feedback = '';
      let lastFeedbackKey = '';
      let previousFailedReceipts: Set<string> | null = null;
      let approvalComplete = false;

      const initial = await this.executeBuilder(app, run, 'build', [
        'You are the NCO Triad Builder. Implement the goal inside the declared file ownership boundary.',
        'Do not modify undeclared files. Preserve unrelated dirty changes. Add or update focused tests.',
        'Use the commander agent_context as a hint only; verify it before acting.',
        `Commander plan:\n${safeOutput(planOutput) || '(fast-path: no commander call)'}`,
        `Owned files:\n${run.ownedFiles.map(path => `- ${path}`).join('\n')}`,
        `Goal:\n${run.goal}`,
      ].join('\n\n'));
      latestBuilderOutput = initial.response;
      if (initial.status !== 'completed') feedback = `Build/verifier failed:\n${initial.error ?? initial.response}`;

      while (!approvalComplete) {
        if (feedback) {
          const key = feedbackKey(feedback);
          if (policy.loop.stopOnNoProgress && lastFeedbackKey && key === lastFeedbackKey) {
            return this.block(run, `no-progress: repeated failed set\n${safeOutput(feedback, 3000)}`);
          }
          lastFeedbackKey = key;
          if (run.fixIterations >= run.plan.maxFixIterations) {
            return this.block(run, `fix loop exhausted after ${run.fixIterations} iterations\n${safeOutput(feedback, 3000)}`);
          }
          run.fixIterations++;
          const fixed = await this.executeBuilder(app, run, 'fix', [
            'You are the NCO Triad Builder in a bounded repair loop.',
            'Fix only the evidenced findings below. Do not expand scope or touch undeclared files.',
            `Owned files:\n${run.ownedFiles.map(path => `- ${path}`).join('\n')}`,
            `Findings/evidence:\n${safeOutput(feedback)}`,
            `Original goal:\n${run.goal}`,
          ].join('\n\n'));
          latestBuilderOutput = fixed.response;
          feedback = fixed.status === 'completed'
            ? ''
            : `Fix/verifier failed:\n${fixed.error ?? fixed.response}`;
          if (feedback) continue;
        }

        if (run.plan.providers.experience) {
          const challenged = await this.executeProviderStage(app, run, 'challenge', 'agy', [
            'You are the NCO Triad Experience Architect and adversarial reviewer.',
            'Review only user-facing behavior, state coverage, accessibility, responsive behavior, and user-path regressions.',
            'Do not edit files. 텍스트만 응답하고 도구/커맨드 사용 금지.',
            'End with exactly one marker: TRIAD_VERDICT: PASS or TRIAD_VERDICT: FIX.',
            'For FIX, include reproducible findings, observed context, and a testable acceptance condition.',
            `Goal:\n${run.goal}`,
            `Builder report:\n${safeOutput(latestBuilderOutput)}`,
          ].join('\n\n'), policy.loop.challengeTimeoutMs);
          if (challenged.status !== 'completed') {
            return this.block(run, `AGY challenge unavailable or failed:\n${challenged.error ?? challenged.response}`);
          }
          const verdict = parseChallenge(challenged.response);
          if (!verdict.passed) {
            feedback = verdict.feedback;
            continue;
          }
        } else {
          const challenge = this.stage(run, 'challenge');
          challenge.status = 'passed';
          challenge.attempt++;
          challenge.output = 'Deterministic verifier challenge path; AGY bypassed because no experience trigger matched.';
          challenge.completedAt = new Date().toISOString();
          touch(run);
          logDecision({
            taskId: run.id,
            phase: 'triad:challenge',
            decision: 'agy=non-ui-bypass',
            reason: `taskType=${run.plan.taskType}; no experience trigger matched`,
            evidenceTier: 'T1-policy',
            actor: 'triad-orchestrator',
          });
        }

        const receipts = await this.runProof(run, workspaceBefore);
        const failedReceipts = receipts.filter(receipt => !receipt.passed);
        if (failedReceipts.length > 0) {
          const failedSet = new Set(failedReceipts.map(receipt => `${receipt.kind}:${receipt.name}`));
          if (previousFailedReceipts) {
            const priorFailedReceipts = previousFailedReceipts;
            const newFailures = [...failedSet].filter(failure => !priorFailedReceipts.has(failure));
            const noResolvedFailures = [...priorFailedReceipts].every(failure => failedSet.has(failure));
            if (policy.loop.stopOnRegression && newFailures.length > 0) {
              return this.block(run, `regression: new failed receipts after repair: ${newFailures.join(', ')}`);
            }
            if (policy.loop.stopOnNoProgress && noResolvedFailures) {
              return this.block(run, `no-progress: failed receipt set did not shrink: ${[...failedSet].join(', ')}`);
            }
          }
          previousFailedReceipts = failedSet;
          feedback = failedReceipts
            .map(receipt => `${receipt.name} (${receipt.kind}): ${receipt.outputSnippet}`)
            .join('\n\n');
          continue;
        }

        if (run.plan.providers.judge) {
          const approval = await this.executeProviderStage(app, run, 'approve', 'claude-code', [
            'You are the NCO Triad Judge. You may approve only when every machine receipt passed.',
            'Do not edit files. Natural-language claims are not evidence.',
            'End with exactly one marker: TRIAD_DECISION: APPROVE or TRIAD_DECISION: REJECT.',
            `Goal:\n${run.goal}`,
            `Builder report:\n${safeOutput(latestBuilderOutput)}`,
            `Receipts:\n${JSON.stringify(receipts, null, 2)}`,
          ].join('\n\n'));
          if (approval.status !== 'completed') {
            return this.block(run, `Commander approval unavailable or failed:\n${approval.error ?? approval.response}`);
          }
          const decision = parseApproval(approval.response);
          if (!decision.passed) {
            feedback = decision.feedback;
            continue;
          }
          run.finalOutput = approval.response;
        } else {
          const approval = this.stage(run, 'approve');
          approval.status = 'passed';
          approval.attempt++;
          approval.output = 'Auto-approved by deterministic receipts under fast profile.';
          approval.completedAt = new Date().toISOString();
          run.finalOutput = latestBuilderOutput;
          touch(run);
        }
        approvalComplete = true;
      }

      run.status = 'completed';
      run.completedAt = new Date().toISOString();
      touch(run);
      await this.meshBroadcast(run, 'approval', `Triad run completed with ${run.fixIterations} fix iteration(s).`);
    } finally {
      for (const file of acquired.reverse()) {
        await sharedState.releaseLock(file, lockOwner);
      }
    }
  }

  private async executeBuilder(
    app: FastifyInstance,
    run: TriadRun,
    stageName: 'build' | 'fix',
    prompt: string,
  ): Promise<TaskOutcome> {
    const firstVerifier = run.proofCommands.find(command => command.kind === 'verifier_exit_0');
    return this.executeProviderStage(
      app,
      run,
      stageName,
      'codex',
      prompt,
      undefined,
      firstVerifier ? {
        type: 'run',
        command: firstVerifier.command,
        timeoutMs: firstVerifier.timeoutMs,
      } : undefined,
    );
  }

  private async executeProviderStage(
    app: FastifyInstance,
    run: TriadRun,
    stageName: TriadStageName,
    provider: 'claude-code' | 'codex' | 'agy',
    prompt: string,
    timeoutMs?: number,
    verifier?: { type: 'run'; command: string; timeoutMs?: number },
  ): Promise<TaskOutcome> {
    const remainingRunMs = new Date(run.deadlineAt).getTime() - Date.now();
    if (remainingRunMs < 1_000) {
      throw new Error(`triad run timeout reached before ${stageName}`);
    }
    if (run.paidCalls >= run.plan.maxPaidCalls) {
      throw new Error(`paid-call budget exhausted (${run.plan.maxPaidCalls})`);
    }
    run.paidCalls++;
    touch(run);
    const providerLane = providerLanes.get(provider)!;

    return providerLane.run(() => globalPaidLane.run(async () => {
      const stage = this.stage(run, stageName);
      stage.status = 'running';
      stage.attempt++;
      stage.startedAt = new Date().toISOString();
      const started = Date.now();
      touch(run);
      await this.meshStage(run, provider, stageName, 'running', prompt);

      const effectiveTimeoutMs = Math.min(
        timeoutMs ?? loadTriadPolicy().loop.stageTimeoutMs,
        remainingRunMs,
      );
      const response = await app.inject({
        method: 'POST',
        url: '/api/task',
        payload: {
          ai: provider,
          prompt,
          timeout: effectiveTimeoutMs,
          metadata: {
            projectDir: run.projectDir,
            allowProviderFailover: false,
            triadRunId: run.id,
            triadStage: stageName,
            ownedFiles: run.ownedFiles,
          },
          callerSessionId: `triad:${run.id}`,
          callerAgentId: 'triad-orchestrator',
          ...(verifier ? { verifier } : {}),
        },
      });
      if (response.statusCode !== 202) {
        const body = response.json() as { error?: string; details?: unknown };
        const error = body.error ?? `task intake returned ${response.statusCode}`;
        stage.status = 'failed';
        stage.error = error;
        stage.completedAt = new Date().toISOString();
        stage.durationMs = Date.now() - started;
        touch(run);
        return { taskId: '', status: 'failed', response: '', error, verifier: null };
      }
      const body = response.json() as { taskId: string };
      stage.taskId = body.taskId;
      const outcome = await this.waitForTask(body.taskId, effectiveTimeoutMs);
      if (outcome.status === 'timed_out') {
        await app.inject({
          method: 'POST',
          url: `/api/tasks/${encodeURIComponent(body.taskId)}/cancel`,
        });
      }
      stage.status = outcome.status === 'completed' ? 'passed' : 'failed';
      stage.output = safeOutput(outcome.response);
      stage.error = outcome.error ?? undefined;
      stage.verifier = outcome.verifier ?? undefined;
      stage.completedAt = new Date().toISOString();
      stage.durationMs = Date.now() - started;
      touch(run);
      await this.meshStage(run, provider, stageName, stage.status, outcome.error ?? outcome.response);
      return outcome;
    }));
  }

  private async waitForTask(taskId: string, timeoutMs: number): Promise<TaskOutcome> {
    const deadline = Date.now() + timeoutMs + 15_000;
    while (Date.now() < deadline) {
      const row = getDb().prepare(`
        SELECT status, response, error, verifier_result_json
        FROM tasks
        WHERE id=?
      `).get(taskId) as {
        status: string;
        response: string | null;
        error: string | null;
        verifier_result_json: string | null;
      } | undefined;
      if (row && TERMINAL_TASK_STATES.has(row.status)) {
        let verifier: Record<string, unknown> | null = null;
        try {
          verifier = row.verifier_result_json ? JSON.parse(row.verifier_result_json) : null;
        } catch {}
        return {
          taskId,
          status: row.status,
          response: row.response ?? '',
          error: row.error,
          verifier,
        };
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 500));
    }
    return {
      taskId,
      status: 'timed_out',
      response: '',
      error: `triad task poll timeout after ${timeoutMs}ms`,
      verifier: null,
    };
  }

  private async runProof(run: TriadRun, before: WorkspaceSnapshot): Promise<TriadProofReceipt[]> {
    const stage = this.stage(run, 'prove');
    stage.status = 'running';
    stage.attempt++;
    stage.startedAt = new Date().toISOString();
    const receipts: TriadProofReceipt[] = [];
    const started = Date.now();

    for (const proof of run.proofCommands) {
      const [binary, ...args] = proof.command.trim().split(/\s+/);
      const capturedAt = new Date().toISOString();
      const remainingRunMs = new Date(run.deadlineAt).getTime() - Date.now();
      if (remainingRunMs <= 0) {
        receipts.push({
          name: proof.name,
          kind: proof.kind,
          command: proof.command,
          passed: false,
          exitCode: null,
          timedOut: true,
          outputSnippet: 'triad run timeout reached before proof execution',
          capturedAt,
        });
        break;
      }
      try {
        const result = await execa(binary, args, {
          cwd: run.projectDir,
          timeout: Math.min(proof.timeoutMs ?? 180_000, remainingRunMs),
          reject: false,
          all: true,
          env: process.env,
        });
        receipts.push({
          name: proof.name,
          kind: proof.kind,
          command: proof.command,
          passed: result.exitCode === 0 && !result.timedOut,
          exitCode: result.exitCode ?? null,
          timedOut: result.timedOut,
          outputSnippet: safeOutput(result.all, 4000),
          capturedAt,
        });
      } catch (error) {
        receipts.push({
          name: proof.name,
          kind: proof.kind,
          command: proof.command,
          passed: false,
          exitCode: null,
          timedOut: false,
          outputSnippet: error instanceof Error ? error.message : String(error),
          capturedAt,
        });
      }
    }

    const after = captureWorkspace(run.projectDir);
    const changed = changedSince(before, after);
    const owned = new Set(run.ownedFiles);
    const outOfScope = changed.filter(path => !owned.has(path));
    receipts.push({
      name: 'diff-scope',
      kind: 'diff_scope',
      command: 'git status snapshot delta',
      passed: outOfScope.length === 0,
      exitCode: outOfScope.length === 0 ? 0 : 1,
      timedOut: false,
      outputSnippet: outOfScope.length === 0
        ? `changed during run: ${changed.join(', ') || '(none)'}; all within ownedFiles`
        : `out-of-scope changes: ${outOfScope.join(', ')}`,
      capturedAt: new Date().toISOString(),
    });

    stage.receipts = receipts;
    stage.status = receipts.every(receipt => receipt.passed) ? 'passed' : 'failed';
    stage.completedAt = new Date().toISOString();
    stage.durationMs = Date.now() - started;
    stage.output = JSON.stringify(receipts);
    touch(run);
    await this.meshBroadcast(
      run,
      stage.status === 'passed' ? 'review' : 'warning',
      `Proof gate ${stage.status}: ${receipts.map(receipt => `${receipt.name}=${receipt.passed}`).join(', ')}`,
    );
    return receipts;
  }

  private block(run: TriadRun, reason: string): void {
    run.status = 'blocked';
    run.blockedReason = reason;
    run.completedAt = new Date().toISOString();
    touch(run);
    void this.meshBroadcast(run, 'question', `Triad run blocked; human decision required. ${safeOutput(reason, 2000)}`);
  }

  private async meshStage(
    run: TriadRun,
    provider: string,
    stage: TriadStageName,
    status: string,
    detail: string,
  ): Promise<void> {
    if (!loadTriadPolicy().mesh.enabled) return;
    const sessionId = `triad-${run.id}-${provider}`;
    const agentId = `triad-${provider}`;
    try {
      await cliMesh.heartbeat({
        sessionId,
        agentId,
        pid: process.pid,
        status: status === 'running' ? (provider === 'agy' ? 'reviewing' : 'coding') : 'idle',
        workMode: status === 'running' ? (provider === 'agy' ? 'reviewing' : 'mesh') : 'waiting',
        currentWork: `${stage}: ${run.goal.slice(0, 160)}`,
        currentFiles: provider === 'codex' ? run.ownedFiles : [],
        branch: run.baselineSha ?? 'unknown',
        collaborators: ['triad-claude-code', 'triad-codex', 'triad-agy'].filter(id => id !== agentId),
      });
      await cliMesh.sendMessage(
        sessionId,
        agentId,
        '*',
        `[${run.id}] ${stage}/${status}: ${safeOutput(detail, loadTriadPolicy().mesh.maxContextCharsPerMessage)}`,
        provider === 'agy' ? 'review' : 'info',
      );
    } catch (error) {
      log.warn({ runId: run.id, provider, stage, err: error instanceof Error ? error.message : String(error) }, 'Triad mesh bridge failed');
    }
  }

  private async meshBroadcast(
    run: TriadRun,
    type: 'approval' | 'review' | 'warning' | 'question',
    content: string,
  ): Promise<void> {
    try {
      await cliMesh.sendMessage(`triad-${run.id}`, 'triad-orchestrator', '*', content, type);
    } catch (error) {
      log.warn({ runId: run.id, err: error instanceof Error ? error.message : String(error) }, 'Triad mesh broadcast failed');
    }
  }
}

export const triadOrchestrator = new TriadOrchestrator();
