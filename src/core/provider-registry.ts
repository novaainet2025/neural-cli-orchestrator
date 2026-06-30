import { loadEnabledProviders, type ProviderConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('provider-registry');

export function normalizeProviders(providers: ProviderConfig[]): ProviderConfig[] {
  const unique = new Map<string, ProviderConfig>();

  for (const provider of providers) {
    if (unique.has(provider.id)) {
      throw new Error(`Duplicate provider id: ${provider.id}`);
    }
    unique.set(provider.id, provider);
  }

  return Array.from(unique.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id.localeCompare(b.id);
  });
}

export class ProviderRegistry {
  private providers = new Map<string, ProviderConfig>();

  async init(): Promise<void> {
    const providers = normalizeProviders(loadEnabledProviders());
    this.providers.clear();
    for (const p of providers) {
      this.providers.set(p.id, p);
    }
    log.info({ count: providers.length }, 'Provider Registry initialized');
  }

  async reload(): Promise<void> {
    await this.init();
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
