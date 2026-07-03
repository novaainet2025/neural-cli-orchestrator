import { eventBus } from '../core/event-bus.js';
import { createLogger } from '../utils/logger.js';
import type { SandboxManager } from './sandbox-manager.js';

const log = createLogger('trajectory-guard');

const DEFAULT_TOOL_BUDGET_LIMIT = 200;
const DEFAULT_TOOL_BUDGET_WINDOW_MS = 30 * 60_000;
const DEFAULT_REPEATED_TOOL_LIMIT = 10;
const DEFAULT_PING_PONG_LIMIT = 4;
const DEFAULT_TOOL_ERROR_STREAK_LIMIT = 5;
const MAX_RECENT_HOPS = 6;

export type TrajectoryBreach =
  | 'tool-budget'
  | 'tool-repeat'
  | 'ping-pong'
  | 'tool-error-streak';

export type Escalation = 'warn' | 'abort' | 'circuit-open';

export interface TrajectoryGuardConfig {
  toolBudgetLimit: number;
  toolBudgetWindowMs: number;
  repeatedToolLimit: number;
  pingPongLimit: number;
  consecutiveToolErrorLimit: number;
}

export interface ToolObservation {
  tool: string;
  ok?: boolean;
  toAgent?: string | null;
  at?: number;
  error?: string | null;
}

export interface TrajectoryTaskState {
  taskId: string;
  agentId: string;
  startedAt: number;
  escalationLevel: 0 | 1 | 2 | 3;
  lastBreach: TrajectoryBreach | null;
  toolTimestamps: number[];
  lastTool: string | null;
  repeatedToolCount: number;
  recentHops: string[];
  consecutiveToolErrors: number;
}

export interface TrajectoryDecision {
  allowed: boolean;
  breach?: TrajectoryBreach;
  escalation?: Escalation;
  reason?: string;
  snapshot: TrajectoryTaskState;
}

export class PRMTrajectoryAbortError extends Error {
  constructor(
    public readonly breach: TrajectoryBreach,
    public readonly escalation: Escalation,
    public readonly snapshot: TrajectoryTaskState,
    message: string,
  ) {
    super(message);
    this.name = 'PRMTrajectoryAbortError';
  }
}

interface GuardContext {
  taskId: string;
  agentId: string;
  sandbox: SandboxManager;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function cloneState(state: TrajectoryTaskState): TrajectoryTaskState {
  return {
    ...state,
    toolTimestamps: [...state.toolTimestamps],
    recentHops: [...state.recentHops],
  };
}

function buildConfig(): TrajectoryGuardConfig {
  return {
    toolBudgetLimit: parsePositiveInt(process.env.PRM_TOOL_BUDGET_LIMIT, DEFAULT_TOOL_BUDGET_LIMIT),
    toolBudgetWindowMs: parsePositiveInt(process.env.PRM_TOOL_BUDGET_WINDOW_MS, DEFAULT_TOOL_BUDGET_WINDOW_MS),
    repeatedToolLimit: parsePositiveInt(process.env.PRM_REPEATED_TOOL_LIMIT, DEFAULT_REPEATED_TOOL_LIMIT),
    pingPongLimit: parsePositiveInt(process.env.PRM_PING_PONG_LIMIT, DEFAULT_PING_PONG_LIMIT),
    consecutiveToolErrorLimit: parsePositiveInt(process.env.PRM_TOOL_ERROR_STREAK_LIMIT, DEFAULT_TOOL_ERROR_STREAK_LIMIT),
  };
}

export class TrajectoryGuard {
  private readonly states = new Map<string, TrajectoryTaskState>();

  constructor(private readonly config: TrajectoryGuardConfig = buildConfig()) {}

  beginTask(taskId: string, agentId: string): TrajectoryTaskState {
    const key = this.key(taskId, agentId);
    const existing = this.states.get(key);
    if (existing) return cloneState(existing);

    const state: TrajectoryTaskState = {
      taskId,
      agentId,
      startedAt: Date.now(),
      escalationLevel: 0,
      lastBreach: null,
      toolTimestamps: [],
      lastTool: null,
      repeatedToolCount: 0,
      recentHops: [],
      consecutiveToolErrors: 0,
    };
    this.states.set(key, state);
    return cloneState(state);
  }

  endTask(taskId: string, agentId: string): void {
    this.states.delete(this.key(taskId, agentId));
  }

  async beforeTool(
    ctx: GuardContext,
    observation: Pick<ToolObservation, 'tool' | 'toAgent' | 'at'>,
  ): Promise<TrajectoryDecision> {
    const state = this.ensure(ctx.taskId, ctx.agentId);
    const now = observation.at ?? Date.now();

    state.toolTimestamps.push(now);
    this.pruneToolBudget(state, now);

    if (observation.tool === state.lastTool) {
      state.repeatedToolCount++;
    } else {
      state.lastTool = observation.tool;
      state.repeatedToolCount = 1;
    }

    if (observation.tool === 'sendMessage' && observation.toAgent) {
      state.recentHops.push(`${ctx.agentId}->${observation.toAgent}`);
      if (state.recentHops.length > MAX_RECENT_HOPS) {
        state.recentHops.splice(0, state.recentHops.length - MAX_RECENT_HOPS);
      }
    }

    if (state.toolTimestamps.length > this.config.toolBudgetLimit) {
      return this.handleBreach(ctx, state, 'tool-budget', `tool budget exceeded: ${state.toolTimestamps.length}/${this.config.toolBudgetLimit} in ${this.config.toolBudgetWindowMs}ms`);
    }

    if (state.repeatedToolCount > this.config.repeatedToolLimit) {
      return this.handleBreach(ctx, state, 'tool-repeat', `repeated tool exceeded: ${observation.tool} x${state.repeatedToolCount}`);
    }

    if (this.detectPingPong(state)) {
      return this.handleBreach(ctx, state, 'ping-pong', `ping-pong detected in recent hops: ${state.recentHops.slice(-this.config.pingPongLimit).join(', ')}`);
    }

    return { allowed: true, snapshot: cloneState(state) };
  }

  async afterTool(
    ctx: GuardContext,
    observation: Pick<ToolObservation, 'tool' | 'ok' | 'error'>,
  ): Promise<TrajectoryDecision> {
    const state = this.ensure(ctx.taskId, ctx.agentId);

    if (observation.ok === false) {
      state.consecutiveToolErrors++;
      if (state.consecutiveToolErrors >= this.config.consecutiveToolErrorLimit) {
        return this.handleBreach(ctx, state, 'tool-error-streak', `consecutive tool errors reached ${state.consecutiveToolErrors}`);
      }
    } else if (observation.ok === true) {
      state.consecutiveToolErrors = 0;
    }

    return { allowed: true, snapshot: cloneState(state) };
  }

  private key(taskId: string, agentId: string): string {
    return `${taskId}:${agentId}`;
  }

  private ensure(taskId: string, agentId: string): TrajectoryTaskState {
    const key = this.key(taskId, agentId);
    const existing = this.states.get(key);
    if (existing) return existing;

    const state: TrajectoryTaskState = {
      taskId,
      agentId,
      startedAt: Date.now(),
      escalationLevel: 0,
      lastBreach: null,
      toolTimestamps: [],
      lastTool: null,
      repeatedToolCount: 0,
      recentHops: [],
      consecutiveToolErrors: 0,
    };
    this.states.set(key, state);
    return state;
  }

  private pruneToolBudget(state: TrajectoryTaskState, now: number): void {
    const cutoff = now - this.config.toolBudgetWindowMs;
    state.toolTimestamps = state.toolTimestamps.filter(ts => ts >= cutoff);
  }

  private detectPingPong(state: TrajectoryTaskState): boolean {
    const limit = this.config.pingPongLimit;
    if (state.recentHops.length < limit || limit < 4) return false;

    const window = state.recentHops.slice(-limit);
    const first = window[0];
    const second = window[1];
    if (!first || !second || first === second) return false;

    for (let i = 0; i < window.length; i++) {
      const expected = i % 2 === 0 ? first : second;
      if (window[i] !== expected) return false;
    }
    return true;
  }

  private async handleBreach(
    ctx: GuardContext,
    state: TrajectoryTaskState,
    breach: TrajectoryBreach,
    reason: string,
  ): Promise<TrajectoryDecision> {
    const nextLevel = Math.min(state.escalationLevel + 1, 3) as 1 | 2 | 3;
    state.escalationLevel = nextLevel;
    state.lastBreach = breach;

    const escalation: Escalation = nextLevel === 1
      ? 'warn'
      : nextLevel === 2
        ? 'abort'
        : 'circuit-open';

    log.warn({
      taskId: ctx.taskId,
      agentId: ctx.agentId,
      breach,
      escalation,
      reason,
      escalationLevel: nextLevel,
    }, 'PRM trajectory breach detected');

    await eventBus.publish({
      type: 'task:trajectory_warn',
      taskId: ctx.taskId,
      agentId: ctx.agentId,
      breach,
      escalation,
      reason,
      escalationLevel: nextLevel,
    });

    const snapshot = cloneState(state);
    if (nextLevel >= 3) {
      ctx.sandbox.recordFailure(`PRM trajectory breach: ${breach}`);
    }

    if (nextLevel >= 2) {
      throw new PRMTrajectoryAbortError(breach, escalation, snapshot, reason);
    }

    return {
      allowed: false,
      breach,
      escalation,
      reason,
      snapshot,
    };
  }
}

export const trajectoryGuard = new TrajectoryGuard();
