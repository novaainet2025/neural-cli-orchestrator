#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderConfig } from '../utils/config.js';

export interface ProviderPreflightSummary {
  valid: true;
  providerCount: number;
  enabledProviderCount: number;
  modelCount: number;
  providers: Array<{
    id: string;
    enabled: boolean;
    model: string | null;
    modelCount: number;
  }>;
}

type ProviderLoader = () => readonly ProviderConfig[] | Promise<readonly ProviderConfig[]>;

/**
 * Produce a secret-free receipt after the runtime catalog has been validated.
 * Validation itself deliberately stays in loadProviders(), the same path used
 * during backend boot, so this command cannot drift into a second schema.
 */
export function summarizeProviderCatalog(
  providers: readonly ProviderConfig[],
): ProviderPreflightSummary {
  if (providers.length === 0) {
    throw new Error('[provider-preflight] provider catalog is empty');
  }

  return {
    valid: true,
    providerCount: providers.length,
    enabledProviderCount: providers.filter(provider => provider.enabled).length,
    modelCount: providers.reduce(
      (count, provider) => count + (provider.models?.length ?? (provider.model ? 1 : 0)),
      0,
    ),
    providers: providers.map(provider => ({
      id: provider.id,
      enabled: provider.enabled,
      model: provider.model,
      modelCount: provider.models?.length ?? (provider.model ? 1 : 0),
    })),
  };
}

export async function runProviderPreflight(
  loader?: ProviderLoader,
): Promise<ProviderPreflightSummary> {
  const effectiveLoader = loader ?? (async () => {
    const { loadProviders } = await import('../utils/config.js');
    return loadProviders();
  });
  return summarizeProviderCatalog(await effectiveLoader());
}

async function main(): Promise<void> {
  const summary = await runProviderPreflight();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function canonicalPath(path: string): string {
  const absolutePath = resolve(path);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

const invokedPath = process.argv[1] ? canonicalPath(process.argv[1]) : '';
const modulePath = canonicalPath(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
