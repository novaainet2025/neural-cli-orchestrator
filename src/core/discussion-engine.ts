import { z } from 'zod';
import { eventBus } from './event-bus.js';
import { sharedState } from './shared-state.js';
import { agentManager } from '../agent/agent-manager.js';
import { getDb } from '../storage/database.js';
import { createSessionId, createMessageId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';
import { sortProvidersByCostOrder } from './smart-router.js';
import { env } from '../utils/config.js';
import {
  linkWorkflowDiscussion,
  markWorkflowStage,
} from './workflow-gate.js';

const log = createLogger('discussion-engine');

// ─── Zod Schema for structured evaluation JSON ────────
const EvalScoreSchema = z.object({
  scores: z.record(z.string(), z.number().min(1).max(10)),
  winner: z.string().optional(),
  reason: z.string().optional(),
});

// ─── Types ────────────────────────────────────────────
export type DiscussionMode = 'task' | 'parallel' | 'discussion' | 'realtime' | 'consensus' | 'hive' | 'broadcast' | 'commander';

export interface DiscussionOptions {
  topic: string;
  mode: DiscussionMode;
  providers?: string[];
  maxRounds?: number;
  consensusThreshold?: number;
  workspaceId?: string;
  initiator?: string;
  sessionId?: string; // caller can inject a pre-created sessionId
  taskId?: string;
  teamId?: string;
  companyRunId?: string;
  workflowRunId?: string;
  /** 호출자가 지정한 실제 작업 저장소. 미지정일 때만 NCO 기본 PROJECT_DIR을 사용한다. */
  projectDir?: string;
}

export const resolveDiscussionProjectDir = (
  options: Pick<DiscussionOptions, 'projectDir'>
): string => options.projectDir?.trim() || env.PROJECT_DIR;

export interface DiscussionRoundResult {
  round: number;
  responses: Record<string, string>;
  evaluations?: Record<string, Record<string, number>>;
  consensusRate: number;
}

export interface DiscussionReport {
  sessionId: string;
  topic: string;
  mode: DiscussionMode;
  participants: string[];
  rounds: DiscussionRoundResult[];
  finalConsensusRate: number;
  adoptedProposal: string;
  rationale: string;
  dissentingOpinions: string[];
  totalDurationMs: number;
}

interface DiscussionRoundSnapshot {
  round: number;
  type: string;
  responses: Record<string, string>;
  scores?: Record<string, Record<string, number>>;
  consensusRate?: number;
  savedAt: string;
}

interface DiscussionResultState {
  roundSnapshots?: DiscussionRoundSnapshot[];
  [key: string]: unknown;
}

interface DiscussionTaskOutput {
  success?: boolean;
  output?: unknown;
  error?: string;
}

export const requireDiscussionOutput = (
  providerId: string,
  result: DiscussionTaskOutput,
): string => {
  const output = typeof result.output === 'string' ? result.output.trim() : '';
  if (result.success !== true || !output) {
    const reason = result.error?.trim() || (result.success === true ? 'empty response' : 'execution failed');
    throw new Error(`${providerId}: ${reason}`);
  }
  return output;
};

export const DISCUSSION_MIN_RESPONSE_LENGTH = {
  proposal: 160,
  evaluation: 160,
  synthesis: 120,
} as const;

export const requireSubstantiveDiscussionOutput = (
  providerId: string,
  result: DiscussionTaskOutput,
  messageType: keyof typeof DISCUSSION_MIN_RESPONSE_LENGTH,
): string => {
  const output = requireDiscussionOutput(providerId, result);
  const minimumLength = DISCUSSION_MIN_RESPONSE_LENGTH[messageType];
  if (output.length < minimumLength) {
    throw new Error(
      `${providerId}: silent-failure: non-substantive ${messageType} response `
      + `(${output.length}/${minimumLength} chars)`,
    );
  }
  return output;
};

export const DISCUSSION_EVENT_CONTENT_LIMIT = 16_000;

export const buildDiscussionEventContent = (
  output: string,
): {
  content: string;
  contentLength: number;
  contentTruncated: boolean;
} => ({
  content: output.slice(0, DISCUSSION_EVENT_CONTENT_LIMIT),
  contentLength: output.length,
  contentTruncated: output.length > DISCUSSION_EVENT_CONTENT_LIMIT,
});

export const formatDiscussionProposalContent = (
  content: string,
  maxLength: number,
): string => {
  const limit = Math.max(200, Math.floor(maxLength));
  if (content.length <= limit) {
    return content;
  }

  const marker = `\n\n... [중간 ${content.length - limit}자 생략 · 원문은 DB에 보존] ...\n\n`;
  const available = Math.max(2, limit - marker.length);
  const headLength = Math.ceil(available * 0.7);
  const tailLength = available - headLength;
  return `${content.slice(0, headLength)}${marker}${content.slice(-tailLength)}`;
};

export const selectDiscussionSynthesisProvider = (
  responsiveParticipants: string[],
): string | undefined => {
  const priority = ['claude-code', 'codex', 'agy', 'nvidia', 'opencode', 'cursor-agent'];
  return priority.find(provider => responsiveParticipants.includes(provider))
    ?? responsiveParticipants[0];
};

export function selectDiscussionConclusion(
  rounds: DiscussionRoundResult[],
  participants: string[],
): { adoptedAgent: string; adoptedProposal: string } {
  const firstRound = rounds[0];
  const proposals = Object.entries(firstRound?.responses ?? {})
    .filter(([, content]) => content.trim().length > 0);
  if (proposals.length < 2) {
    throw new Error(`discussion_insufficient_valid_proposals:${proposals.length}/2`);
  }

  // 최종 synthesis가 성공했다면 이것이 토론 전체의 산출물이다. 기존 구현은 마지막
  // synthesis round에서 evaluations가 없다는 이유로 participants[0]의 R1을 되돌려,
  // higgsfield UUID 같은 무효 제안을 최종 응답으로 저장했다.
  const synthesis = rounds.slice(1).reverse()
    .filter(round => !round.evaluations)
    .map(round => Object.entries(round.responses)
      .map(([agent, output]) => [agent, output.trim()] as const)
      .find(([, output]) => Boolean(output)))
    .find((entry): entry is readonly [string, string] => Boolean(entry));
  if (synthesis) {
    return { adoptedAgent: synthesis[0], adoptedProposal: synthesis[1] };
  }

  const evaluationRound = [...rounds].reverse().find(round => round.evaluations);
  let adoptedAgent = proposals[0][0];
  let maxVotes = 0;
  if (evaluationRound?.evaluations) {
    const voteCounts: Record<string, number> = {};
    for (const evalScores of Object.values(evaluationRound.evaluations)) {
      let best = '';
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const [target, score] of Object.entries(evalScores)) {
        if (score > bestScore) {
          bestScore = score;
          best = target;
        }
      }
      if (best && firstRound.responses[best]) {
        voteCounts[best] = (voteCounts[best] ?? 0) + 1;
      }
    }
    for (const [agent, count] of Object.entries(voteCounts)) {
      if (count > maxVotes) {
        maxVotes = count;
        adoptedAgent = agent;
      }
    }
  }

  return {
    adoptedAgent,
    adoptedProposal: firstRound.responses[adoptedAgent] ?? proposals[0][1],
  };
}

// ─── PID Controller (동적 consensus threshold 조정) ──
class PIDController {
  private integral = 0;
  private prevError = 0;

  constructor(
    private readonly kp = 0.4,
    private readonly ki = 0.05,
    private readonly kd = 0.1,
  ) {}

  /**
   * Compute next threshold adjustment.
   * setpoint = target consensus rate, measurement = current rate.
   * Returns a delta in [-0.15, +0.15] to clamp threshold drift.
   */
  compute(setpoint: number, measurement: number, dt = 1): number {
    const error = setpoint - measurement;
    this.integral += error * dt;
    const derivative = (error - this.prevError) / dt;
    this.prevError = error;
    const output = this.kp * error + this.ki * this.integral + this.kd * derivative;
    return Math.max(-0.15, Math.min(0.15, output));
  }

  reset(): void {
    this.integral = 0;
    this.prevError = 0;
  }
}

// ─── Discussion Engine ────────────────────────────────
class DiscussionEngine {
  private sessionTrustScores = new Map<string, Map<string, number>>();
  /** Long-term reputation is isolated per discussion session to avoid cross-session contamination. */
  private sessionReputationScores = new Map<string, Map<string, number>>();
  private sessionPidControllers = new Map<string, PIDController>();
  private realtimeListeners = new Map<string, Array<{ eventType: 'discussion:message' | 'discussion:user_intervention'; handler: (event: any) => void }>>();

  // ═══ 단일 작업 위임 (mode: task) ═══
  async executeTask(agentId: string, prompt: string, options?: { systemPrompt?: string }): Promise<string> {
    const result = await agentManager.executeTask(agentId, prompt, options);
    return requireDiscussionOutput(agentId, result);
  }

  // ═══ 병렬 실행 (mode: parallel) ═══
  async executeParallel(prompt: string, providers: string[]): Promise<Record<string, string>> {
    const sessionId = createSessionId();

    await eventBus.publish({
      type: 'discussion:started', sessionId,
      mode: 'parallel', topic: prompt, participants: providers,
    });

    const results = await Promise.allSettled(
      providers.map(async (pid) => {
        await eventBus.publish({
          type: 'discussion:provider_started', sessionId, agentId: pid,
        });
        try {
          const result = await agentManager.executeTask(pid, prompt);
          const output = requireSubstantiveDiscussionOutput(pid, result, 'proposal');
          await eventBus.publish({
            type: 'discussion:provider_completed', sessionId, agentId: pid,
            messageType: 'parallel',
            ...buildDiscussionEventContent(output),
          });
          return { pid, output };
        } catch (error) {
          await eventBus.publish({
            type: 'discussion:provider_failed', sessionId, agentId: pid,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      })
    );

    const responses: Record<string, string> = {};
    for (const r of results) {
      if (r.status === 'fulfilled') {
        responses[r.value.pid] = r.value.output;
      }
    }

    await eventBus.publish({
      type: 'discussion:completed', sessionId, mode: 'parallel', responses,
    });

    return responses;
  }

  // ═══ 전체 브로드캐스트 (mode: broadcast) ═══
  async executeBroadcast(message: string, providers: string[]): Promise<void> {
    await eventBus.publish({
      type: 'message:broadcast',
      from: 'system',
      content: message,
      targets: providers,
    });
  }

  // ═══ 라운드 기반 토론 (mode: discussion, consensus, hive) ═══
  async startDiscussion(options: DiscussionOptions): Promise<DiscussionReport> {
    // Hive mode has a distinct execution path — skip round-based discussion
    if (options.mode === 'hive') {
      return this.executeHive(options);
    }

    const sessionId = options.sessionId || createSessionId();
    const startTime = Date.now();
    const maxRounds = options.maxRounds || 3;
    let threshold = options.consensusThreshold || 0.8;
    const participants = options.providers || this.selectParticipants(options.mode);
    const initiator = options.initiator || 'claude-code';
    const projectDir = resolveDiscussionProjectDir(options);
    const pidController = this.getSessionPid(sessionId);
    const trustScores = this.getSessionTrustScores(sessionId);
    this.getSessionReputationScores(sessionId);
    pidController.reset();
    trustScores.clear();
    for (const pid of participants) trustScores.set(pid, 1.0);

    // Save session to DB
    const db = getDb();
    db.prepare(`
      INSERT INTO discussions (
        id, topic, mode, status, participants_json, initiator, max_rounds,
        consensus_threshold, task_id, team_id, company_run_id, workflow_run_id
      )
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      options.topic,
      options.mode,
      JSON.stringify(participants),
      initiator,
      maxRounds,
      threshold,
      options.taskId ?? null,
      options.teamId ?? null,
      options.companyRunId ?? null,
      options.workflowRunId ?? null,
    );
    if (options.workflowRunId) {
      linkWorkflowDiscussion(sessionId, options.workflowRunId, {
        taskId: options.taskId,
        teamId: options.teamId,
        companyRunId: options.companyRunId,
      }, db);
    }

    await eventBus.publish({
      type: 'discussion:started', sessionId,
      topic: options.topic, mode: options.mode, participants,
    });

    log.info({ sessionId, mode: options.mode, participants, topic: options.topic.slice(0, 80) }, 'Discussion started');

    const rounds: DiscussionRoundResult[] = [];
    let consensusRate = 0;

    // ─── Round 1: 독립 제안 (병렬) ────────────────
    await eventBus.publish({
      type: 'discussion:round_started', sessionId, round: 1, totalRounds: maxRounds,
    });

    const proposals = await this.collectResponses(
      sessionId,
      1,
      'proposal',
      participants,
      options.topic,
      projectDir
    );
    const successfulParticipants = participants.filter(pid => Boolean(proposals[pid]));
    const excludedParticipants = participants.filter(pid => !proposals[pid]);
    const validProposalsCount = successfulParticipants.length;
    if (validProposalsCount < 2) {
      const failure = `discussion_insufficient_valid_proposals:${validProposalsCount}/2`;
      db.prepare(`
        UPDATE discussions
        SET status='failed', report=?, ended_at=datetime('now')
        WHERE id=?
      `).run(failure, sessionId);
      if (options.workflowRunId) {
        markWorkflowStage(options.workflowRunId, 'discussion', 'failed', {
          teamId: options.teamId,
          discussionId: sessionId,
          error: failure,
        }, db);
      }
      await eventBus.publish({
        type: 'discussion:failed',
        sessionId,
        round: 1,
        error: failure,
        activeParticipants: successfulParticipants,
        excludedParticipants,
      });
      this.cleanupSessionState(sessionId);
      throw new Error(failure);
    }
    rounds.push({ round: 1, responses: proposals, consensusRate: 0 });

    this.saveRound(sessionId, 1, 'proposal', proposals);

    await eventBus.publish({
      type: 'discussion:round_completed', sessionId, round: 1,
      consensusRate: 0, responseCount: Object.keys(proposals).length,
      activeParticipants: successfulParticipants,
      excludedParticipants,
    });

    // ─── Round 2: 순차 평가 (이전 응답 참조) ──────────────
    if (successfulParticipants.length > 1 && maxRounds >= 2) {
      const round = 2;
      await eventBus.publish({
        type: 'discussion:round_started', sessionId, round, totalRounds: maxRounds,
      });

      const allProposals = this.formatProposals(proposals, 6000);
      const evalPrompt = `Evaluate other agents' proposals:\n\n${allProposals}\n\nAnalyze pros/cons, score 1-10. Pick winner & reason.\n\nJSON block:\n\`\`\`json\n{"scores": {"agentId": score}, "winner": "agentId", "reason": "why"}\n\`\`\``;

      // 순차 실행: 각 에이전트가 이전 에이전트의 평가를 볼 수 있음 (성공한 에이전트만)
      const nonClaude = successfulParticipants.filter(p => p !== 'claude-code');
      const evaluations = await this.collectResponsesSequential(
        sessionId, round, 'evaluation', nonClaude, evalPrompt, allProposals, projectDir,
      );

      const scores = this.extractScores(evaluations, successfulParticipants);
      consensusRate = this.calculateConsensus(sessionId, scores, successfulParticipants);
      this.updateTrustScores(sessionId, scores, successfulParticipants);
      this.updateReputation(sessionId, scores, successfulParticipants);
      rounds.push({ round, responses: evaluations, evaluations: scores, consensusRate });
      this.saveRound(sessionId, round, 'evaluation', evaluations, scores, consensusRate);

      const thresholdDelta = pidController.compute(threshold, consensusRate);
      threshold = Math.max(0.5, Math.min(0.95, threshold - thresholdDelta));

      await eventBus.publish({
        type: 'discussion:round_completed', sessionId, round, consensusRate,
        responseCount: Object.keys(evaluations).length,
        activeParticipants: nonClaude,
      });
      log.info({ sessionId, round, consensusRate, threshold }, 'Round 2 (sequential) completed');
    }

    // ─── Final: R1에서 실제 응답한 건강한 provider가 최종 결론 생성 ───────────
    {
      const finalRound = maxRounds;
      const synthesisProvider = selectDiscussionSynthesisProvider(successfulParticipants);
      let synthesisResponseCount = 0;
      await eventBus.publish({
        type: 'discussion:round_started', sessionId, round: finalRound, totalRounds: maxRounds,
      });

      const r1Summary = this.formatProposals(rounds[0]?.responses || {}, 6000);
      const r2Summary = this.formatProposals(rounds[1]?.responses || {}, 6000);
      const synthPrompt = `Synthesize team discussion results into a final conclusion.\n\n=== R1 Proposals ===\n${r1Summary}\n\n=== R2 Evaluations ===\n${r2Summary}\n\nConclusion should be concise and clear.`;

      if (synthesisProvider) {
        await eventBus.publish({
          type: 'discussion:provider_started',
          sessionId,
          agentId: synthesisProvider,
          round: finalRound,
          messageType: 'synthesis',
        });
        try {
          const synthResult = await agentManager.executeTask(synthesisProvider, synthPrompt, {
            systemPrompt: `Synth session ${sessionId}. Final synthesis.`,
            projectDir,
            signal: AbortSignal.timeout(90_000),
          });

          if (synthResult.success && synthResult.output.trim()) {
            const synthesisOutput = requireSubstantiveDiscussionOutput(
              synthesisProvider,
              synthResult,
              'synthesis',
            );
            const db2 = getDb();
            db2.prepare(`
              INSERT INTO discussion_messages (id, discussion_id, agent_id, round, message_type, content)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(createMessageId(), sessionId, synthesisProvider, finalRound, 'synthesis', synthesisOutput);

            await eventBus.publish({
              type: 'discussion:provider_completed',
              sessionId,
              agentId: synthesisProvider,
              round: finalRound,
              messageType: 'synthesis',
              ...buildDiscussionEventContent(synthesisOutput),
            });

            rounds.push({
              round: finalRound,
              responses: { [synthesisProvider]: synthesisOutput },
              consensusRate: 1,
            });
            this.saveRound(
              sessionId,
              finalRound,
              'synthesis',
              { [synthesisProvider]: synthesisOutput },
            );
            synthesisResponseCount = 1;
            consensusRate = Math.max(consensusRate, 0.8);
          } else {
            await eventBus.publish({
              type: 'discussion:provider_failed',
              sessionId,
              agentId: synthesisProvider,
              round: finalRound,
              error: synthResult.error || 'empty synthesis',
            });
          }
        } catch (err: any) {
          await eventBus.publish({
            type: 'discussion:provider_failed',
            sessionId,
            agentId: synthesisProvider,
            round: finalRound,
            error: err instanceof Error ? err.message : String(err),
          });
          log.warn({ agentId: synthesisProvider, err: err.message }, 'Discussion synthesis failed');
        }
      }

      await eventBus.publish({
        type: 'discussion:round_completed', sessionId, round: finalRound, consensusRate,
        responseCount: synthesisResponseCount,
        activeParticipants: synthesisProvider ? [synthesisProvider] : [],
      });
      log.info({ sessionId, round: finalRound, consensusRate }, 'Final synthesis completed');
    }

    // ─── 최종 보고서 생성 ─────────────────────────
    const report = this.generateReport(
      sessionId,
      options,
      successfulParticipants,
      rounds,
      consensusRate,
      startTime,
    );

    // Save to DB
    const resultState = this.readDiscussionResultState(sessionId);
    const persistedReport = {
      ...report,
      ...(resultState.roundSnapshots ? { roundSnapshots: resultState.roundSnapshots } : {}),
    };
    db.prepare(`
      UPDATE discussions SET status='completed', consensus_rate=?, result_json=?, report=?, ended_at=datetime('now')
      WHERE id=?
    `).run(consensusRate, JSON.stringify(persistedReport), report.adoptedProposal, sessionId);
    if (options.workflowRunId) {
      markWorkflowStage(options.workflowRunId, 'discussion', 'completed', {
        teamId: options.teamId,
        discussionId: sessionId,
        evidence: {
          consensusRate,
          rounds: report.rounds.length,
          participants: report.participants,
        },
      }, db);
    }

    await eventBus.publish({
      type: 'discussion:completed', sessionId, report,
    });

    log.info({ sessionId, consensusRate, rounds: rounds.length, durationMs: Date.now() - startTime }, 'Discussion completed');
    this.cleanupSessionState(sessionId);

    return report;
  }

  // ═══ Hive 모드 (모든 AI 동시 → Commander 통합) ═══
  //
  // Discussion과의 차이:
  //   Discussion: 순차 라운드 토론 (AI가 서로 의견 보고 반박)
  //   Hive:       모든 AI가 동시에 독립 응답 (병렬) → 결과를 claude-code가 통합
  //
  // 결과: 속도가 빠르고 다양한 관점이 나오지만, 교차 검증은 없음
  private async executeHive(options: DiscussionOptions): Promise<DiscussionReport> {
    const sessionId = options.sessionId || createSessionId();
    const startTime = Date.now();
    const participants = options.providers || this.selectParticipants('hive');
    const projectDir = resolveDiscussionProjectDir(options);
    const db = getDb();

    db.prepare(`
      INSERT INTO discussions (
        id, topic, mode, status, participants_json, initiator, max_rounds,
        task_id, team_id, company_run_id, workflow_run_id
      )
      VALUES (?, ?, 'hive', 'active', ?, ?, 1, ?, ?, ?, ?)
    `).run(
      sessionId,
      options.topic,
      JSON.stringify(participants),
      options.initiator || 'system',
      options.taskId ?? null,
      options.teamId ?? null,
      options.companyRunId ?? null,
      options.workflowRunId ?? null,
    );
    if (options.workflowRunId) {
      linkWorkflowDiscussion(sessionId, options.workflowRunId, {
        taskId: options.taskId,
        teamId: options.teamId,
        companyRunId: options.companyRunId,
      }, db);
    }

    await eventBus.publish({
      type: 'discussion:started', sessionId,
      topic: options.topic, mode: 'hive', participants,
    });

    log.info({ sessionId, participants, topic: options.topic.slice(0, 80) }, 'Hive started');

    // ─── Phase 1: 모든 AI 동시 병렬 실행 ─────────────
    await eventBus.publish({ type: 'discussion:round_started', sessionId, round: 1, totalRounds: 2 });

    const parallelResults = await Promise.allSettled(
      participants.map(async (pid) => {
        await eventBus.publish({ type: 'discussion:provider_started', sessionId, agentId: pid, round: 1 });
        try {
          const result = await agentManager.executeTask(pid, options.topic, {
            systemPrompt: `You are part of a Hive intelligence. Respond independently to the task. Session: ${sessionId}`,
            projectDir,
            signal: AbortSignal.timeout(120_000),
          });
          const output = requireDiscussionOutput(pid, result);
          db.prepare(`
            INSERT INTO discussion_messages (id, discussion_id, agent_id, round, message_type, content)
            VALUES (?, ?, ?, 1, 'hive_response', ?)
          `).run(createMessageId(), sessionId, pid, output);
          await eventBus.publish({
            type: 'discussion:provider_completed', sessionId, agentId: pid, round: 1,
            messageType: 'hive_response',
            ...buildDiscussionEventContent(output),
          });
          return { pid, output, success: true };
        } catch (error) {
          await eventBus.publish({
            type: 'discussion:provider_failed', sessionId, agentId: pid, round: 1,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      })
    );

    const responses: Record<string, string> = {};
    for (const r of parallelResults) {
      if (r.status === 'fulfilled' && r.value.success) {
        responses[r.value.pid] = r.value.output;
      }
    }

    await eventBus.publish({ type: 'discussion:round_completed', sessionId, round: 1, consensusRate: 0, responseCount: Object.keys(responses).length });

    // ─── Phase 2: Commander(claude-code)가 전체 응답 통합 ─
    await eventBus.publish({ type: 'discussion:round_started', sessionId, round: 2, totalRounds: 2 });

    let synthesis = '';
    const allProposals = this.formatProposals(responses);
    const synthPrompt = [
      `You are the Commander synthesizing a Hive intelligence session.`,
      `${Object.keys(responses).length} AIs responded independently to: "${options.topic}"`,
      ``,
      `Their responses:`,
      allProposals,
      ``,
      `Synthesize the best elements from all responses into one definitive, comprehensive answer.`,
      `Cite which AI contributed each key insight.`,
    ].join('\n');

    try {
      const synthResult = await agentManager.executeTask('claude-code', synthPrompt, {
        projectDir,
        signal: AbortSignal.timeout(90_000),
      });
      synthesis = requireDiscussionOutput('claude-code', synthResult);
      db.prepare(`
        INSERT INTO discussion_messages (id, discussion_id, agent_id, round, message_type, content)
        VALUES (?, ?, 'claude-code', 2, 'hive_synthesis', ?)
      `).run(createMessageId(), sessionId, synthesis);
    } catch (err: any) {
      // If synthesis fails, use the best individual response
      synthesis = responses[participants[0]] || 'Hive synthesis unavailable';
      log.warn({ sessionId, err: err.message }, 'Commander synthesis failed — using best individual response');
    }

    await eventBus.publish({ type: 'discussion:round_completed', sessionId, round: 2, consensusRate: 1, responseCount: 1 });

    const rounds: DiscussionRoundResult[] = [
      { round: 1, responses, consensusRate: 0 },
      { round: 2, responses: { 'commander-synthesis': synthesis }, consensusRate: 1 },
    ];

    // ─── 최종 보고서 ─────────────────────────────────
    const report = this.generateReport(sessionId, options, participants, rounds, 1, startTime);
    report.adoptedProposal = synthesis; // override with actual synthesis
    const resultState = this.readDiscussionResultState(sessionId);
    const persistedReport = {
      ...report,
      ...(resultState.roundSnapshots ? { roundSnapshots: resultState.roundSnapshots } : {}),
    };

    db.prepare(`
      UPDATE discussions SET status='completed', consensus_rate=1, result_json=?, report=?, ended_at=datetime('now')
      WHERE id=?
    `).run(JSON.stringify(persistedReport), synthesis, sessionId);
    if (options.workflowRunId) {
      markWorkflowStage(options.workflowRunId, 'discussion', 'completed', {
        teamId: options.teamId,
        discussionId: sessionId,
        evidence: {
          consensusRate: 1,
          rounds: report.rounds.length,
          participants: report.participants,
        },
      }, db);
    }

    await eventBus.publish({ type: 'discussion:completed', sessionId, report });

    log.info({ sessionId, participants: participants.length, durationMs: Date.now() - startTime }, 'Hive completed');
    this.cleanupSessionState(sessionId);

    return report;
  }

  // ═══ 자유 토론 모드 (mode: realtime) ═══
  async startRealtimeDiscussion(options: DiscussionOptions): Promise<string> {
    const sessionId = options.sessionId || createSessionId();
    const participants = options.providers || this.selectParticipants('realtime');

    const db = getDb();
    db.prepare(`
      INSERT INTO discussions (
        id, topic, mode, status, participants_json, initiator,
        task_id, team_id, company_run_id, workflow_run_id
      )
      VALUES (?, ?, 'realtime', 'active', ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      options.topic,
      JSON.stringify(participants),
      options.initiator || 'user',
      options.taskId ?? null,
      options.teamId ?? null,
      options.companyRunId ?? null,
      options.workflowRunId ?? null,
    );
    if (options.workflowRunId) {
      linkWorkflowDiscussion(sessionId, options.workflowRunId, {
        taskId: options.taskId,
        teamId: options.teamId,
        companyRunId: options.companyRunId,
      }, db);
    }

    await eventBus.publish({
      type: 'discussion:started', sessionId,
      topic: options.topic, mode: 'realtime', participants,
    });

    // In realtime mode, agents listen on the Event Bus and respond freely
    // Each agent subscribes to the discussion channel
    for (const pid of participants) {
      this.setupRealtimeListener(sessionId, pid, options.topic, participants);
    }

    // Kick off with initial topic broadcast
    await eventBus.publish({
      type: 'discussion:message', sessionId,
      from: 'user', content: options.topic, round: null,
    });

    return sessionId;
  }

  // ═══ 사용자 개입 ═══
  async userIntervention(sessionId: string, message: string): Promise<void> {
    await eventBus.publish({
      type: 'discussion:user_intervention', sessionId,
      from: 'user', content: message,
    });

    // Save to DB (only if session exists)
    try {
      const db = getDb();
      const exists = db.prepare('SELECT id FROM discussions WHERE id=?').get(sessionId);
      if (exists) {
        db.prepare(`
          INSERT INTO discussion_messages (id, discussion_id, agent_id, round, message_type, content)
          VALUES (?, ?, 'user', NULL, 'intervention', ?)
        `).run(createMessageId(), sessionId, message);
      }
    } catch (err: any) {
      log.warn({ sessionId, err: err.message }, 'User intervention DB save skipped');
    }

    log.info({ sessionId, message: message.slice(0, 80) }, 'User intervention');
  }

  // ─── Internal: Collect responses from all participants ──
  private async collectResponses(
    sessionId: string,
    round: number,
    type: string,
    participants: string[],
    prompt: string,
    projectDir: string
  ): Promise<Record<string, string>> {
    const results = await Promise.allSettled(
      participants.map(async (pid) => {
        await eventBus.publish({
          type: 'discussion:provider_started', sessionId, agentId: pid, round,
        });
        try {
          const result = await agentManager.executeTask(pid, prompt, {
            systemPrompt: `Discussion R${round}. Session: ${sessionId}`,
            compact: true,
            // projectDir 필수: Type B CLI(codex)는 metadata.projectDir 없으면 즉시 실패
            // (orchestrated-loop.ts assertTaskProjectDir) → 토론에서 codex 탈락 원인이었음
            projectDir,
            // 180s: Type A(claude-code nested `claude -p` spawn)는 콜드스타트가 무거워
            // 120s abort로 "silent-failure: empty output" 발생 → 토론에서 claude-code 탈락 원인.
            // Type B/C는 먼저 끝나면 조기 반환하므로 ceiling만 상향(저위험).
            signal: AbortSignal.timeout(180_000),
          });
          const output = requireDiscussionOutput(pid, result);

          const db = getDb();
          db.prepare(`
            INSERT INTO discussion_messages (id, discussion_id, agent_id, round, message_type, content)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(createMessageId(), sessionId, pid, round, type, output);

          await eventBus.publish({
            type: 'discussion:provider_completed', sessionId, agentId: pid, round,
            messageType: type,
            ...buildDiscussionEventContent(output),
          });

          return { pid, output };
        } catch (error) {
          await eventBus.publish({
            type: 'discussion:provider_failed', sessionId, agentId: pid, round,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      })
    );

    const responses: Record<string, string> = {};
    for (const r of results) {
      if (r.status === 'fulfilled') {
        responses[r.value.pid] = r.value.output;
      } else {
        const err = r.reason;
        const ex = err instanceof Error ? err : null;
        const isTimeout =
          ex?.name === 'TimeoutError' || ex?.name === 'AbortError';
        log.warn(
          { reason: ex?.message ?? String(err), timeout: isTimeout },
          'Agent failed in discussion',
        );
      }
    }
    return responses;
  }

  private getSessionTrustScores(sessionId: string): Map<string, number> {
    let trustScores = this.sessionTrustScores.get(sessionId);
    if (!trustScores) {
      trustScores = new Map<string, number>();
      this.sessionTrustScores.set(sessionId, trustScores);
    }
    return trustScores;
  }

  private getSessionReputationScores(sessionId: string): Map<string, number> {
    let reputationScores = this.sessionReputationScores.get(sessionId);
    if (!reputationScores) {
      reputationScores = new Map<string, number>();
      this.sessionReputationScores.set(sessionId, reputationScores);
    }
    return reputationScores;
  }

  private getSessionPid(sessionId: string): PIDController {
    let pid = this.sessionPidControllers.get(sessionId);
    if (!pid) {
      pid = new PIDController();
      this.sessionPidControllers.set(sessionId, pid);
    }
    return pid;
  }

  private cleanupSessionState(sessionId: string): void {
    this.sessionTrustScores.delete(sessionId);
    this.sessionReputationScores.delete(sessionId);
    this.sessionPidControllers.delete(sessionId);
    this.teardownRealtimeListeners(sessionId);
  }

  private teardownRealtimeListeners(sessionId: string): void {
    const listeners = this.realtimeListeners.get(sessionId) ?? [];
    for (const { eventType, handler } of listeners) {
      eventBus.off(eventType, handler);
    }
    this.realtimeListeners.delete(sessionId);
  }

  /**
   * 순차 응답 수집: 각 에이전트가 이전 에이전트의 응답을 볼 수 있음.
   * Round 2에서 사용 — 1라운드 제안 + 이전 에이전트의 평가를 누적 컨텍스트로 전달.
   */
  private async collectResponsesSequential(
    sessionId: string,
    round: number,
    type: string,
    participants: string[],
    basePrompt: string,
    proposalsSummary: string,
    projectDir: string,
  ): Promise<Record<string, string>> {
    const responses: Record<string, string> = {};
    const accumulated: string[] = [];

    for (const pid of participants) {
      await eventBus.publish({
        type: 'discussion:provider_started', sessionId, agentId: pid, round,
      });

      // 이전 에이전트들의 평가를 컨텍스트에 추가
      let prompt = basePrompt;
      if (accumulated.length > 0) {
        prompt += `\n\n=== Prev Eval (summarized) ===\n${accumulated.join('\n\n')}`;
      }

      try {
        const result = await agentManager.executeTask(pid, prompt, {
          systemPrompt: `R${round} (seq). Concisely build on evals.`,
          compact: true,
          projectDir,
          signal: AbortSignal.timeout(60_000),
        });
        const output = requireSubstantiveDiscussionOutput(pid, result, 'evaluation');

        responses[pid] = output;
        accumulated.push(`[${pid}]: ${output.slice(0, 400)}`);

        const db = getDb();
        db.prepare(`
          INSERT INTO discussion_messages (id, discussion_id, agent_id, round, message_type, content)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(createMessageId(), sessionId, pid, round, type, output);

        await eventBus.publish({
          type: 'discussion:provider_completed', sessionId, agentId: pid, round,
          messageType: type,
          ...buildDiscussionEventContent(output),
        });
      } catch (err: any) {
        await eventBus.publish({
          type: 'discussion:provider_failed', sessionId, agentId: pid, round,
          error: err instanceof Error ? err.message : String(err),
        });
        log.warn({ agentId: pid, err: err.message }, 'Agent failed in sequential discussion');
      }
    }
    return responses;
  }

  // ─── Internal: Setup realtime listener for an agent ──
  private setupRealtimeListener(
    sessionId: string,
    agentId: string,
    topic: string,
    _participants: string[],
  ): void {
    const handler = async (event: any) => {
      if (event.sessionId !== sessionId) return;
      if (event.from === agentId) return; // don't respond to self

      const db = getDb();
      const discussion = db.prepare(
        `SELECT status FROM discussions WHERE id = ?`
      ).get(sessionId) as { status?: string } | undefined;
      if (!discussion || discussion.status !== 'active') {
        this.teardownRealtimeListeners(sessionId);
        return;
      }

      // Debounce — wait for other messages
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));

      const otherMessages = event.content;
      const prompt = `Discussion topic: "${topic}"\n\nLatest message from ${event.from}:\n${otherMessages}\n\nRespond with your thoughts. Be concise.`;

      try {
        const result = await agentManager.executeTask(agentId, prompt);
        const output = requireDiscussionOutput(agentId, result);

        await eventBus.publish({
          type: 'discussion:message', sessionId,
          from: agentId, content: output, round: null,
        });

        db.prepare(`
          INSERT INTO discussion_messages (id, discussion_id, agent_id, round, message_type, content)
          VALUES (?, ?, ?, NULL, 'realtime', ?)
        `).run(createMessageId(), sessionId, agentId, output);

      } catch (err: any) {
        await eventBus.publish({
          type: 'discussion:provider_failed', sessionId, agentId, round: null,
          error: err instanceof Error ? err.message : String(err),
        });
        log.error({ agentId, sessionId, err: err.message }, 'Realtime response failed');
      }
    };

    eventBus.on('discussion:message', handler);
    eventBus.on('discussion:user_intervention', handler);
    const listeners = this.realtimeListeners.get(sessionId) ?? [];
    listeners.push({ eventType: 'discussion:message', handler });
    listeners.push({ eventType: 'discussion:user_intervention', handler });
    this.realtimeListeners.set(sessionId, listeners);
  }

  // ─── Internal: Select participants by mode ──────────
  private selectParticipants(mode: DiscussionMode): string[] {
    const all = sortProvidersByCostOrder(agentManager.listEnabledIds());

    switch (mode) {
      case 'task': return [all[0] || 'claude-code'];
      case 'parallel': return all.slice(0, 3);
      case 'discussion': return all.slice(0, 3);
      case 'realtime': return all.slice(0, 4);
      case 'consensus': return all.slice(0, 5);
      case 'hive': return all; // all agents
      case 'broadcast': return all;
      default: return all.slice(0, 3);
    }
  }

  // ─── Internal: Format proposals for evaluation (truncated for efficiency) ──
  private formatProposals(proposals: Record<string, string>, maxLength = 2000): string {
    return Object.entries(proposals)
      .map(([pid, content]) =>
        `### ${pid}:\n${formatDiscussionProposalContent(content, maxLength)}`)
      .join('\n\n---\n\n');
  }

  // ─── Internal: Extract scores from evaluations ──────
  private extractScores(
    evaluations: Record<string, string>,
    participants: string[]
  ): Record<string, Record<string, number>> {
    const scores: Record<string, Record<string, number>> = {};

    for (const [evaluator, text] of Object.entries(evaluations)) {
      scores[evaluator] = {};
      const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*?"scores"[\s\S]*?\})/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1]);
          const validated = EvalScoreSchema.safeParse(parsed);
          if (validated.success) {
            for (const t of participants) {
              if (t === evaluator) continue;
              const s = validated.data.scores[t];
              if (typeof s === 'number') {
                scores[evaluator][t] = Math.min(10, Math.max(1, s));
              }
            }
            continue;
          }
        } catch { /* fall through to regex */ }
      }
      for (const target of participants) {
        if (target === evaluator) continue;
        // Regex fallback: look for "N/10" or "N점" patterns
        const pattern = new RegExp(`${target}[^\\d]*(\\d+)\\s*[/점]\\s*10?`, 'i');
        const match = text.match(pattern);
        if (match) {
          scores[evaluator][target] = Math.min(10, Math.max(1, parseInt(match[1])));
        } else {
          scores[evaluator][target] = 5; // default if no score found
        }
      }
    }

    return scores;
  }

  // ─── Internal: Calculate consensus rate (trust-weighted voting) ──
  private calculateConsensus(
    sessionId: string,
    scores: Record<string, Record<string, number>>,
    participants: string[]
  ): number {
    if (participants.length < 2) return 1.0;
    const trustScores = this.getSessionTrustScores(sessionId);

    // Phase 1: trust-weighted score sum per candidate
    const weightedScores: Record<string, number> = {};
    let totalWeight = 0;

    for (const evaluator of participants) {
      const trust = trustScores.get(evaluator) ?? 1.0;
      totalWeight += trust;
      const evalScores = scores[evaluator] || {};
      for (const [target, score] of Object.entries(evalScores)) {
        weightedScores[target] = (weightedScores[target] || 0) + score * trust;
      }
    }

    // Phase 2: find trust-weighted top candidate
    let maxWeightedMean = 0;
    let topChoice = '';
    for (const [target, total] of Object.entries(weightedScores)) {
      const mean = totalWeight > 0 ? total / totalWeight : 0;
      if (mean > maxWeightedMean) {
        maxWeightedMean = mean;
        topChoice = target;
      }
    }

    if (!topChoice) return 0;

    // Phase 3: sum trust weights of evaluators whose top pick matches overall winner
    let agreementWeight = 0;
    for (const evaluator of participants) {
      const evalScores = scores[evaluator] || {};
      if (Object.keys(evalScores).length === 0) continue;
      const evalTop = Object.entries(evalScores)
        .sort((a, b) => b[1] - a[1])[0]?.[0];
      if (evalTop === topChoice) {
        agreementWeight += trustScores.get(evaluator) ?? 1.0;
      }
    }

    return totalWeight > 0 ? agreementWeight / totalWeight : 0;
  }

  // ─── Internal: Update trust scores based on consensus ─
  private updateTrustScores(
    sessionId: string,
    scores: Record<string, Record<string, number>>,
    participants: string[]
  ): void {
    if (participants.length < 2) return;
    const trustScores = this.getSessionTrustScores(sessionId);

    // Calculate mean score for each agent
    const meanScores: Record<string, number> = {};
    for (const pid of participants) {
      let sum = 0;
      let count = 0;
      for (const [evaluator, evalScores] of Object.entries(scores)) {
        if (evaluator === pid) continue;
        const score = evalScores[pid];
        if (typeof score === 'number') {
          sum += score;
          count++;
        }
      }
      meanScores[pid] = count > 0 ? sum / count : 5;
    }

    // Calculate overall mean
    const overallMean = Object.values(meanScores).reduce((a, b) => a + b, 0) / (Object.keys(meanScores).length || 1);

    // Update each agent's trust based on alignment with mean
    for (const pid of participants) {
      const currentTrust = trustScores.get(pid) ?? 1.0;
      const score = meanScores[pid] ?? 5;

      if (Math.abs(score - overallMean) <= 1) {
        // Within 1 point of mean - increase trust
        trustScores.set(pid, Math.min(2.0, currentTrust + 0.05));
      } else {
        // Outside mean - decrease trust
        trustScores.set(pid, Math.max(0.1, currentTrust - 0.05));
      }
    }
  }

  // ─── Internal: Update long-term reputation (EMA α=0.1) ─
  private updateReputation(
    sessionId: string,
    scores: Record<string, Record<string, number>>,
    participants: string[]
  ): void {
    const reputationScores = this.getSessionReputationScores(sessionId);
    for (const pid of participants) {
      let sum = 0, count = 0;
      for (const [evaluator, evalScores] of Object.entries(scores)) {
        if (evaluator === pid) continue;
        const s = evalScores[pid];
        if (typeof s === 'number') { sum += s; count++; }
      }
      if (count === 0) continue;
      const mean = sum / count;
      const current = reputationScores.get(pid) ?? 5.0;
      // Exponential moving average: blends long-term history with latest round
      reputationScores.set(pid, current * 0.9 + mean * 0.1);
    }
  }

  // ─── Internal: Generate report ──────────────────────
  private generateReport(
    sessionId: string,
    options: DiscussionOptions,
    participants: string[],
    rounds: DiscussionRoundResult[],
    consensusRate: number,
    startTime: number
  ): DiscussionReport {
    const firstRound = rounds[0];
    const proposals = Object.entries(firstRound?.responses || {});

    const { adoptedAgent, adoptedProposal } = selectDiscussionConclusion(rounds, participants);
    const dissentingOpinions = proposals
      .filter(([pid]) => pid !== adoptedAgent)
      .map(([pid, content]) => `${pid}: ${content.slice(0, 200)}`);

    return {
      sessionId,
      topic: options.topic,
      mode: options.mode,
      participants,
      rounds,
      finalConsensusRate: consensusRate,
      adoptedProposal: adoptedProposal.slice(0, 20000),
      rationale: `Adopted ${adoptedAgent}'s proposal with ${(consensusRate * 100).toFixed(0)}% consensus after ${rounds.length} rounds.`,
      dissentingOpinions,
      totalDurationMs: Date.now() - startTime,
    };
  }

  // ─── Internal: Save round to DB ─────────────────────
  private saveRound(
    sessionId: string,
    round: number,
    type: string,
    responses: Record<string, string>,
    scores?: Record<string, Record<string, number>>,
    consensusRate?: number,
  ): void {
    try {
      const db = getDb();
      const resultState = this.readDiscussionResultState(sessionId);
      const snapshots = resultState.roundSnapshots ?? [];
      const snapshot: DiscussionRoundSnapshot = {
        round,
        type,
        responses,
        ...(scores ? { scores } : {}),
        ...(consensusRate !== undefined ? { consensusRate } : {}),
        savedAt: new Date().toISOString(),
      };
      const roundSnapshots = [...snapshots.filter((entry) => entry.round !== round), snapshot]
        .sort((left, right) => left.round - right.round);
      const nextResultState: DiscussionResultState = {
        ...resultState,
        roundSnapshots,
      };
      db.prepare(`
        UPDATE discussions
        SET current_round=?,
            consensus_rate=COALESCE(?, consensus_rate),
            result_json=?,
            updated_at=datetime('now')
        WHERE id=?
      `).run(round, consensusRate ?? null, JSON.stringify(nextResultState), sessionId);
    } catch (err: any) {
      log.error({ err: err.message, sessionId, round }, 'Save round failed');
    }
  }

  private readDiscussionResultState(sessionId: string): DiscussionResultState {
    const row = getDb().prepare(`
      SELECT result_json
      FROM discussions
      WHERE id=?
    `).get(sessionId) as { result_json?: string | null } | undefined;

    if (!row?.result_json) return {};

    try {
      const parsed = JSON.parse(row.result_json) as DiscussionResultState;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
}

export const discussionEngine = new DiscussionEngine();
