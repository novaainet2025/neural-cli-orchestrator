import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../utils/config.js';

export type ScrapingEngine = 'static' | 'dynamic' | 'stealth';

export interface WebScrapingRequest {
  url: string;
  purpose: string;
  authorizationConfirmed: true;
  authorizationReference: string;
  fields: Record<string, string>;
  engine?: ScrapingEngine;
  allowedDomains?: string[];
  timeoutMs?: number;
  maxItems?: number;
  maxOutputChars?: number;
  waitSelector?: string;
  adaptive?: boolean;
  autoSave?: boolean;
  stealthAuthorization?: boolean;
}

interface AdapterErrorPayload {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export class WebScrapingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode?: number | null,
  ) {
    super(message);
    this.name = 'WebScrapingError';
  }
}

const MAX_STDOUT_BYTES = 6 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const PROCESS_TIMEOUT_PADDING_MS = 15_000;
const DEFAULT_MAX_CONCURRENT_SCRAPES = 2;
const ADAPTER_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'PLAYWRIGHT_BROWSERS_PATH',
  'XDG_CACHE_HOME',
  'NCO_SCRAPLING_DATA_DIR',
  'NCO_SCRAPLING_ADAPTIVE_TTL_DAYS',
  'NCO_SCRAPLING_ENABLE_STEALTH',
] as const;
let activeScrapes = 0;

function adapterRoot(): string {
  return resolve(env.ROOT, 'integrations/scrapling');
}

function pythonCandidates(): string[] {
  const configured = process.env.NCO_SCRAPLING_PYTHON?.trim();
  const root = adapterRoot();
  return [
    ...(configured ? [configured] : []),
    resolve(root, '.venv/bin/python'),
    resolve(root, '.venv/Scripts/python.exe'),
    'python3',
  ];
}

export function resolveScraplingPython(): string {
  for (const candidate of pythonCandidates()) {
    if (!candidate.includes('/') && !candidate.includes('\\')) return candidate;
    if (existsSync(candidate)) return candidate;
  }
  return 'python3';
}

export function buildScraplingEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PYTHONUNBUFFERED: '1' };
  for (const key of ADAPTER_ENV_ALLOWLIST) {
    const value = source[key];
    if (value) environment[key] = value;
  }
  return environment;
}

async function invokeAdapter(
  args: string[],
  input: Record<string, unknown> | null,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const python = resolveScraplingPython();
  return await new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
    const child = spawn(python, ['-m', 'nco_scrapling.cli', ...args], {
      cwd: adapterRoot(),
      env: buildScraplingEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputTooLarge = false;
    let settled = false;

    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
      settleReject(new WebScrapingError('ADAPTER_TIMEOUT', `Scrapling adapter exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        outputTooLarge = true;
        child.kill('SIGTERM');
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      stderrBytes += chunk.length;
      stderr.push(chunk.subarray(0, Math.max(0, MAX_STDERR_BYTES - (stderrBytes - chunk.length))));
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      settleReject(new WebScrapingError(
        'PYTHON_UNAVAILABLE',
        `could not launch Scrapling Python runtime: ${error.message}`,
      ));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (outputTooLarge) {
        settleReject(new WebScrapingError('OUTPUT_TOO_LARGE', 'Scrapling adapter output exceeded 6 MiB', code));
        return;
      }
      const raw = Buffer.concat(stdout).toString('utf8').trim();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        const diagnostic = Buffer.concat(stderr).toString('utf8').trim().slice(-2_000);
        settleReject(new WebScrapingError(
          'INVALID_ADAPTER_RESPONSE',
          `Scrapling adapter returned invalid JSON${diagnostic ? `: ${diagnostic}` : ''}`,
          code,
        ));
        return;
      }
      const errorPayload = parsed as unknown as AdapterErrorPayload;
      if (code !== 0 || errorPayload.ok === false) {
        settleReject(new WebScrapingError(
          errorPayload.error?.code || 'ADAPTER_FAILED',
          errorPayload.error?.message || 'Scrapling adapter failed',
          code,
        ));
        return;
      }
      settled = true;
      resolvePromise(parsed);
    });

    if (input) child.stdin.end(JSON.stringify(input));
    else child.stdin.end();
  });
}

export async function getWebScrapingCapabilities(): Promise<Record<string, unknown>> {
  return invokeAdapter(['--capabilities'], null, 10_000);
}

export async function runWebScraping(request: WebScrapingRequest): Promise<Record<string, unknown>> {
  const configured = Number(process.env.NCO_SCRAPLING_MAX_CONCURRENCY ?? DEFAULT_MAX_CONCURRENT_SCRAPES);
  const maximum = Number.isInteger(configured) && configured > 0
    ? Math.min(configured, 8)
    : DEFAULT_MAX_CONCURRENT_SCRAPES;
  if (activeScrapes >= maximum) {
    throw new WebScrapingError('ADAPTER_BUSY', `Scrapling concurrency limit reached (${maximum})`);
  }
  activeScrapes += 1;
  const timeoutMs = request.timeoutMs ?? 30_000;
  try {
    return await invokeAdapter(
      [],
      request as unknown as Record<string, unknown>,
      timeoutMs + PROCESS_TIMEOUT_PADDING_MS,
    );
  } finally {
    activeScrapes -= 1;
  }
}
