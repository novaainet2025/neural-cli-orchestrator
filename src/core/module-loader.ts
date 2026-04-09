import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { NCOModule, NCOCore } from './types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('module-loader');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class ModuleLoader {
  private modules: Map<string, NCOModule> = new Map();
  private core: NCOCore | null = null;

  constructor() {}

  setCore(core: NCOCore) {
    this.core = core;
  }

  async loadAll(modulesDir: string): Promise<void> {
    if (!this.core) throw new Error('Core not set in ModuleLoader');

    try {
      const entries = await fs.readdir(modulesDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        
        // Try index.ts or index.js
        const indexPath = path.join(modulesDir, entry.name, 'index.ts');
        const jsPath = path.join(modulesDir, entry.name, 'index.js');
        
        let modulePath = '';
        try {
          await fs.access(indexPath);
          modulePath = indexPath;
        } catch {
          try {
            await fs.access(jsPath);
            modulePath = jsPath;
          } catch {
            continue;
          }
        }

        try {
          const moduleImport = await import(`file://${modulePath}`);
          const mod: NCOModule = moduleImport.default || moduleImport;
          
          if (!mod.name || !mod.version) {
            log.warn(`Invalid module manifest in ${entry.name}`);
            continue;
          }

          await this.register(mod);
          log.info(`Module loaded: ${mod.name} v${mod.version}`);
        } catch (err) {
          log.error({ err, module: entry.name }, 'Module failed to load');
        }
      }

      // onReady
      for (const mod of this.modules.values()) {
        try {
          await mod.onReady();
        } catch (err) {
          log.error({ err, module: mod.name }, 'Module onReady failed');
        }
      }
    } catch (err) {
      log.error({ err }, 'Failed to scan modules directory');
    }
  }

  async register(mod: NCOModule): Promise<void> {
    if (!this.core) return;

    try {
      await mod.onRegister(this.core);

      // Register routes
      if (mod.routes) {
        for (const route of mod.routes()) {
          this.core.gateway.route(route);
        }
      }

      // Register subscriptions
      if (mod.subscriptions) {
        for (const sub of mod.subscriptions()) {
          this.core.eventBus.on(sub.event, sub.handler);
        }
      }

      this.modules.set(mod.name, mod);
    } catch (err) {
      log.error({ err, module: mod.name }, 'Module registration failed');
    }
  }

  getModule<T extends NCOModule>(name: string): T | null {
    return (this.modules.get(name) as T) ?? null;
  }

  hasModule(name: string): boolean {
    return this.modules.has(name);
  }

  async shutdown(): Promise<void> {
    for (const mod of this.modules.values()) {
      try {
        await mod.onShutdown();
      } catch (err) {
        log.error({ err, module: mod.name }, 'Module shutdown failed');
      }
    }
    this.modules.clear();
  }
}

export const moduleLoader = new ModuleLoader();