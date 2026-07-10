import fs from 'node:fs';
import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import Database from 'better-sqlite3';

dotenvConfig({ path: path.resolve(process.cwd(), '.env') });

const NCO_API = process.env.NCO_API_URL || 'http://localhost:6200';
const NCO_TOKEN = process.env.NCO_API_TOKEN || '';
const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const ONE_HOUR_MS = 60 * 60 * 1_000;
const NOW = Date.now();

function resolveInternalProjectDir() {
  const configured = process.env.NCO_PROJECT_DIR?.trim();
  if (configured && fs.existsSync(configured)) {
    return configured;
  }

  const cwd = process.cwd();
  return fs.existsSync(cwd) ? cwd : process.cwd();
}

function buildHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (NCO_TOKEN) {
    headers.Authorization = `Bearer ${NCO_TOKEN}`;
  }
  return headers;
}

async function postTask() {
  const response = await fetch(`${NCO_API}/api/task`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({
      ai: 'mlx',
      prompt: '검증: 팀 발사 테스트 — 1+1은?',
      metadata: {
        projectDir: resolveInternalProjectDir(),
      },
    }),
  });

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = bodyText;
  }

  if (!response.ok || !body?.taskId) {
    throw new Error(`task create failed: ${response.status} ${bodyText}`);
  }

  return body.taskId;
}

async function pollTask(taskId) {
  const startedAt = Date.now();
  const seen = [];

  while (Date.now() - startedAt <= POLL_TIMEOUT_MS) {
    const response = await fetch(`${NCO_API}/api/tasks/${taskId}/status`, {
      headers: NCO_TOKEN ? { Authorization: `Bearer ${NCO_TOKEN}` } : undefined,
    });
    const bodyText = await response.text();
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new Error(`status parse failed: ${bodyText}`);
    }

    const status = typeof body?.status === 'string' ? body.status : 'unknown';
    seen.push(status);
    if (status === 'assigned' || status === 'completed') {
      return seen;
    }
    if (status === 'failed' || status === 'cancelled' || status === 'timed_out') {
      throw new Error(`task entered terminal failure state: ${status}`);
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`task did not reach assigned/completed within 60s: ${seen.join(' -> ')}`);
}

function countInvalidProjectDirInLogFiles() {
  const logsDir = path.resolve(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) return 0;

  let count = 0;
  for (const entry of fs.readdirSync(logsDir)) {
    if (!entry.endsWith('.log')) continue;
    const filePath = path.join(logsDir, entry);
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.includes('invalid_project_dir')) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.time === 'number' && parsed.time >= NOW - ONE_HOUR_MS) {
          count += 1;
        }
      } catch {
        count += 1;
      }
    }
  }

  return count;
}

function resolveDatabasePath() {
  const candidates = [
    process.env.DATABASE_PATH,
    path.resolve(process.cwd(), 'data/nco.db'),
    path.resolve(process.cwd(), 'db/nco.db'),
  ].filter(Boolean);

  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function countInvalidProjectDirInDatabase() {
  const databasePath = resolveDatabasePath();
  if (!databasePath) return 0;

  const db = new Database(databasePath, { readonly: true });
  try {
    const logsTable = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type='table' AND name='logs'
    `).get();
    if (!logsTable) return 0;

    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM logs
      WHERE (
        message LIKE '%invalid_project_dir%'
        OR context_json LIKE '%invalid_project_dir%'
      )
        AND created_at >= datetime('now', '-1 hour')
    `).get();

    return Number(row?.count ?? 0);
  } finally {
    db.close();
  }
}

const taskId = await postTask();
const seenStatuses = await pollTask(taskId);
const invalidProjectDirCount = countInvalidProjectDirInLogFiles() + countInvalidProjectDirInDatabase();

console.log(`taskId=${taskId}`);
console.log(`statuses=${seenStatuses.join(' -> ')}`);
console.log(`invalid_project_dir_last_hour=${invalidProjectDirCount}`);

if (invalidProjectDirCount !== 0) {
  process.exit(1);
}
