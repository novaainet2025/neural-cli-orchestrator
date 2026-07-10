// escalation-policy.ts
// This module decides how to handle a failed agent execution.
// It is a pure function with no external side effects.

// Import tier definitions. They are exported from '../core/tier-policy.js'.
import { BRAIN_TIER, WORKER_TIER } from "../core/tier-policy.js";

/**
 * Input describing the failure that occurred.
 */
export interface EscalationInput {
  /** Identifier of the agent that just failed */
  failedAgentId: string;
  /** Number of consecutive failures for this agent */
  failureCount: number;
  /** Human‑readable reason for the failure */
  failureReason: string;
  /** Agents that have already been tried for this request */
  attemptedAgents: string[];
  /** Agents whose circuit breaker is currently open */
  circuitOpenAgents: string[];
}

/**
 * Result of the escalation decision.
 */
export type EscalationResult = {
  action: "retry-same" | "escalate" | "give-up";
  /** Next agent to try, required when action is 'retry-same' or 'escalate' */
  nextAgentId?: string;
  reason: string;
};

/**
 * Decide what to do after a failure.
 *
 * Rules (as described in the request):
 * 1. If the failureCount is < 2 **and** the reason is transient (rate limit or timeout),
 *    return a retry of the same agent.
 * 2. Otherwise we try to *escalate*:
 *    - If the failed agent belongs to WORKER_TIER, look for another agent in the same tier
 *      that has not been attempted and whose circuit is not open.
 *    - If none are available, fall back to agents in BRAIN_TIER, preferring the ones with
 *      "lower intelligence" (the list order codex → cursor‑agent → opencode … i.e. reverse order).
 *    - If the failed agent belongs to BRAIN_TIER, look for a higher‑rank agent inside the same tier.
 * 3. If attemptedAgents already contains 4 or more agents, or if no candidate can be found,
 *    give up.
 */
export function decideEscalation(input: EscalationInput): EscalationResult {
  const { failedAgentId, failureCount, failureReason, attemptedAgents, circuitOpenAgents } = input;

  // Helper to check transient reasons
  const isTransient = (reason: string) => {
    const lowered = reason.toLowerCase();
    return lowered.includes("rate limit") || lowered.includes("timeout");
  };

  // Rule 1: quick retry
  if (failureCount < 2 && isTransient(failureReason)) {
    return {
      action: "retry-same",
      nextAgentId: failedAgentId,
      reason: "Transient failure, retrying the same agent",
    };
  }

  // Rule 3 pre‑check: too many attempts
  if (attemptedAgents.length >= 4) {
    return { action: "give-up", reason: "Maximum number of attempted agents reached" };
  }

  // Determine tier of failed agent
  const isWorker = WORKER_TIER.includes(failedAgentId);
  const isBrain = BRAIN_TIER.includes(failedAgentId);

  // Candidate selection helpers
  const filterCandidates = (candidates: readonly string[]) =>
    candidates.filter(
      (id) => !attemptedAgents.includes(id) && !circuitOpenAgents.includes(id)
    );

  // 2a. Same tier escalation for workers
  if (isWorker) {
    const sameTierCandidates = filterCandidates(WORKER_TIER);
    if (sameTierCandidates.length > 0) {
      return {
        action: "escalate",
        nextAgentId: sameTierCandidates[0], // deterministic first available
        reason: "Escalating within WORKER_TIER",
      };
    }
    // fallback to brain tier with reverse order (lower intelligence first)
    const brainCandidates = filterCandidates([...BRAIN_TIER].reverse());
    if (brainCandidates.length > 0) {
      return {
        action: "escalate",
        nextAgentId: brainCandidates[0],
        reason: "No worker available, falling back to lower‑intelligence BRAIN agents",
      };
    }
    return { action: "give-up", reason: "No eligible agents found in any tier" };
  }

  // 2b. Brain tier escalation – try higher rank within brain tier
  if (isBrain) {
    // Assume BRAIN_TIER is ordered from highest to lowest intelligence.
    const index = BRAIN_TIER.indexOf(failedAgentId);
    const higher = BRAIN_TIER.slice(0, index); // agents with higher rank
    const higherCandidates = filterCandidates(higher);
    if (higherCandidates.length > 0) {
      return {
        action: "escalate",
        nextAgentId: higherCandidates[0],
        reason: "Escalating to higher‑rank BRAIN agent",
      };
    }
    // If none higher, try lower rank within brain tier
    const lower = BRAIN_TIER.slice(index + 1);
    const lowerCandidates = filterCandidates(lower);
    if (lowerCandidates.length > 0) {
      return {
        action: "escalate",
        nextAgentId: lowerCandidates[0],
        reason: "No higher brain agent, using lower‑rank brain agent",
      };
    }
    // Finally fall back to workers (higher intelligence than brain?)
    const workerCandidates = filterCandidates(WORKER_TIER);
    if (workerCandidates.length > 0) {
      return {
        action: "escalate",
        nextAgentId: workerCandidates[0],
        reason: "No other brain agents, falling back to worker tier",
      };
    }
    return { action: "give-up", reason: "No eligible agents found in any tier" };
  }

  // If the failedAgentId does not belong to any known tier, give up.
  return { action: "give-up", reason: "Failed agent not recognized in tier definitions" };
}

/*
Usage example (for documentation purposes only, not executed in production):

import { decideEscalation, EscalationInput } from "./escalation-policy";

const input: EscalationInput = {
  failedAgentId: "codex",
  failureCount: 1,
  failureReason: "Rate limit exceeded",
  attemptedAgents: ["codex"],
  circuitOpenAgents: [],
};

const result = decideEscalation(input);
console.log(result);
*/
