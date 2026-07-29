export interface DiscussionProgressRow {
  status?: string | null;
  current_round?: number | null;
  max_rounds?: number | null;
  participants_json?: string | null;
  updated_at?: string | null;
  latest_message_at?: string | null;
  active_round_response_count?: number | null;
}

export interface DiscussionTaskProgress {
  status: string;
  progress: number;
  currentStep: string;
  lastActivityAt: string | null;
  liveness: 'working' | 'finished' | 'failed';
  discussionRound: number;
  discussionTotalRounds: number;
  discussionResponses: number;
  discussionParticipants: number;
}

export interface SingleTaskProgressInput {
  status?: string | null;
  progress?: number | null;
  liveness?: string | null;
  provider?: string | null;
  heartbeatSeq?: number | null;
}

export interface SingleTaskProgress {
  progress: number | null | undefined;
  liveness: string | null | undefined;
  currentStep?: string;
}

export const projectTerminalTaskActivity = (
  status: string | null | undefined,
  progress: number | null | undefined,
  liveness: string | null | undefined
): { progress: number | null | undefined; liveness: string | null | undefined } => {
  const normalized = (status ?? '').trim().toLowerCase();
  if (['completed', 'complete', 'done', 'success'].includes(normalized)) {
    return { progress: 100, liveness: 'finished' };
  }
  if (['failed', 'error', 'cancelled', 'canceled', 'timed_out'].includes(normalized)) {
    return { progress, liveness: 'failed' };
  }
  return { progress, liveness };
};

/**
 * Opaque CLI providers do not expose a trustworthy completion percentage while
 * they are generating a response. Surface only observed facts (provider,
 * liveness, heartbeat sequence) instead of inventing a percentage.
 */
export const projectSingleTaskProgress = (
  input: SingleTaskProgressInput
): SingleTaskProgress => {
  const status = (input.status ?? '').trim().toLowerCase();
  const terminal = projectTerminalTaskActivity(
    input.status,
    input.progress,
    input.liveness
  );
  if (['completed', 'complete', 'done', 'success'].includes(status)) {
    return { ...terminal, currentStep: '작업 완료' };
  }
  if (['failed', 'error', 'cancelled', 'canceled', 'timed_out'].includes(status)) {
    return { ...terminal, currentStep: '작업 실패' };
  }

  const active = [
    'assigned',
    'accepted',
    'running',
    'streaming',
    'in_progress',
    'in-progress',
  ].includes(status);
  if (!active) return terminal;

  const provider = input.provider?.trim() || '에이전트';
  const heartbeat = Number.isFinite(input.heartbeatSeq)
    && Number(input.heartbeatSeq) > 0
    ? ` · 생존신호 #${Math.floor(Number(input.heartbeatSeq))}`
    : '';
  const state = input.liveness === 'stalled'
    ? '응답 지연'
    : input.liveness === 'dead'
      ? '응답 중단'
      : '응답 생성 중';
  return {
    ...terminal,
    currentStep: `${provider} ${state}${heartbeat}`,
  };
};

const parseParticipantCount = (value: string | null | undefined): number => {
  if (!value) return 0;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).length
      : 0;
  } catch {
    return 0;
  }
};

export const projectDiscussionTaskProgress = (
  row: DiscussionProgressRow
): DiscussionTaskProgress => {
  const totalRounds = Math.max(1, Math.floor(row.max_rounds ?? 1));
  const completedRounds = Math.min(
    totalRounds,
    Math.max(0, Math.floor(row.current_round ?? 0))
  );
  const normalizedStatus = (row.status ?? 'active').trim().toLowerCase();
  const terminal = ['completed', 'failed', 'cancelled', 'canceled'].includes(normalizedStatus);
  const activeRound = terminal
    ? Math.max(1, completedRounds)
    : Math.min(totalRounds, completedRounds + 1);
  const participants = parseParticipantCount(row.participants_json);
  const responses = Math.max(0, Math.floor(row.active_round_response_count ?? 0));
  const responseFraction = participants > 0
    ? Math.min(1, responses / participants)
    : 0;
  const progress = normalizedStatus === 'completed'
    ? 100
    : Math.min(
        99,
        Math.max(
          1,
          Math.round(((completedRounds + responseFraction) / totalRounds) * 100)
        )
      );
  const responseLabel = participants > 0
    ? ` · 응답 ${Math.min(responses, participants)}/${participants}`
    : '';

  return {
    status: normalizedStatus === 'active' ? 'running' : normalizedStatus,
    progress,
    currentStep: terminal
      ? `토론 ${normalizedStatus}`
      : `토론 ${activeRound}/${totalRounds}${responseLabel} 수집`,
    lastActivityAt: row.latest_message_at ?? row.updated_at ?? null,
    liveness: normalizedStatus === 'active'
      ? 'working'
      : normalizedStatus === 'completed'
        ? 'finished'
        : 'failed',
    discussionRound: activeRound,
    discussionTotalRounds: totalRounds,
    discussionResponses: responses,
    discussionParticipants: participants,
  };
};
