export type RecoverableTaskStatus = 'queued' | 'assigned' | 'in_progress' | 'running' | 'streaming';

export type OrphanRecoveryDecision =
  | { action: 'dead_letter'; reason: 'no_agent' | 'poison' }
  | { action: 'requeue'; incrementRecoveryCount: boolean };

/**
 * queued는 아직 실행을 시작하지 않았으므로 재시작 실패 횟수로 계산하지 않는다.
 * 실행 중이던 작업만 실제 orphan 복구 횟수를 올리고, 그 횟수가 상한에 도달하면
 * 무한 재실행을 막기 위해 poison으로 종결한다.
 */
export function decideOrphanRecovery(input: {
  status: RecoverableTaskStatus;
  assignedTo: string | null;
  recoveryCount: number;
  maxRecoveryCount: number;
}): OrphanRecoveryDecision {
  if (!input.assignedTo) return { action: 'dead_letter', reason: 'no_agent' };
  if (input.status !== 'queued' && input.recoveryCount >= input.maxRecoveryCount) {
    return { action: 'dead_letter', reason: 'poison' };
  }
  return {
    action: 'requeue',
    incrementRecoveryCount: input.status !== 'queued',
  };
}
