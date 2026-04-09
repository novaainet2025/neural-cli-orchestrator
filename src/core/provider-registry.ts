import { loadEnabledProviders, type ProviderConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('provider-registry');

export class ProviderRegistry {
  private providers = new Map<string, ProviderConfig>();

  async init(): Promise<void> {
    const providers = loadEnabledProviders();
    for (const p of providers) {
      this.providers.set(p.id, p);
    }
    log.info({ count: providers.length }, 'Provider Registry initialized');
  }

  get(id: string): ProviderConfig | undefined {
    return this.providers.get(id);
  }

  list(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  listEnabledIds(): string[] {
    return Array.from(this.providers.keys());
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }
}

export const providerRegistry = new ProviderRegistry();