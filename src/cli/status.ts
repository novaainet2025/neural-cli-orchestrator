// src/cli/status.ts
// Simple CLI utility to print a summary of the NCO system state.
// It fetches the list of agents, their current status, and any tasks that are currently running.

import { sharedState } from '../core/shared-state.js';
import { taskQueue } from '../core/task-queue.js';
import { createLogger } from '../utils/logger.js';
import { getDb } from '../storage/database.js';
import { fileURLToPath } from 'url';

const log = createLogger('status');

async function printAgentStates() {
  // Assuming agents are stored in Redis via SharedState
  // We don't have a direct method to list all agents, so we query the SQLite DB where agents are persisted.
  const db = getDb();
  const rows = db.prepare('SELECT id, status, currentTask FROM agents').all() as { id: string; status: string; currentTask: string | null }[];

  if (rows.length === 0) {
    console.log('No agents registered.');
    return;
  }

  console.log('Agents:');
  for (const row of rows) {
    console.log(`- ${row.id}: status=${row.status}, currentTask=${row.currentTask || 'idle'}`);
  }
}

async function printRunningTasks() {
  const metrics = await taskQueue.getMetrics();

  let totalRunning = 0;
  let totalQueued = 0;
  for (const m of metrics) {
    totalRunning += m.active;
    totalQueued += m.waiting;
  }

  console.log(`\nTasks:`);
  console.log(`- Running: ${totalRunning}`);
  console.log(`- Queued: ${totalQueued}`);
  for (const m of metrics) {
    if (m.active > 0 || m.waiting > 0) {
      console.log(`  * [${m.agentId}] active=${m.active} waiting=${m.waiting} completed=${m.completed} failed=${m.failed}`);
    }
  }
}

async function main() {
  try {
    console.log('=== NCO System Summary ===\n');
    await printAgentStates();
    await printRunningTasks();
    console.log('\n=== End of Summary ===');
  } catch (err) {
    log.error({ err }, 'Failed to retrieve system status');
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
