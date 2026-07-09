import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, resolve, basename, extname } from 'path';
import { createHash } from 'crypto';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('obsidian-cleaner');

const VAULT_DIR = resolve('obsidian_vault');
const ARCHIVE_DIR = join(VAULT_DIR, 'archive');

// 30 days in milliseconds
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface FileMeta {
  path: string;
  name: string;
  mtime: Date;
  birthtime: Date;
  size: number;
  hash: string;
  semanticKey: string;
  version: number;
}

// Extract version number from filename, e.g. _v5 -> 5, _v12 -> 12, or default to 0
function parseVersion(filename: string): number {
  const vMatch = filename.match(/_v(\d+)/i);
  if (vMatch) return parseInt(vMatch[1], 10);
  
  const cycleMatch = filename.match(/_cycle(\d+)/i);
  if (cycleMatch) return parseInt(cycleMatch[1], 10);

  if (filename.includes('_latest') || filename.includes('_v_latest') || filename.includes('_final') || filename.includes('_current')) {
    return 9999; // Assume latest/final version is high
  }

  return 0;
}

// Generate a semantic key by stripping version suffixes, latest, generated, copy etc.
function getSemanticKey(filename: string): string {
  let key = filename.replace(/\.md$/i, '');
  
  // Remove version tags and cycles
  key = key.replace(/_v\d+/gi, '');
  key = key.replace(/_cycle\d+/gi, '');
  key = key.replace(/_cycle_current/gi, '');
  key = key.replace(/_next_cycle/gi, '');
  key = key.replace(/_latest/gi, '');
  key = key.replace(/_v_latest/gi, '');
  key = key.replace(/_generated/gi, '');
  key = key.replace(/_new/gi, '');
  key = key.replace(/_updated/gi, '');
  key = key.replace(/_user_generated/gi, '');
  key = key.replace(/_user_final/gi, '');
  key = key.replace(/_user_v\d+/gi, '');
  key = key.replace(/_user/gi, '');
  key = key.replace(/_final/gi, '');
  key = key.replace(/_cycle/gi, '');
  key = key.replace(/_copy/gi, '');
  key = key.replace(/_auto_generated/gi, '');
  
  // Clean up any double underscores or trailing underscores/dashes
  key = key.replace(/__+/g, '_');
  key = key.replace(/[-_]+$/g, '');
  
  return key.toLowerCase();
}

// Recursively find all markdown files in a directory
function findMarkdownFiles(dir: string): string[] {
  let results: string[] = [];
  const list = readdirSync(dir, { withFileTypes: true });
  for (const item of list) {
    // Ignore archive directory
    if (item.isDirectory()) {
      if (item.name === 'archive' || item.name === '.git') continue;
      results = results.concat(findMarkdownFiles(join(dir, item.name)));
    } else if (item.isFile() && item.name.endsWith('.md')) {
      results.push(join(dir, item.name));
    }
  }
  return results;
}

// Ensure markdown file has standardized front-matter
function standardizeFrontMatter(filePath: string, mtime: Date, birthtime: Date) {
  const content = readFileSync(filePath, 'utf-8');
  
  // Check if it already has front-matter block
  const frontMatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
  const match = content.match(frontMatterRegex);

  let updatedContent = content;
  let parsedFrontMatter: Record<string, any> = {};
  let originalBody = content;

  if (match) {
    originalBody = content.slice(match[0].length);
    const lines = match[1].split('\n');
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const value = parts.slice(1).join(':').trim();
        parsedFrontMatter[key] = value;
      }
    }
  }

  // Standardization fallback
  const dateStr = birthtime.toISOString();
  const updateStr = mtime.toISOString();
  
  const created_at = parsedFrontMatter.created_at || dateStr;
  const updated_at = parsedFrontMatter.updated_at || updateStr;
  
  let tags: string[] = [];
  if (parsedFrontMatter.tags) {
    // Parse tags list
    // YAML list or inline array
    try {
      if (parsedFrontMatter.tags.startsWith('[')) {
        tags = JSON.parse(parsedFrontMatter.tags.replace(/'/g, '"'));
      } else {
        // Fallback or read from standard format (simple tag extract)
        tags = ['improvement'];
      }
    } catch {
      tags = ['improvement'];
    }
  } else {
    tags = ['improvement'];
    // Deduce tag from folder name
    if (filePath.includes('improvement_notes')) {
      tags.push('improvement-note');
    }
  }

  // Deduplicate tags
  tags = Array.from(new Set(tags));

  // Build standardized front-matter
  const standardizedFrontMatter = `---
created_at: ${created_at}
updated_at: ${updated_at}
tags:
${tags.map(t => `  - ${t}`).join('\n')}
---
`;

  updatedContent = standardizedFrontMatter + originalBody.trimStart();

  if (updatedContent !== content) {
    writeFileSync(filePath, updatedContent, 'utf-8');
  }
}

async function main() {
  log.info('Running Obsidian Cleaner...');
  
  if (!existsSync(VAULT_DIR)) {
    log.error(`Vault directory ${VAULT_DIR} does not exist.`);
    return;
  }

  if (!existsSync(ARCHIVE_DIR)) {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  const files = findMarkdownFiles(VAULT_DIR);
  log.info(`Found ${files.length} markdown files in Obsidian vault.`);

  const fileMetas: FileMeta[] = [];

  // 1. Gather metadata and standardize front-matter
  for (const file of files) {
    const stat = statSync(file);
    const fileContent = readFileSync(file);
    const hash = createHash('sha256').update(fileContent).digest('hex');
    const name = basename(file);
    
    // Standardize front-matter in-place
    standardizeFrontMatter(file, stat.mtime, stat.birthtime);

    fileMetas.push({
      path: file,
      name,
      mtime: stat.mtime,
      birthtime: stat.birthtime,
      size: stat.size,
      hash,
      semanticKey: getSemanticKey(name),
      version: parseVersion(name),
    });
  }

  const now = new Date();
  let archivedCount = 0;

  // 2. Archive files unused for >30 days (mtime older than 30 days)
  const activeFiles: FileMeta[] = [];
  for (const file of fileMetas) {
    const ageMs = now.getTime() - file.mtime.getTime();
    if (ageMs > THIRTY_DAYS_MS) {
      log.info(`Archiving stale file (>30 days idle): ${file.name}`);
      const dest = join(ARCHIVE_DIR, file.name);
      renameSync(file.path, dest);
      archivedCount++;
    } else {
      activeFiles.push(file);
    }
  }

  // 3. Deduplicate exact duplicate contents (hash matches)
  const hashGroups: Record<string, FileMeta[]> = {};
  for (const file of activeFiles) {
    if (!hashGroups[file.hash]) hashGroups[file.hash] = [];
    hashGroups[file.hash].push(file);
  }

  const remainingFiles: FileMeta[] = [];
  for (const hash of Object.keys(hashGroups)) {
    const group = hashGroups[hash];
    if (group.length > 1) {
      // Sort group by name length (prefer shorter name) then mtime DESC
      group.sort((a, b) => a.name.length - b.name.length || b.mtime.getTime() - a.mtime.getTime());
      const keepFile = group[0];
      remainingFiles.push(keepFile);

      for (let i = 1; i < group.length; i++) {
        const fileToArchive = group[i];
        log.info(`Archiving exact duplicate content: ${fileToArchive.name} (keeping ${keepFile.name})`);
        const dest = join(ARCHIVE_DIR, fileToArchive.name);
        if (existsSync(fileToArchive.path)) {
          renameSync(fileToArchive.path, dest);
          archivedCount++;
        }
      }
    } else {
      remainingFiles.push(group[0]);
    }
  }

  // 4. Archive older versions/copies of similar files (same semanticKey)
  const semanticGroups: Record<string, FileMeta[]> = {};
  for (const file of remainingFiles) {
    if (!semanticGroups[file.semanticKey]) semanticGroups[file.semanticKey] = [];
    semanticGroups[file.semanticKey].push(file);
  }

  for (const key of Object.keys(semanticGroups)) {
    const group = semanticGroups[key];
    if (group.length > 1) {
      // Sort by version DESC, then mtime DESC
      group.sort((a, b) => b.version - a.version || b.mtime.getTime() - a.mtime.getTime());
      const keepFile = group[0];
      
      for (let i = 1; i < group.length; i++) {
        const fileToArchive = group[i];
        log.info(`Archiving older version/version copy: ${fileToArchive.name} (keeping ${keepFile.name})`);
        const dest = join(ARCHIVE_DIR, fileToArchive.name);
        if (existsSync(fileToArchive.path)) {
          renameSync(fileToArchive.path, dest);
          archivedCount++;
        }
      }
    }
  }

  log.info(`Obsidian Cleaner finished. Archived ${archivedCount} duplicate, stale, or older version files.`);
}

main().catch(err => {
  log.error({ err: err.message }, 'Unexpected error in cleaning vault');
  process.exit(1);
});
