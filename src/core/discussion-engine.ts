import { z } from 'zod';
import { eventBus } from './event-bus.js';
import { sharedState } from './shared-state.js';
import { agentManager } from '../agent/agent-manager.js';
import { getDb } from '../storage/database.js';
import { createSessionId, createMessageId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';

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
}

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

  private trustScores = new Map<string, number>();
  /** Long-term reputation: persists across discussions (EMA α=0.1) */
  private reputationScores = new Map<string, number>();
  private pid = new PIDController();

  // ═══ 단일 작업 위임 (mode: task) ═══
  async executeTask(agentId: string, prompt: string, options?: { systemPrompt?: string }): Promise<string> {
    const result = await agentManager.executeTask(agentId, prompt, options);
    return result.output;
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
        const result = await agentManager.executeTask(pid, prompt);
        await eventBus.publish({
          type: 'discussion:provider_completed', sessionId, agentId: pid,
          content: result.output.slice(0, 500),
        });
        return { pid, output: result.output };
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
    this.pid.reset();
    const initiator = options.initiator || 'claude-code';

    // Initialize trust scores to 1.0 for each agent
    for (const pid of participants) {
      this.trustScores.set(pid, 1.0);
    }

    // Save session to DB
    const db = getDb();
    db.prepare(`
      INSERT INTO discussions (id, topic, mode, status, participants_json, initiator, max_rounds, consensus_threshold)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(sessionId, options.topic, options.mode, JSON.stringify(participants), initiator, maxRounds, threshold);

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

    const proposals = await this.collectResponses(sessionId, 1, 'proposal', participants, options.topic);
    rounds.push({ round: 1, responses: proposals, consensusRate: 0 });

    this.saveRound(sessionId, 1, 'proposal', proposals);

    await eventBus.publish({
      type: 'discussion:round_completed', sessionId, round: 1,
      consensusRate: 0, responseCount: Object.keys(proposals).length,
    });

    // ─── Round 2: 순차 평가 (이전 응답 참조) ──────────────
    if (participants.length > 1 && maxRounds >= 2) {
      const round = 2;
      await eventBus.publish({
        type: 'discussion:round_started', sessionId, round, totalRounds: maxRounds,
      });

      const allProposals = this.formatProposals(proposals, 1200); // 1200자 제한
      const evalPrompt = `Evaluate other agents' proposals:\n\n${allProposals}\n\nAnalyze pros/cons, score 1-10. Pick winner & reason.\n\nJSON block:\n\`\`\`json\n{"scores": {"agentId": score}, "winner": "agentId", "reason": "why"}\n\`\`\``;

      // 순차 실행: 각 에이전트가 이전 에이전트의 평가를 볼 수 있음
      const nonClaude = participants.filter(p => p !== 'claude-code');
      const evaluations = await this.collectResponsesSequential(
        sessionId, round, 'evaluation', nonClaude, evalPrompt, allProposals,
      );

      const scores = this.extractScores(evaluations, participants);
      consensusRate = this.calculateConsensus(scores, participants);
      this.updateTrustScores(scores, participants);
      this.updateReputation(scores, participants);
      rounds.push({ round, responses: evaluations, evaluations: scores, consensusRate });
      this.saveRound(sessionId, round, 'evaluation', evaluations, scores, consensusRate);

      const thresholdDelta = this.pid.compute(threshold, consensusRate);
      threshold = Math.max(0.5, Math.min(0.95, threshold - thresholdDelta));

      await eventBus.publish({
        type: 'discussion:round_completed', sessionId, round, consensusRate,
      });
      log.info({ sessionId, round, consensusRate, threshold }, 'Round 2 (sequential) completed');
    }

    // ─── Final: claude-code 최종 결론 생성 ───────────
    {
      const finalRound = maxRounds;
      await eventBus.publish({
        type: 'discussion:round_started', sessionId, round: finalRound, totalRounds: maxRounds,
      });

      const r1Summary = this.formatProposals(rounds[0]?.responses || {}, 1500);
      const r2Summary = this.formatProposals(rounds[1]?.responses || {}, 1500);
      const synthPrompt = `Synthesize team discussion results into a final conclusion.\n\n=== R1 Proposals ===\n${r1Summary}\n\n=== R2 Evaluations ===\n${r2Summary}\n\nConclusion should be concise and clear.`;

      try {
        const synthResult = await agentManager.executeTask('claude-code', synthPrompt, {
          systemPrompt: `Synth session ${sessionId}. Final synthesis.`,
          signal: AbortSignal.timeout(90_000),
        });

        if (synthResult.success && synthResult.output) {
          const db2 = getDb();
          db2.prepare(`
            INSERT INTO discussion_messages (id, discussion_id, agent_id, round, message_type, content)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(createMessageId(), sessionId, 'claude-code', finalRound, 'synthesis', synthResult.output);

          await eventBus.publish({
            type: 'discussion:provider_completed', sessionId, agentId: 'claude-code', round: finalRound,
            content: synthResult.output.slice(0, 500),
          });

          rounds.push({ round: finalRound, responses: { 'claude-code': synthResult.output }, consensusRate: 1 });
          this.saveRound(sessionId, finalRound, 'synthesis', { 'claude-code': synthResult.output });
          consensusRate = Math.max(consensusRate, 0.8); // 최종 합성 시 최소 80% 합의
        }
      } catch (err: any) {
        log.warn({ err: err.message }, 'Commander synthesis failed');
      }

      await eventBus.publish({
        type: 'discussion:round_completed', sessionId, round: finalRound, consensusRate,
      });
      log.info({ sessionId, round: finalRound, consensusRate }, 'Final synthesis completed');
    }

    // ─── 최종 보고서 생성 ─────────────────────────
    const report = this.generateReport(sessionId, options, participants, rounds, consensusRate, startTime);

    // Save to DB
    db.prepare(`
      UPDATE discussions SET status='completed', consensus_rate=?, result_json=?, report=?, ended_at=datetime('now')
      WHERE id=?
    `).run(consensusRate, JSON.stringify(report), report.adoptedProposal, sessionId);

    await eventBus.publish({
      type: 'discussion:completed', sessionId, report,
    });

    log.info({ sessionId, consensusRate, rounds: rounds.length, durationMs: Date.now() - startTime }, 'Discussion completed');

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
    const db = getDb();

    db.prepare(`
      INSERT INTO discussions (id, topic, mode, status, participants_json, initiator, max_rounds)
      VALUES (?, ?, 'hive', 'active', ?, ?, 1)
    `).run(sessionId, options.topic, JSON.stringify(participants), options.initiator || 'system');

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
        const result = await agentManager.executeTask(pid, options.topic, {
          systemPrompt: `You are part of a Hive intelligence. Respond independently to the task. Session: ${sessionId}`,
          signal: AbortSignal.timeout(120_000),
        });
        db.prepare(`
          INSERT INTO discussion_messages (id, discussion_id, agent_id, round, message_type, content)
          VALUES (?, ?, ?, 1, 'hive_response', ?)
        `).run(createMessageId(), sessionId, pid, result.output);
        await eventBus.publish({
          type: 'discussion:provider_completed', sessionId, agentId: pid, round: 1,
          content: result.output.slice(0, 500),
        });
        return { pid, output: result.output, success: result.success };
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
        signal: AbortSignal.timeout(90_000),
      });
      synthesis = synthResult.output;
      db.prepare(`
        INSERT INTO discussion_messages (id, discussion_id, agent_id, round, message_type, content)
        VALUES (?, ?, 'claude-code', 2, 'hive_synthesis', ?)
      `).run(createMessageId(), sessionId, synthesis);
    } catch (err: any) {
      // If synthesis fails, use the best individual response
      synthesis = responses[participants[0]] || 'Hive synthesis unavailable';
      log.warn({ sessionId, err: err.message }, 'Commander synthesis failed — using best individual response');
    }

    await eventBus.publish({ type: 'discussion:round_completed', sessionId, round: 2, consensusRate: 1 });

    const rounds: DiscussionRoundResult[] = [
      { round: 1, responses, consensusRate: 0 },
      { round: 2, responses: { 'commander-synthesis': synthesis }, consensusRate: 1 },
    ];

    // ─── 최종 보고서 ─────────────────────────────────
    const report = this.generateReport(sessionId, options, participants, rounds, 1, startTime);
    report.adoptedProposal = synthesis; // override with actual synthesis

    db.prepare(`
      UPDATE discussions SET status='completed', consensus_rate=1, result_json=?, report=?, ended_at=datetime('now')
      WHERE id=?
    `).run(JSON.stringify(report), synthesis, sessionId);

    await eventBus.publish({ type: 'discussion:completed', sessionId, report });

    log.info({ sessionId, participants: participants.length, durationMs: Date.now() - startTime }, 'Hive completed');

    return report;
  }

  // ═══ 자유 토론 모드 (mode: realtime) ═══
  async startRealtimeDiscussion(options: DiscussionOptions): Promise<string> {
    const sessionId = createSessionId();
    const participants = options.providers || this.selectParticipants('realtime');

    const db = getDb();
    db.prepare(`
      INSERT INTO discussions (id, topic, mode, status, participants_json, initiator)
      VALUES (?, ?, 'realtime', 'active', ?, ?)
    `).run(sessionId, options.topic, JSON.stringify(participants), options.initiator || 'user');

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
    prompt: string
  ): Promise<Record<string, string>> {
    const results = await Promise.allSettled(
      participants.map(async (pid) => {
        await eventBus.publish({
          type: 'discussion:provider_started', sessionId, agentId: pid, round,
        });

        const result = await agentManager.executeTask(pid, prompt, {
          systemPrompt: `Discussion R${round}. Session: ${sessionId}`,
          compact: true,
          signal: AbortSignal.timeout(30_000),
        });

        const db = getDb();
        db.prepare(`
          INSERT INTO discussion_messages (id, discussion_id, agent_id, round, message_type, content)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(createMessageId(), sessionId, pid, round, type, result.output);

        await eventBus.publish({
          type: 'discussion:provider_completed', sessionId, agentId: pid, round,
          content: result.output.slice(0, 500),
        });

        return { pid, output: result.output };
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
          signal: AbortSignal.timeout(60_000),
        });

        responses[pid] = result.output;
        accumulated.push(`[${pid}]: ${result.output.slice(0, 400)}`);

        const db = getDb();
        db.prepare(`
          INSERT INTO discussion_messages (id, discussion_id, agent_id, round, message_type, content)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(createMessageId(), sessionId, pid, round, type, result.output);

        await eventBus.publish({
          type: 'discussion:provider_completed', sessionId, agentId: pid, round,
          content: result.output.slice(0, 500),
        });
      } catch (err: any) {
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
    participants: string[],
  ): void {
    const handler = async (event: any) => {
      if (event.sessionId !== sessionId) return;
      if (event.from === agentId) return; // don't respond to self

      // Debounce — wait for other messages
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));

      const otherMessages = event.content;
      const prompt = `Discussion topic: "${topic}"\n\nLatest message from ${event.from}:\n${otherMessages}\n\nRespond with your thoughts. Be concise.`;

      try {
        const result = await agentManager.executeTask(agentId, prompt);

        await eventBus.publish({
          type: 'discussion:message', sessionId,
          from: agentId, content: result.output, round: null,
        });

        const db = getDb();
        db.prepare(`
          INSERT INTO discussion_messages (id, discussion_id, agent_id, round, message_type, content)
          VALUES (?, ?, ?, NULL, 'realtime', ?)
        `).run(createMessageId(), sessionId, agentId, result.output);

      } catch (err: any) {
        log.error({ agentId, sessionId, err: err.message }, 'Realtime response failed');
      }
    };

    eventBus.on('discussion:message', handler);
    eventBus.on('discussion:user_intervention', handler);
  }

  // ─── Internal: Select participants by mode ──────────
  private selectParticipants(mode: DiscussionMode): string[] {
    const all = agentManager.listEnabledIds();

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
      .map(([pid, content]) => {
        const truncated = content.length > maxLength 
          ? content.slice(0, maxLength) + '... (truncated)' 
          : content;
        return `### ${pid}:\n${truncated}`;
      })
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
    scores: Record<string, Record<string, number>>,
    participants: string[]
  ): number {
    if (participants.length < 2) return 1.0;

    // Phase 1: trust-weighted score sum per candidate
    const weightedScores: Record<string, number> = {};
    let totalWeight = 0;

    for (const evaluator of participants) {
      const trust = this.trustScores.get(evaluator) ?? 1.0;
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
        agreementWeight += this.trustScores.get(evaluator) ?? 1.0;
      }
    }

    return totalWeight > 0 ? agreementWeight / totalWeight : 0;
  }

  // ─── Internal: Update trust scores based on consensus ─
  private updateTrustScores(
    scores: Record<string, Record<string, number>>,
    participants: string[]
  ): void {
    if (participants.length < 2) return;

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
      const currentTrust = this.trustScores.get(pid) ?? 1.0;
      const score = meanScores[pid] ?? 5;

      if (Math.abs(score - overallMean) <= 1) {
        // Within 1 point of mean - increase trust
        this.trustScores.set(pid, Math.min(2.0, currentTrust + 0.05));
      } else {
        // Outside mean - decrease trust
        this.trustScores.set(pid, Math.max(0.1, currentTrust - 0.05));
      }
    }
  }

  // ─── Internal: Update long-term reputation (EMA α=0.1) ─
  private updateReputation(
    scores: Record<string, Record<string, number>>,
    participants: string[]
  ): void {
    for (const pid of participants) {
      let sum = 0, count = 0;
      for (const [evaluator, evalScores] of Object.entries(scores)) {
        if (evaluator === pid) continue;
        const s = evalScores[pid];
        if (typeof s === 'number') { sum += s; count++; }
      }
      if (count === 0) continue;
      const mean = sum / count;
      const current = this.reputationScores.get(pid) ?? 5.0;
      // Exponential moving average: blends long-term history with latest round
      this.reputationScores.set(pid, current * 0.9 + mean * 0.1);
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

    // Find adopted proposal (highest consensus)
    let adoptedAgent = participants[0];
    let maxVotes = 0;
    const lastRound = rounds[rounds.length - 1];
    if (lastRound?.evaluations) {
      const voteCounts: Record<string, number> = {};
      for (const evalScores of Object.values(lastRound.evaluations)) {
        let best = '';
        let bestScore = 0;
        for (const [target, score] of Object.entries(evalScores)) {
          if (score > bestScore) { bestScore = score; best = target; }
        }
        if (best) voteCounts[best] = (voteCounts[best] || 0) + 1;
      }
      for (const [agent, count] of Object.entries(voteCounts)) {
        if (count > maxVotes) { maxVotes = count; adoptedAgent = agent; }
      }
    }

    const adoptedProposal = firstRound?.responses[adoptedAgent] || 'No proposal adopted';
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
      adoptedProposal: adoptedProposal.slice(0, 2000),
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
      db.prepare(`
        UPDATE discussions SET current_round=?, updated_at=datetime('now') WHERE id=?
      `).run(round, sessionId);
    } catch (err: any) {
      log.error({ err: err.message, sessionId, round }, 'Save round failed');
    }
  }
}

export const discussionEngine = new DiscussionEngine();
