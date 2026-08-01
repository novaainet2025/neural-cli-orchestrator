import type {
  ProviderAvailability,
  ProviderAvailabilitySnapshot,
} from '../security/circuit-breaker-registry.js';

export interface ProviderHealthIssue {
  id: string;
  status: ProviderAvailability | 'unknown';
  reason: string | null;
  cooldownUntil: string | null;
}

export interface ProviderHealthSummary {
  /** Admission state from the persistent circuit breaker; this is not a live provider probe. */
  basis: 'circuit-breaker-admission';
  liveProbe: false;
  configured: number;
  available: number;
  probing: string[];
  unavailable: ProviderHealthIssue[];
}

export function summarizeProviderAvailability(
  providerIds: string[],
  getAvailability: (providerId: string) => ProviderAvailabilitySnapshot,
): ProviderHealthSummary {
  const probing: string[] = [];
  const unavailable: ProviderHealthIssue[] = [];
  let available = 0;

  for (const id of providerIds) {
    try {
      const snapshot = getAvailability(id);
      if (snapshot.status === 'available') {
        available += 1;
        continue;
      }
      if (snapshot.status === 'probe') probing.push(id);
      unavailable.push({
        id,
        status: snapshot.status,
        reason: snapshot.reason,
        cooldownUntil: snapshot.cooldownUntil,
      });
    } catch {
      unavailable.push({
        id,
        status: 'unknown',
        reason: 'availability-check-failed',
        cooldownUntil: null,
      });
    }
  }

  return {
    basis: 'circuit-breaker-admission',
    liveProbe: false,
    configured: providerIds.length,
    available,
    probing,
    unavailable,
  };
}
