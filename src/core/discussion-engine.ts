import { eventBus } from './event-bus.js';
import { sharedState } from './shared-state.js';
import { agentManager } from '../agent/agent-manager.js';
import { getDb } from '../storage/database.js';
import { createSessionId, createMessageId } from '../utils/id.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('discussion-engine');

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

// ─── Discussion Engine ────────────────────────────────
class DiscussionEngine {

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
    const sessionId = options.sessionId || createSessionId();
    const startTime = Date.now();
    const maxRounds = options.maxRounds || 3;
    const threshold = options.consensusThreshold || 0.8;
    const participants = options.providers || this.selectParticipants(options.mode);
    const initiator = options.initiator || 'claude-code';

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

    // ─── Round 2+: 상호 평가 ──────────────────────
    for (let round = 2; round <= maxRounds + 1; round++) {
      await eventBus.publish({
        type: 'discussion:round_started', sessionId, round, totalRounds: maxRounds + 1,
      });

      // Build evaluation prompt with all previous proposals
      const allProposals = this.formatProposals(proposals);
      const evalPrompt = round === 2
        ? `다른 AI들의 제안을 평가하세요:\n\n${allProposals}\n\n각 제안의 장점/단점을 분석하고 1-10점으로 평가하세요. 가장 좋은 제안을 선택하고 이유를 설명하세요.`
        : `이전 평가를 기반으로 쟁점에 대해 집중 토론하세요:\n\n${allProposals}\n\n합의에 도달할 수 있도록 타협안을 제시하세요.`;

      const evaluations = await this.collectResponses(sessionId, round, 'evaluation', participants, evalPrompt);

      // Calculate consensus
      const scores = this.extractScores(evaluations, participants);
      consensusRate = this.calculateConsensus(scores, participants);

      rounds.push({ round, responses: evaluations, evaluations: scores, consensusRate });
      this.saveRound(sessionId, round, 'evaluation', evaluations, scores, consensusRate);

      await eventBus.publish({
        type: 'discussion:round_completed', sessionId, round, consensusRate,
      });

      log.info({ sessionId, round, consensusRate }, 'Round completed');

      // Check consensus
      if (consensusRate >= threshold) {
        await eventBus.publish({
          type: 'discussion:consensus_reached', sessionId, rate: consensusRate,
        });
        break;
      }
    }

    // ─── Hive/Commander 합성 단계: Commander가 전체 결과를 통합 ───
    if (options.mode === 'hive' || options.mode === 'commander') {
      try {
        const allProposals = this.formatProposals(rounds[0]?.responses || {});
        const synthPrompt = `You are the Commander. Synthesize these ${participants.length} AI responses into one final consolidated answer:\n\n${allProposals}\n\nProvide the single best answer.`;
        const synthResponse = await agentManager.executeTask('claude-code', synthPrompt, {
          signal: AbortSignal.timeout(90_000), // hard 90s cap on synthesis
        });
        if (synthResponse.success && synthResponse.output) {
          rounds.push({ round: rounds.length + 1, responses: { 'commander-synthesis': synthResponse.output }, consensusRate: 1 });
        }
      } catch { /* Commander synthesis optional */ }
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
          systemPrompt: `You are participating in a team discussion (round ${round}). Session: ${sessionId}`,
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
        log.warn({ reason: r.reason }, 'Agent failed in discussion');
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

  // ─── Internal: Format proposals for evaluation ──────
  private formatProposals(proposals: Record<string, string>): string {
    return Object.entries(proposals)
      .map(([pid, content]) => `### ${pid}의 제안:\n${content}`)
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
      for (const target of participants) {
        if (target === evaluator) continue;
        // Simple score extraction: look for "N/10" or "N점" patterns
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

  // ─── Internal: Calculate consensus rate ─────────────
  private calculateConsensus(
    scores: Record<string, Record<string, number>>,
    participants: string[]
  ): number {
    if (participants.length < 2) return 1.0;

    // Get agent weights from config
    const weights: Record<string, number> = {};
    for (const pid of participants) {
      const provider = agentManager.getProvider(pid);
      weights[pid] = provider?.score || 50;
    }

    // Calculate weighted average agreement
    // Agreement = how much evaluators agree on which proposal is best
    let totalWeightedAgreement = 0;
    let totalWeight = 0;

    // Find the top-rated proposal for each evaluator
    const topChoices: Record<string, string> = {};
    for (const [evaluator, evalScores] of Object.entries(scores)) {
      let maxScore = 0;
      let topChoice = '';
      for (const [target, score] of Object.entries(evalScores)) {
        if (score > maxScore) {
          maxScore = score;
          topChoice = target;
        }
      }
      topChoices[evaluator] = topChoice;
    }

    // Count agreement with majority
    const choiceCounts: Record<string, number> = {};
    for (const choice of Object.values(topChoices)) {
      choiceCounts[choice] = (choiceCounts[choice] || 0) + 1;
    }

    const majority = Object.entries(choiceCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';

    for (const [evaluator, choice] of Object.entries(topChoices)) {
      const weight = weights[evaluator] || 50;
      totalWeight += weight;
      if (choice === majority) {
        totalWeightedAgreement += weight;
      }
    }

    return totalWeight > 0 ? totalWeightedAgreement / totalWeight : 0;
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
