import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../utils/config.js';
import {
  TaskQueueManager,
  selectFailoverProvider,
  type TaskExecutionResult,
} from './task-queue.js';

function provider(
  id: string,
  options: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id,
    name: id,
    enabled: true,
    type: 'cli',
    role: 'engineer',
    score: 50,
    model: null,
    command: 'provider-cli',
    args: [],
    env: {},
    concurrency: 1,
    rateLimitRpm: 60,
    cost: 'paid',
    capabilities: ['code'],
    permissions: {},
    persona: { systemPrompt: '', tone: 'direct', style: 'concise' },
    healthCheck: {},
    ...options,
  };
}

const managers: TaskQueueManager[] = [];

function manager(): TaskQueueManager {
  const instance = new TaskQueueManager();
  managers.push(instance);
  return instance;
}

afterEach(async () => {
  for (const instance of managers.splice(0)) {
    await instance.close({ forceWorkers: true });
  }
  vi.restoreAllMocks();
});

describe('TaskQueueManager provider snapshot reconciliation', () => {
  it('applies arbitrary provider additions, concurrency updates, and removals after init', async () => {
    const instance = manager();
    const initial = provider('acme-alpha');
    await instance.init([initial]);

    await instance.reconcileProviders([
      provider('acme-alpha', { concurrency: 3 }),
      provider('contoso-beta', { concurrency: 2, cost: 'free' }),
    ]);

    expect(await instance.getMetrics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'acme-alpha', concurrency: 3 }),
      expect.objectContaining({ agentId: 'contoso-beta', concurrency: 2 }),
    ]));

    await instance.reconcileProviders([provider('contoso-beta', { concurrency: 4 })]);

    const internal = instance as any;
    expect(internal.providerConfigs.has('acme-alpha')).toBe(false);
    expect(internal.agents.get('acme-alpha').accepting).toBe(false);
    expect(internal.agents.get('contoso-beta').accepting).toBe(true);
    expect((await instance.getMetrics('contoso-beta'))[0]).toMatchObject({ concurrency: 4 });
  });

  it('blocks new admission to a removed or never-registered provider', async () => {
    const instance = manager();
    await instance.reconcileProviders([provider('dynamic-one')]);

    const internal = instance as any;
    internal.enqueueSemaphore = vi.fn().mockResolvedValue({ success: true, output: 'ok' });
    await instance.reconcileProviders([provider('dynamic-two')]);

    await expect(internal.runEnqueue({
      taskId: 'removed-provider-task',
      agentId: 'dynamic-one',
      prompt: 'test',
    })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('provider_unavailable: dynamic-one'),
    });
    await expect(internal.runEnqueue({
      taskId: 'unknown-provider-task',
      agentId: 'never-seen',
      prompt: 'test',
    })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('provider_unavailable: never-seen'),
    });
    expect(internal.enqueueSemaphore).not.toHaveBeenCalled();
  });

  it('does not abort an active execution when its provider is removed', async () => {
    const instance = manager();
    await instance.reconcileProviders([provider('draining-provider')]);

    let releaseExecution!: (result: TaskExecutionResult) => void;
    let observedSignal!: AbortSignal;
    const started = new Promise<void>(resolve => {
      instance.setExecutor(async (_task, signal) => {
        observedSignal = signal;
        resolve();
        return new Promise<TaskExecutionResult>(finish => {
          releaseExecution = finish;
        });
      });
    });

    const internal = instance as any;
    internal.startRuntime = vi.fn();
    internal.getOrCaptureVerifierBaseline = vi.fn().mockResolvedValue(null);
    const execution = internal.runEnqueue({
      taskId: 'in-flight-task',
      agentId: 'draining-provider',
      prompt: 'test',
    });
    await started;

    await instance.reconcileProviders([]);
    expect(observedSignal.aborted).toBe(false);
    expect(internal.agents.get('draining-provider').active).toBe(1);

    releaseExecution({ success: true, output: 'done: drained' });
    await expect(execution).resolves.toMatchObject({ success: true, output: 'done: drained' });
    expect(observedSignal.aborted).toBe(false);
    expect(internal.agents.get('draining-provider').active).toBe(0);
  });

  it('serializes concurrent snapshots and leaves the newest snapshot authoritative', async () => {
    const instance = manager();
    await Promise.all([
      instance.reconcileProviders([provider('snapshot-first')]),
      instance.reconcileProviders([provider('snapshot-second')]),
    ]);

    const internal = instance as any;
    expect([...internal.providerConfigs.keys()]).toEqual(['snapshot-second']);
    expect(internal.agents.get('snapshot-first').accepting).toBe(false);
    expect(internal.agents.get('snapshot-second').accepting).toBe(true);
  });
});

describe('selectFailoverProvider', () => {
  it('selects only from the supplied current snapshot with no provider ID assumptions', () => {
    const currentSnapshot = [
      provider('vendor-current'),
      provider('vendor-paid'),
      provider('vendor-free', { cost: 'free' }),
    ];

    expect(selectFailoverProvider(
      currentSnapshot,
      new Set(),
      'vendor-current',
      'vendor-original',
    )).toBe('vendor-free');
    expect(selectFailoverProvider(
      currentSnapshot.filter(item => item.id !== 'vendor-free'),
      new Set(['vendor-paid']),
      'vendor-current',
      'vendor-original',
    )).toBeNull();
  });
});
