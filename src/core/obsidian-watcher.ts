import { watch, FSWatcher } from 'chokidar';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { env } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { knowledgeBase } from './knowledge-base.js';

const log = createLogger('obsidian-watcher');

export class ObsidianWatcher {
  private watcher: FSWatcher | null = null;

  async start(): Promise<void> {
    const vaultPath = env.OBSIDIAN_VAULT_PATH;
    if (!vaultPath) {
      log.warn('OBSIDIAN_VAULT_PATH not set, skipping Obsidian watcher');
      return;
    }

    const absolutePath = resolve(env.ROOT, vaultPath);
    log.info({ vaultPath: absolutePath }, 'Starting Obsidian watcher');

    // Watch for .md files in the vault
    this.watcher = watch(`${absolutePath}/**/*.md`, {
      ignoreInitial: false,
      persistent: true,
      usePolling: process.platform === 'win32', // More reliable on some systems
    });

    this.watcher.on('add', (path) => this.handleFile(path));
    this.watcher.on('change', (path) => this.handleFile(path));
    
    this.watcher.on('error', (error) => {
      log.error({ error }, 'Watcher error');
    });
  }

  private async handleFile(filePath: string): Promise<void> {
    try {
      const content = await readFile(filePath, 'utf-8');
      await knowledgeBase.indexObsidianFile(filePath, content);
      log.debug({ filePath }, 'Obsidian file indexed');
    } catch (error) {
      log.error({ error, filePath }, 'Failed to index Obsidian file');
    }
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      log.info('Obsidian watcher stopped');
    }
  }
}

export const obsidianWatcher = new ObsidianWatcher();
