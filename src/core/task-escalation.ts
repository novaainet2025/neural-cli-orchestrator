import { decideEscalation } from './escalation-policy.js';

export interface EscalationHistoryEntry {
  fromAgent: string;
  toAgent: string;
  reason: string;
  attemptedAgents: string[];
  createdAt: string;
}

export interface EscalationMetadataPatch {
  attemptedAgents: string[];
  escalationHistory: EscalationHistoryEntry[];
}

export function appendAttemptedAgent(attemptedAgents: string[], agentId: string): string[] {
  return attemptedAgents.includes(agentId) ? attemptedAgents : [...attemptedAgents, agentId];
}

export function getAttemptedAgents(metadata: Record<string, unknown> | undefined, initialAgentId: string): string[] {
  const raw = metadata?.attemptedAgents;
  const existing = Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  return appendAttemptedAgent(existing, initialAgentId);
}

export function decideFinalEscalation(options: {
  failedAgentId: string;
  failureReason: string;
  attemptedAgents: string[];
  circuitOpenAgents: string[];
  metadata?: Record<string, unknown>;
  now?: () => string;
}): {
  action: 'escalate' | 'give-up';
  nextAgentId?: string;
  metadataPatch?: EscalationMetadataPatch;
  reason: string;
} {
  const decision = decideEscalation({
    failedAgentId: options.failedAgentId,
    failureCount: Math.max(2, options.attemptedAgents.length),
    failureReason: options.failureReason,
    attemptedAgents: options.attemptedAgents,
    circuitOpenAgents: options.circuitOpenAgents,
  });

  if (decision.action !== 'escalate' || !decision.nextAgentId) {
    return {
      action: 'give-up',
      reason: decision.reason,
    };
  }

  const attemptedAgents = appendAttemptedAgent(options.attemptedAgents, decision.nextAgentId);
  const rawHistory = options.metadata?.escalationHistory;
  const escalationHistory = Array.isArray(rawHistory)
    ? rawHistory.filter((value): value is EscalationHistoryEntry =>
      Boolean(value)
      && typeof value === 'object'
      && typeof (value as EscalationHistoryEntry).fromAgent === 'string'
      && typeof (value as EscalationHistoryEntry).toAgent === 'string'
      && typeof (value as EscalationHistoryEntry).reason === 'string'
      && Array.isArray((value as EscalationHistoryEntry).attemptedAgents)
      && typeof (value as EscalationHistoryEntry).createdAt === 'string')
    : [];

  return {
    action: 'escalate',
    nextAgentId: decision.nextAgentId,
    reason: decision.reason,
    metadataPatch: {
      attemptedAgents,
      escalationHistory: [
        ...escalationHistory,
        {
          fromAgent: options.failedAgentId,
          toAgent: decision.nextAgentId,
          reason: options.failureReason,
          attemptedAgents,
          createdAt: options.now?.() ?? new Date().toISOString(),
        },
      ],
    },
  };
}
