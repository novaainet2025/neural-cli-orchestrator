import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { getDb } from '../src/storage/database.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('obsidian-generator');

interface ImprovementNote {
  id: string;
  timestamp: string;
  category: string;
  problem: string;
  root_cause: string;
  fix: string;
  verified_at: string | null;
  agent: string;
  severity: string;
  tags: string; // JSON array string
}

async function main() {
  log.info('Running Obsidian Note Generator...');
  const db = getDb();
  
  const notesDir = resolve('obsidian_vault/improvement_notes');
  if (!existsSync(notesDir)) {
    mkdirSync(notesDir, { recursive: true });
  }

  // 1. Fetch all improvement notes from DB
  const notes = db.prepare('SELECT * FROM improvement_notes').all() as ImprovementNote[];
  log.info(`Found ${notes.length} improvement notes in database.`);

  let createdCount = 0;

  for (const note of notes) {
    const fileName = `${note.id}.md`;
    const filePath = join(notesDir, fileName);

    // If file already exists, don't overwrite it to preserve any manual additions
    if (existsSync(filePath)) {
      continue;
    }

    let parsedTags: string[] = [];
    try {
      parsedTags = JSON.parse(note.tags || '[]');
    } catch {
      parsedTags = [];
    }

    const allTags = [
      'improvement-note',
      `category/${note.category}`,
      `severity/${note.severity}`,
      `agent/${note.agent}`,
      ...parsedTags
    ];

    // Markdown template with standardized front-matter
    const content = `---
created_at: ${note.timestamp}
updated_at: ${note.timestamp}
tags:
${allTags.map(t => `  - ${t}`).join('\n')}
---
# Improvement Note: ${note.id}

- **Category**: ${note.category}
- **Severity**: ${note.severity}
- **Agent**: ${note.agent}
- **Timestamp**: ${note.timestamp}
- **Verified At**: ${note.verified_at || 'Unverified'}

## Problem
${note.problem}

## Root Cause
${note.root_cause || 'No root cause specified.'}

## Fix Action
${note.fix || 'No fix action specified.'}
`;

    writeFileSync(filePath, content, 'utf-8');
    log.info(`Generated new note: ${fileName}`);
    createdCount++;
  }

  log.info(`Obsidian Note Generator finished. Created ${createdCount} new notes.`);
}

main().catch(err => {
  log.error({ err: err.message }, 'Unexpected error in note generation');
  process.exit(1);
});
