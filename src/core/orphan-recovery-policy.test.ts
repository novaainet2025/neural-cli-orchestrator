import { describe, expect, it } from 'vitest';
import {
  decideOrphanRecovery,
  isExternalInjectionGuardEnabled,
  isExternallyInjectedOrphan,
} from './orphan-recovery-policy.js';

describe('orphan recovery policy', () => {
  it('requeues a never-started queued task without consuming poison budget', () => {
    expect(decideOrphanRecovery({
      status: 'queued',
      assignedTo: 'hermes',
      recoveryCount: 99,
      maxRecoveryCount: 2,
    })).toEqual({ action: 'requeue', incrementRecoveryCount: false });
  });

  it('increments recovery budget for a task interrupted during execution', () => {
    expect(decideOrphanRecovery({
      status: 'running',
      assignedTo: 'codex',
      recoveryCount: 1,
      maxRecoveryCount: 2,
    })).toEqual({ action: 'requeue', incrementRecoveryCount: true });
  });

  it('dead-letters a repeatedly interrupted active task', () => {
    expect(decideOrphanRecovery({
      status: 'streaming',
      assignedTo: 'codex',
      recoveryCount: 2,
      maxRecoveryCount: 2,
    })).toEqual({ action: 'dead_letter', reason: 'poison' });
  });

  it('dead-letters a task that cannot be routed', () => {
    expect(decideOrphanRecovery({
      status: 'queued',
      assignedTo: null,
      recoveryCount: 0,
      maxRecoveryCount: 2,
    })).toEqual({ action: 'dead_letter', reason: 'no_agent' });
  });

  // 2026-07-27 실측 회귀: 외부 cron이 raw sqlite3로 넣은 'running' 행(task_content_generation)이
  // 부팅 orphan 복구에 채택돼 cursor-agent로 재배정 → ENOENT 실패가 team_content-planning에 계상됐다.
  it('dead-letters an externally injected row instead of requeueing it', () => {
    expect(decideOrphanRecovery({
      status: 'running',
      assignedTo: 'mlx',
      recoveryCount: 0,
      maxRecoveryCount: 2,
      externallyInjected: true,
    })).toEqual({ action: 'dead_letter', reason: 'external_injection' });
  });

  it('keeps requeueing normal team tasks when the guard flag is false', () => {
    expect(decideOrphanRecovery({
      status: 'running',
      assignedTo: 'codex',
      recoveryCount: 0,
      maxRecoveryCount: 2,
      externallyInjected: false,
    })).toEqual({ action: 'requeue', incrementRecoveryCount: true });
  });
});

describe('external injection provenance', () => {
  // 실 DB 스냅샷(2026-07-27): 주입 직후 원본 상태.
  const injected = {
    teamId: 'team_content-planning',
    metadataJson: null,
    systemPrompt: null,
    spawnedByCli: null,
    orphanRequeueCount: 0,
  };

  // Live HTTP 스냅샷(2026-07-28 09:00:01 UTC): successor team_content-strategy-2026
  // 고정 ID task_trend_collector — cron INSERT OR REPLACE 후에도 provenance 동일.
  const strategy2026Injected = {
    teamId: 'team_content-strategy-2026',
    metadataJson: null,
    systemPrompt: null,
    spawnedByCli: null,
    orphanRequeueCount: 0,
  };

  it('flags a pristine externally injected team row', () => {
    expect(isExternallyInjectedOrphan(injected)).toBe(true);
  });

  it('flags the live team_content-strategy-2026 task_trend_collector snapshot', () => {
    expect(isExternallyInjectedOrphan(strategy2026Injected)).toBe(true);
  });

  it('does not flag a row NCO created (metadata present)', () => {
    expect(isExternallyInjectedOrphan({ ...injected, metadataJson: '{"model":"gpt"}' })).toBe(false);
  });

  it('does not flag a row NCO created (system prompt present)', () => {
    expect(isExternallyInjectedOrphan({ ...injected, systemPrompt: 'you are…' })).toBe(false);
  });

  it('does not flag a CLI-spawned row', () => {
    expect(isExternallyInjectedOrphan({ ...injected, spawnedByCli: 'claude-code' })).toBe(false);
  });

  it('does not flag a non-team row (team_id null or blank)', () => {
    expect(isExternallyInjectedOrphan({ ...injected, teamId: null })).toBe(false);
    expect(isExternallyInjectedOrphan({ ...injected, teamId: '  ' })).toBe(false);
  });

  it('leaves already-requeued rows on the existing path (no retroactive change)', () => {
    expect(isExternallyInjectedOrphan({ ...injected, orphanRequeueCount: 1 })).toBe(false);
  });

  it('honours the runtime rollback toggle', () => {
    expect(isExternalInjectionGuardEnabled(undefined)).toBe(true);
    expect(isExternalInjectionGuardEnabled('on')).toBe(true);
    expect(isExternalInjectionGuardEnabled('off')).toBe(false);
    expect(isExternalInjectionGuardEnabled('0')).toBe(false);
    expect(isExternalInjectionGuardEnabled(' FALSE ')).toBe(false);
  });
});
