import { describe, expect, it } from 'vitest';

import {
  projectDiscussionTaskProgress,
  projectTerminalTaskActivity,
} from './discussion-progress.js';

describe('discussion task progress projection', () => {
  it('exposes live round and response collection instead of an inert assigned state', () => {
    expect(projectDiscussionTaskProgress({
      status: 'active',
      current_round: 1,
      max_rounds: 3,
      participants_json: JSON.stringify(['opencode', 'agy', 'cursor-agent']),
      updated_at: '2026-07-28 19:53:49',
      latest_message_at: '2026-07-28 19:54:15',
      active_round_response_count: 1,
    })).toEqual({
      status: 'running',
      progress: 44,
      currentStep: '토론 2/3 · 응답 1/3 수집',
      lastActivityAt: '2026-07-28 19:54:15',
      liveness: 'working',
      discussionRound: 2,
      discussionTotalRounds: 3,
      discussionResponses: 1,
      discussionParticipants: 3,
    });
  });

  it('uses the discussion timestamp when no provider response exists yet', () => {
    const projected = projectDiscussionTaskProgress({
      status: 'active',
      current_round: 0,
      max_rounds: 3,
      participants_json: 'not-json',
      updated_at: '2026-07-28 19:50:49',
    });

    expect(projected.currentStep).toBe('토론 1/3 수집');
    expect(projected.progress).toBe(1);
    expect(projected.lastActivityAt).toBe('2026-07-28 19:50:49');
  });

  it('projects terminal discussion state without exceeding 100 percent', () => {
    expect(projectDiscussionTaskProgress({
      status: 'completed',
      current_round: 3,
      max_rounds: 3,
      participants_json: JSON.stringify(['agy']),
      active_round_response_count: 4,
    })).toMatchObject({
      status: 'completed',
      progress: 100,
      currentStep: '토론 completed',
      liveness: 'finished',
      discussionResponses: 4,
      discussionParticipants: 1,
    });
  });

  it('normalizes terminal single-agent task progress and liveness', () => {
    expect(projectTerminalTaskActivity('completed', 0, 'dead')).toEqual({
      progress: 100,
      liveness: 'finished',
    });
    expect(projectTerminalTaskActivity('failed', 40, 'dead')).toEqual({
      progress: 40,
      liveness: 'failed',
    });
    expect(projectTerminalTaskActivity('running', 40, 'working')).toEqual({
      progress: 40,
      liveness: 'working',
    });
  });
});
