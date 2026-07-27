import { closeDb, runMigrations } from '../src/storage/database.js';
import {
  WORK_EVENT_CATEGORIES,
  WORK_EVENT_OUTCOMES,
  WORK_EVENT_SEVERITIES,
  recordWorkEvent,
  type WorkEventCategory,
  type WorkEventOutcome,
  type WorkEventSeverity,
} from '../src/core/work-event-ledger.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseJsonOption(name: string, fallback: unknown): unknown {
  const value = option(name);
  if (!value) return fallback;
  return JSON.parse(value);
}

function oneOf<T extends readonly string[]>(value: string | undefined, values: T): T[number] | undefined {
  return value && values.includes(value) ? value as T[number] : undefined;
}

const eventType = option('event-type');
const title = option('title');
const source = option('source') ?? 'manual-cli';

if (!eventType || !title) {
  process.stderr.write('required: --event-type <type> --title <title>\n');
  process.exit(2);
}

try {
  runMigrations();
  const event = recordWorkEvent({
    eventKey: option('event-key'),
    source,
    sourceEventId: option('source-event-id'),
    category: oneOf(option('category'), WORK_EVENT_CATEGORIES) as WorkEventCategory | undefined,
    eventType,
    severity: oneOf(option('severity'), WORK_EVENT_SEVERITIES) as WorkEventSeverity | undefined,
    outcome: oneOf(option('outcome'), WORK_EVENT_OUTCOMES) as WorkEventOutcome | undefined,
    title,
    summary: option('summary'),
    detail: parseJsonOption('detail-json', {}),
    evidence: parseJsonOption('evidence-json', []),
    taskId: option('task-id'),
    agentId: option('agent-id'),
    sessionId: option('session-id'),
    projectPath: option('project-path') ?? process.cwd(),
    worktreePath: option('worktree-path'),
    branch: option('branch'),
    commitSha: option('commit-sha'),
    occurredAt: option('occurred-at'),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, event })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  closeDb();
}
