#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface CliArgs {
  acknowledgeCompromisedHistory: boolean;
  expectedFirstInvalidId?: string;
  actor?: string;
  reason?: string;
  incidentEvidencePath?: string;
  databasePath?: string;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run audit:begin-epoch -- \\',
    '    --acknowledge-compromised-history \\',
    '    --expected-first-invalid-id <audit-id> \\',
    '    --actor <operator-id> \\',
    '    --reason <incident-reason> \\',
    '    --incident-evidence <evidence.json> [--database-path <db>]',
    '',
    'This command never rewrites existing audit rows or hashes.',
  ].join('\n');
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = { acknowledgeCompromisedHistory: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--acknowledge-compromised-history') {
      parsed.acknowledgeCompromisedHistory = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    index += 1;
    if (arg === '--expected-first-invalid-id') parsed.expectedFirstInvalidId = value;
    else if (arg === '--actor') parsed.actor = value;
    else if (arg === '--reason') parsed.reason = value;
    else if (arg === '--incident-evidence') parsed.incidentEvidencePath = value;
    else if (arg === '--database-path') parsed.databasePath = value;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (
    !args.acknowledgeCompromisedHistory
    || !args.expectedFirstInvalidId
    || !args.actor
    || !args.reason
    || !args.incidentEvidencePath
  ) {
    throw new Error(usage());
  }
  if (args.databasePath) process.env.DATABASE_PATH = resolve(args.databasePath);

  const evidenceText = readFileSync(resolve(args.incidentEvidencePath), 'utf8');
  const evidence = JSON.parse(evidenceText) as unknown;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('Incident evidence JSON must contain an object');
  }

  const [{ beginAuditEpoch, verifyAuditIntegrity }, { closeDb, runMigrations }] = await Promise.all([
    import('../audit/merkleLog.js'),
    import('../storage/database.js'),
  ]);
  try {
    runMigrations();
    const before = verifyAuditIntegrity('history');
    const epoch = beginAuditEpoch({
      acknowledgeCompromisedHistory: true,
      expectedFirstInvalidId: args.expectedFirstInvalidId,
      actor: args.actor,
      reason: args.reason,
      incidentEvidence: evidence as Record<string, unknown>,
    });
    const after = verifyAuditIntegrity('current');
    process.stdout.write(`${JSON.stringify({ before, epoch, after }, null, 2)}\n`);
  } finally {
    closeDb();
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
