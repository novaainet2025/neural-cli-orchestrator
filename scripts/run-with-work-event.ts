import { spawn } from 'child_process';
import { closeDb, runMigrations } from '../src/storage/database.js';
import { recordWorkEventSafely } from '../src/core/work-event-ledger.js';

const args = process.argv.slice(2);
const separator = args.indexOf('--');
const eventTypeIndex = args.indexOf('--event-type');
const configuredType = eventTypeIndex >= 0 ? args[eventTypeIndex + 1] : 'verification';
const command = separator >= 0 ? args[separator + 1] : undefined;
const commandArgs = separator >= 0 ? args.slice(separator + 2) : [];

if (!command || !configuredType) {
  process.stderr.write('usage: tsx scripts/run-with-work-event.ts --event-type <type> -- <command> [args...]\n');
  process.exit(2);
}

const startedAt = new Date();
const startedMs = Date.now();
const output: string[] = [];
let outputBytes = 0;
const MAX_CAPTURE_BYTES = 64 * 1024;

function capture(chunk: Buffer): void {
  if (outputBytes >= MAX_CAPTURE_BYTES) return;
  const remaining = MAX_CAPTURE_BYTES - outputBytes;
  const captured = chunk.subarray(0, remaining).toString('utf8');
  output.push(captured);
  outputBytes += Buffer.byteLength(captured);
}

const child = spawn(command, commandArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['inherit', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk: Buffer) => {
  process.stdout.write(chunk);
  capture(chunk);
});
child.stderr.on('data', (chunk: Buffer) => {
  process.stderr.write(chunk);
  capture(chunk);
});

child.on('error', (error) => {
  try {
    runMigrations();
    recordWorkEventSafely({
      source: 'recorded-command',
      category: 'error',
      eventType: `${configuredType}:spawn_error`,
      severity: 'error',
      outcome: 'failed',
      title: `${configuredType} could not start`,
      summary: error.message,
      detail: { command, args: commandArgs, cwd: process.cwd(), startedAt: startedAt.toISOString() },
      projectPath: process.cwd(),
      occurredAt: startedAt,
    });
  } catch (recordingError) {
    process.stderr.write(`[work-event] spawn failure could not be recorded: ${recordingError instanceof Error ? recordingError.message : String(recordingError)}\n`);
  } finally {
    closeDb();
    process.exitCode = 1;
  }
});

child.on('close', (code, signal) => {
  const succeeded = code === 0;
  try {
    runMigrations();
    recordWorkEventSafely({
      source: 'recorded-command',
      category: succeeded ? 'success' : 'regression',
      eventType: `${configuredType}:${succeeded ? 'passed' : 'failed'}`,
      severity: succeeded ? 'info' : 'error',
      outcome: succeeded ? 'succeeded' : 'failed',
      title: `${configuredType} ${succeeded ? 'passed' : 'failed'}`,
      summary: succeeded
        ? `${command} completed successfully`
        : `${command} exited with ${code ?? `signal ${signal}`}`,
      detail: {
        command,
        args: commandArgs,
        cwd: process.cwd(),
        exitCode: code,
        signal,
        durationMs: Date.now() - startedMs,
        output: output.join(''),
        outputTruncated: outputBytes >= MAX_CAPTURE_BYTES,
      },
      evidence: [{ command: [command, ...commandArgs].join(' '), exitCode: code, signal }],
      projectPath: process.cwd(),
      occurredAt: new Date(),
    });
  } catch (recordingError) {
    // Recording is observability, not the command's source of truth. Preserve
    // the child result even if the journal database is temporarily unavailable.
    process.stderr.write(`[work-event] command result could not be recorded: ${recordingError instanceof Error ? recordingError.message : String(recordingError)}\n`);
  } finally {
    closeDb();
    process.exitCode = code ?? 1;
  }
});
