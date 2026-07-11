import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig({ path: path.resolve(process.cwd(), '.env') });

const NCO_API = process.env.NCO_API_URL || 'http://localhost:6200';
const NCO_TOKEN = process.env.NCO_API_TOKEN || '';
const PM2_LOG_PATH = process.env.NCO_PM2_LOG_PATH?.trim() || null;
const PM2_LOG_DIR = path.join(os.homedir(), '.pm2', 'logs');
const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const ONE_HOUR_MS = 60 * 60 * 1_000;

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

function resolvePm2LogPaths() {
  if (PM2_LOG_PATH) {
    return fs.existsSync(PM2_LOG_PATH) ? [PM2_LOG_PATH] : [];
  }

  if (!fs.existsSync(PM2_LOG_DIR)) return [];

  return fs.readdirSync(PM2_LOG_DIR)
    .filter(entry => /^nco-backend-out(?:-\d+)?\.log$/.test(entry))
    .map(entry => path.join(PM2_LOG_DIR, entry))
    .filter(filePath => fs.existsSync(filePath))
    .sort();
}

async function countInvalidProjectDirInPm2Log(logPaths) {
  if (logPaths.length === 0) return 0;

  const cutoff = Date.now() - ONE_HOUR_MS;
  let count = 0;
  for (const logPath of logPaths) {
    const reader = readline.createInterface({
      input: fs.createReadStream(logPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of reader) {
      if (!line.includes('invalid_project_dir')) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.time === 'number' && parsed.time >= cutoff) {
          count += 1;
        }
      } catch {
        // PM2 backend log is JSONL in practice; ignore unparseable legacy lines.
      }
    }
  }

  return count;
}

const pm2LogPaths = resolvePm2LogPaths();
const invalidProjectDirBefore = await countInvalidProjectDirInPm2Log(pm2LogPaths);

let taskId = 'unknown';
let seenStatuses = [];
let apiVerification = 'unverified';

try {
  taskId = await postTask();
  seenStatuses = await pollTask(taskId);
  apiVerification = 'verified';
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  seenStatuses = [`unverified:${message.replace(/\s+/g, ' ').trim()}`];
}

const invalidProjectDirAfter = await countInvalidProjectDirInPm2Log(pm2LogPaths);
const invalidProjectDirDelta = invalidProjectDirAfter - invalidProjectDirBefore;

console.log(`taskId=${taskId}`);
console.log(`statuses=${seenStatuses.join(' -> ')}`);
console.log(`api_verification=${apiVerification}`);
console.log(`pm2_log_files=${pm2LogPaths.length}`);
console.log(`invalid_project_dir_last_hour_before=${invalidProjectDirBefore}`);
console.log(`invalid_project_dir_last_hour_after=${invalidProjectDirAfter}`);
console.log(`invalid_project_dir_last_hour_delta=${invalidProjectDirDelta}`);

if (invalidProjectDirDelta > 0) {
  process.exit(1);
}
