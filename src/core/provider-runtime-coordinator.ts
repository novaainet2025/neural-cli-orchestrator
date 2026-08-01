import { agentManager } from '../agent/agent-manager.js';
import { loadProviders, type ProviderConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { eventBus } from './event-bus.js';
import {
  setDefaultProviderAssignmentRegistryView,
  type ProviderAssignmentRegistryView,
} from './provider-assignment-runtime.js';
import { commitRegistryView } from './provider-registry.js';
import {
  ProviderRegistrySnapshotStore,
  type ProviderRegistryRefreshResult,
  type ProviderRegistrySnapshot,
} from './provider-registry-snapshot.js';
import { sharedState } from './shared-state.js';
import { taskQueue } from './task-queue.js';
import { commitModelRoutingRegistryRevision } from './model-router.js';

const log = createLogger('provider-runtime-coordinator');

/**
 * One process-wide transaction boundary for the PC-effective provider roster.
 * Config is validated once; every admission/routing/assignment consumer is
 * reconciled before the revision is exposed to clients.
 */
export class ProviderRuntimeCoordinator {
  private initialized = false;
  private readonly store = new ProviderRegistrySnapshotStore({
    loadProviders,
    listRuntimeProviderIds: () => agentManager.listEnabledIds(),
    reconcileRuntime: view => this.reconcileRuntime(view),
    publish: event => eventBus.publish(event),
    onPollError: error => {
      log.error({
        err: error instanceof Error ? error.message : String(error),
        activeRevision: this.store.getSnapshot()?.revision ?? null,
      }, 'Provider registry refresh rejected; retaining last-known-good revision');
    },
  });

  async init(): Promise<ProviderRegistryRefreshResult> {
    if (this.initialized) {
      const snapshot = this.store.getSnapshot();
      if (!snapshot) throw new Error('provider registry coordinator initialized without snapshot');
      return { changed: false, snapshot, changes: [] };
    }

    setDefaultProviderAssignmentRegistryView(() => this.requireAssignmentView());
    const result = await this.store.refresh();
    this.store.start();
    this.initialized = true;
    log.info({
      revision: result.snapshot.revision,
      providers: result.snapshot.providers.length,
    }, 'Provider Registry v2 committed');
    return result;
  }

  refresh(): Promise<ProviderRegistryRefreshResult> {
    return this.store.refresh();
  }

  getSnapshot(): ProviderRegistrySnapshot | null {
    return this.store.getSnapshot();
  }

  getAssignmentView(): ProviderAssignmentRegistryView | null {
    const view = this.store.getRuntimeView();
    return view ? { revision: view.revision, providers: view.providers } : null;
  }

  stop(): void {
    this.store.stop();
    this.initialized = false;
  }

  private requireAssignmentView(): ProviderAssignmentRegistryView {
    const view = this.getAssignmentView();
    if (!view) throw new Error('provider registry has no committed runtime view');
    return view;
  }

  private async reconcileRuntime(view: { revision: string; providers: readonly ProviderConfig[] }): Promise<void> {
    const providers = view.providers;
    const previousView = this.store.getRuntimeView();
    const previous = previousView?.providers ?? agentManager.listProviders();
    try {
      await agentManager.reloadProviders(providers, view.revision);
      await taskQueue.reconcileProviders(providers);
      await sharedState.reconcileProviders(providers);
      commitRegistryView(providers);
      commitModelRoutingRegistryRevision(view.revision);
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const rollback of [
        () => agentManager.reloadProviders(previous, previousView?.revision ?? null),
        () => taskQueue.reconcileProviders(previous),
        () => sharedState.reconcileProviders(previous),
      ]) {
        try {
          await rollback();
        } catch (rollbackError) {
          rollbackErrors.push(
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          );
        }
      }
      commitRegistryView(previous);
      commitModelRoutingRegistryRevision(previousView?.revision ?? null);
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors.map(message => new Error(message))],
          'provider registry reconciliation and rollback failed',
        );
      }
      throw error;
    }
  }
}

export const providerRuntimeCoordinator = new ProviderRuntimeCoordinator();
