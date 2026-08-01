import { describe, expect, it } from 'vitest';
import {
  evaluateProviderReadiness,
  type ProviderReadinessInput,
} from './provider-readiness.js';

const NOW = new Date('2026-08-01T06:00:00.000Z');

function readyInput(overrides: Partial<ProviderReadinessInput> = {}): ProviderReadinessInput {
  return {
    providerId: 'codex',
    registration: { registered: true },
    runtimeLoaded: { loaded: true },
    heartbeat: { alive: true, observedAt: '2026-08-01T05:59:55.000Z' },
    admission: { available: true },
    queueCapacity: { available: true, active: 0, concurrency: 2 },
    inferenceEvidence: { success: true, observedAt: '2026-08-01T05:59:50.000Z' },
    ...overrides,
  };
}

describe('evaluateProviderReadiness', () => {
  it('requires every admission dimension and reports fresh inference evidence separately', () => {
    const result = evaluateProviderReadiness(readyInput(), { now: NOW });

    expect(result.readyForNewWork).toBe(true);
    expect(result.inferenceVerified).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.verificationBlockers).toEqual([]);
    expect(Object.values(result.dimensions).every(dimension => dimension.ready)).toBe(true);
    expect(result.dimensions.inferenceEvidence).toMatchObject({
      status: 'ready',
      basis: 'successful-inference-receipt',
      observedAt: '2026-08-01T05:59:50.000Z',
    });
  });

  it('allows only missing inference evidence to bootstrap admission', () => {
    const result = evaluateProviderReadiness(readyInput({ inferenceEvidence: undefined }), {
      now: NOW,
      inferenceEvidenceMaxAgeMs: 60_000,
    });

    expect(result.readyForNewWork).toBe(true);
    expect(result.inferenceVerified).toBe(false);
    expect(result.blockers).toEqual([]);
    expect(result.verificationBlockers).toEqual(['inferenceEvidence']);
    expect(result.dimensions.inferenceEvidence).toMatchObject({
      status: 'not-ready',
      reason: 'inference-evidence-missing',
    });
  });

  it.each([
    [{ success: false, observedAt: '2026-08-01T05:59:50.000Z' }, 'last-inference-failed'],
    [{ success: true, observedAt: 'not-a-date' }, 'inference-evidence-invalid'],
    [{ success: true, observedAt: '2026-08-01T06:01:00.000Z' }, 'inference-evidence-in-future'],
    [{ success: true, observedAt: '2026-08-01T05:00:00.000Z' }, 'inference-evidence-stale'],
  ] as const)('fails admission closed for explicit failed/invalid/stale evidence: %s', (evidence, reason) => {
    const result = evaluateProviderReadiness(readyInput({ inferenceEvidence: evidence }), {
      now: NOW,
      inferenceEvidenceMaxAgeMs: 60_000,
    });

    expect(result.readyForNewWork).toBe(false);
    expect(result.inferenceVerified).toBe(false);
    expect(result.blockers).toEqual(['inferenceEvidence']);
    expect(result.verificationBlockers).toContain('inferenceEvidence');
    expect(result.dimensions.inferenceEvidence).toMatchObject({ status: 'not-ready', reason });
  });

  it('keeps queue exhaustion separate from registration and admission', () => {
    const result = evaluateProviderReadiness(readyInput({
      queueCapacity: { available: true, active: 2, concurrency: 2 },
    }), { now: NOW });

    expect(result.readyForNewWork).toBe(false);
    expect(result.blockers).toEqual(['queueCapacity']);
    expect(result.dimensions.registration.status).toBe('ready');
    expect(result.dimensions.admission.status).toBe('ready');
    expect(result.dimensions.queueCapacity.reason).toBe('queue-capacity-exhausted');
  });

  it('treats unknown observations as blockers instead of optimistic health', () => {
    const result = evaluateProviderReadiness(readyInput({
      runtimeLoaded: { loaded: null },
      heartbeat: { alive: null },
      admission: { available: null },
    }), { now: NOW });

    expect(result.readyForNewWork).toBe(false);
    expect(result.blockers).toEqual(['runtimeLoaded', 'heartbeat', 'admission']);
    expect(result.dimensions.runtimeLoaded.status).toBe('unknown');
    expect(result.dimensions.heartbeat.status).toBe('unknown');
    expect(result.dimensions.admission.status).toBe('unknown');
  });

  it('never projects internal command, args, environment or persona data', () => {
    const unsafe = {
      ...readyInput(),
      command: 'must-not-leak',
      args: ['--secret'],
      env: { SECRET: 'must-not-leak' },
      persona: { systemPrompt: 'must-not-leak' },
    } as ProviderReadinessInput;
    const serialized = JSON.stringify(evaluateProviderReadiness(unsafe, { now: NOW }));

    expect(serialized).not.toContain('must-not-leak');
    expect(serialized).not.toContain('command');
    expect(serialized).not.toContain('args');
    expect(serialized).not.toContain('persona');
    expect(serialized).not.toContain('SECRET');
  });
});
